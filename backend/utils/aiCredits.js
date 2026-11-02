const User = require('../models/User');

const INSUFFICIENT_MESSAGE = 'Insufficient AI credits';
const PASTE_CREDIT_COST = 1;
const PLACES_CREDIT_COST = 0.5;
const SUGGEST_CREDIT_COST = 1;
const COMMAND_CREDIT_COST = 1;

// The balance is checked before a server-key model call, so a zero balance
// never spends that key. Paste deducts 1 credit after usable model JSON.
// A Places suggest deducts 0.5 before the cache lookup. A hit still skips
// Google. The suggest summary still reserves 1 credit immediately before the
// summary and puts that same split back when the summary does not succeed.
// A plan command deducts 1 credit after a usable proposal. A user key costs
// nothing for those model calls.
// Monthly credits are replaced on a tier subscribe or renewal. Purchased
// credits stay. A call spends monthly credits first.

function roundCredits(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function creditNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return roundCredits(value);
}

function totalOf(split) {
  return roundCredits(split.monthly + split.purchased);
}

// A document that only has aiCredits still spends that number as monthly.
function splitFromUser(user) {
  const monthly = creditNumber(user && user.monthlyCredits);
  const purchased = creditNumber(user && user.purchasedCredits);
  if (monthly === 0 && purchased === 0) {
    const legacy = creditNumber(user && user.aiCredits);
    if (legacy > 0) return { monthly: legacy, purchased: 0 };
  }
  return { monthly, purchased };
}

function bucketFilter(id, user) {
  const filter = { _id: id };
  if (user.monthlyCredits == null) filter.monthlyCredits = { $exists: false };
  else filter.monthlyCredits = user.monthlyCredits;
  if (user.purchasedCredits == null) filter.purchasedCredits = { $exists: false };
  else filter.purchasedCredits = user.purchasedCredits;
  const monthly = creditNumber(user.monthlyCredits);
  const purchased = creditNumber(user.purchasedCredits);
  if (monthly === 0 && purchased === 0) {
    if (user.aiCredits == null) filter.aiCredits = { $exists: false };
    else filter.aiCredits = user.aiCredits;
  }
  return filter;
}

function usesServerKey(aiClient) {
  if (!aiClient || aiClient.source !== 'server' || aiClient.supported === false) return false;
  const key = aiClient.apiKey;
  return typeof key === 'string' && key.trim().length > 0;
}

async function getCreditBalances(userId) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id) {
    return { aiCredits: 0, monthlyCredits: 0, purchasedCredits: 0 };
  }
  const user = await User.findById(id).select('aiCredits monthlyCredits purchasedCredits').lean();
  if (!user) {
    return { aiCredits: 0, monthlyCredits: 0, purchasedCredits: 0 };
  }
  const split = splitFromUser(user);
  return {
    aiCredits: totalOf(split),
    monthlyCredits: split.monthly,
    purchasedCredits: split.purchased,
  };
}

async function getBalance(userId) {
  const balances = await getCreditBalances(userId);
  return balances.aiCredits;
}

// Optimistic write so two spends cannot both pass the same balance.
async function applySplit(userId, compute) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id) return { missing: true };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const user = await User.findById(id)
      .select('aiCredits monthlyCredits purchasedCredits')
      .lean();
    if (!user) return { missing: true };
    const current = splitFromUser(user);
    const outcome = compute(current);
    if (outcome && outcome.reject) {
      return {
        missing: false,
        rejected: true,
        aiCredits: totalOf(current),
        monthly: current.monthly,
        purchased: current.purchased,
      };
    }
    const monthly = creditNumber(outcome.monthly);
    const purchased = creditNumber(outcome.purchased);
    const aiCredits = roundCredits(monthly + purchased);
    const updated = await User.findOneAndUpdate(
      bucketFilter(id, user),
      { $set: { monthlyCredits: monthly, purchasedCredits: purchased, aiCredits } },
      { new: true },
    ).select('aiCredits monthlyCredits purchasedCredits').lean();
    if (!updated) continue;
    return {
      missing: false,
      rejected: false,
      aiCredits: creditNumber(updated.aiCredits),
      monthly: creditNumber(updated.monthlyCredits),
      purchased: creditNumber(updated.purchasedCredits),
      spentMonthly: creditNumber(outcome.spentMonthly),
      spentPurchased: creditNumber(outcome.spentPurchased),
    };
  }
  return {
    missing: false,
    rejected: true,
    aiCredits: await getBalance(id),
  };
}

// Atomic. ok is false only when monthly and purchased together are short.
async function deduct(userId, amount) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  const cost = creditNumber(amount);
  if (!id || cost <= 0) return { ok: false, aiCredits: 0 };
  const result = await applySplit(id, (current) => {
    const total = totalOf(current);
    if (total < cost) return { reject: true };
    const spentMonthly = Math.min(current.monthly, cost);
    const spentPurchased = creditNumber(cost - spentMonthly);
    return {
      monthly: creditNumber(current.monthly - spentMonthly),
      purchased: creditNumber(current.purchased - spentPurchased),
      spentMonthly,
      spentPurchased,
    };
  });
  if (!result || result.missing || result.rejected) {
    return {
      ok: false,
      aiCredits: result && !result.missing ? result.aiCredits : 0,
    };
  }
  return {
    ok: true,
    aiCredits: result.aiCredits,
    spentMonthly: result.spentMonthly,
    spentPurchased: result.spentPurchased,
  };
}

async function addTo(userId, amount, field) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  const grant = creditNumber(amount);
  if (!id || grant <= 0) return null;
  const result = await applySplit(id, (current) => ({
    monthly: field === 'monthly' ? creditNumber(current.monthly + grant) : current.monthly,
    purchased: field === 'purchased' ? creditNumber(current.purchased + grant) : current.purchased,
  }));
  if (!result || result.missing || result.rejected) return null;
  return result.aiCredits;
}

// Packs and admin grants. Returns the new combined balance, or null when the user is missing.
async function add(userId, amount) {
  return addTo(userId, amount, 'purchased');
}

// Trial grant. A later tier renewal replaces this bucket.
async function addMonthly(userId, amount) {
  return addTo(userId, amount, 'monthly');
}

// Puts a failed charge back into the buckets it came from.
async function restore(userId, spentMonthly, spentPurchased) {
  const monthlyGrant = creditNumber(spentMonthly);
  const purchasedGrant = creditNumber(spentPurchased);
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id || (monthlyGrant <= 0 && purchasedGrant <= 0)) return null;
  const result = await applySplit(id, (current) => ({
    monthly: creditNumber(current.monthly + monthlyGrant),
    purchased: creditNumber(current.purchased + purchasedGrant),
  }));
  if (!result || result.missing || result.rejected) return null;
  return result.aiCredits;
}

// Replaces monthly credits. A tier subscribe or renewal uses this so leftover
// monthly credits do not stack. Purchased credits stay.
async function setBalance(userId, amount) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  const grant = creditNumber(amount);
  if (!id || grant <= 0) return null;
  const result = await applySplit(id, (current) => ({
    monthly: grant,
    purchased: current.purchased,
  }));
  if (!result || result.missing || result.rejected) return null;
  return result.aiCredits;
}

module.exports = {
  INSUFFICIENT_MESSAGE,
  PASTE_CREDIT_COST,
  PLACES_CREDIT_COST,
  SUGGEST_CREDIT_COST,
  COMMAND_CREDIT_COST,
  usesServerKey,
  getBalance,
  getCreditBalances,
  deduct,
  add,
  addMonthly,
  restore,
  setBalance,
};
