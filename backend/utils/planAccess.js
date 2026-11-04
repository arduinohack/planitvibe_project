const Plan = require('../models/Plan');
const User = require('../models/User');
const { addMonthly } = require('./aiCredits');
const { notArchivedFilter } = require('./planArchive');
const {
  UPGRADE_MESSAGE,
  planCapFor,
  resolveTier,
  tierName,
  upgradeBody,
} = require('./membershipTiers');

const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
const TRIAL_CREDITS = 15;
const TRIAL_PLAN_LIMIT = 2;

const CREATE_MESSAGE = UPGRADE_MESSAGE;
const DELETE_MESSAGE = 'Upgrade to Plus to delete a plan.';
const EXPORT_MESSAGE = 'Upgrade to Plus to export.';
const EDIT_MESSAGE = 'Upgrade to Plus to edit this plan.';
const AI_MESSAGE = 'Upgrade to Plus to use AI.';
const ATTACH_MESSAGE = 'Upgrade to Plus to add a file.';
const EXCESS_MESSAGE = 'This plan is read-only on the free trial. Upgrade to Plus to edit it.';
const VERIFY_EMAIL_MESSAGE = 'Verify your email before creating a plan.';

function userIdOf(value) {
  if (value == null) return '';
  return String(value).trim();
}

function isPlus(user) {
  return resolveTier(user) !== 'trial';
}

function trialIsActive(user, now = new Date()) {
  if (!user || !user.trialEndsAt) return false;
  const end = new Date(user.trialEndsAt);
  return !Number.isNaN(end.getTime()) && end.getTime() > now.getTime();
}

function trialHasStarted(user) {
  return Boolean(user && user.trialStartedAt);
}

// Someone who has not started a trial is not past it. An invited collaborator
// can still edit until their own first plan starts the trial and that trial ends.
function canEditContent(user, now = new Date()) {
  if (!user) return false;
  if (isPlus(user)) return true;
  if (trialIsActive(user, now)) return true;
  return !trialHasStarted(user);
}

function canRemovePlan(user, now = new Date()) {
  if (!user) return false;
  if (isPlus(user)) return true;
  return trialIsActive(user, now);
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function blocked(message) {
  return { status: 402, message };
}

function blockedUpgrade(tier) {
  const body = upgradeBody(tier);
  return { status: 402, message: body.message, body };
}

function createdAtMillis(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Active trial only. Plus, a paid tier, and an expired trial are not excess.
// Archived plans are omitted, matching the owned-plan cap. The first two by
// createdAt stay editable. Every later owned plan is read-only.
async function excessPlanIds(ownerIds) {
  const ids = [...new Set((ownerIds || []).map((id) => userIdOf(id)).filter(Boolean))];
  const excess = new Set();
  if (!ids.length) return excess;
  const users = await User.find({ _id: { $in: ids } })
    .select('plusActive tier trialStartedAt trialEndsAt')
    .lean();
  const trialOwnerIds = [];
  for (const user of users) {
    if (isPlus(user) || !trialIsActive(user)) continue;
    trialOwnerIds.push(String(user._id));
  }
  if (!trialOwnerIds.length) return excess;
  const owned = await Plan.find({
    ownerId: { $in: trialOwnerIds },
    ...notArchivedFilter(),
  }).select('_id ownerId createdAt').lean();
  const byOwner = new Map();
  for (const plan of owned) {
    const key = String(plan.ownerId);
    const rows = byOwner.get(key);
    if (rows) rows.push(plan);
    else byOwner.set(key, [plan]);
  }
  for (const rows of byOwner.values()) {
    rows.sort((a, b) => {
      const delta = createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt);
      if (delta !== 0) return delta;
      return String(a._id).localeCompare(String(b._id));
    });
    for (const plan of rows.slice(TRIAL_PLAN_LIMIT)) {
      excess.add(String(plan._id));
    }
  }
  return excess;
}

async function excessPlanGate(planId) {
  const id = userIdOf(planId);
  if (!id) return allowed();
  const plan = await Plan.findById(id).select('ownerId').lean();
  if (!plan) return allowed();
  const excess = await excessPlanIds([plan.ownerId]);
  if (!excess.has(id)) return allowed();
  return blocked(EXCESS_MESSAGE);
}

function allowed() {
  return { status: 200 };
}

async function ownedPlanCount(userId) {
  const id = userIdOf(userId);
  if (!id) return 0;
  return Plan.countDocuments({ ownerId: id, ...notArchivedFilter() });
}

async function loadAccessUser(userId) {
  const id = userIdOf(userId);
  if (!id) return null;
  return User.findById(id).select(
    'plusActive tier trialStartedAt trialEndsAt emailVerified subscribedAt plusCurrentPeriodEnd expiredAt',
  ).lean();
}

async function accessSummary(userId) {
  const id = userIdOf(userId);
  const [user, plansOwned] = await Promise.all([
    loadAccessUser(id),
    ownedPlanCount(id),
  ]);
  const tier = resolveTier(user);
  return {
    trialStartedAt: isoOrNull(user && user.trialStartedAt),
    trialEndsAt: isoOrNull(user && user.trialEndsAt),
    trialActive: trialIsActive(user),
    plusActive: tier !== 'trial',
    plansOwned,
    tier,
    tierName: tierName(tier),
    planCap: planCapFor(tier),
    subscribedAt: isoOrNull(user && user.subscribedAt),
    currentPeriodEnd: isoOrNull(user && user.plusCurrentPeriodEnd),
    expiredAt: isoOrNull(user && user.expiredAt),
  };
}

async function startTrial(userId, now) {
  const ends = new Date(now.getTime() + TRIAL_MS);
  const updated = await User.findOneAndUpdate(
    { _id: userId, trialStartedAt: null },
    { $set: { trialStartedAt: now, trialEndsAt: ends } },
    { new: true },
  ).select('_id');
  if (!updated) return;
  try {
    const balance = await addMonthly(userId, TRIAL_CREDITS);
    if (balance == null) {
      await User.updateOne(
        { _id: userId },
        { $unset: { trialStartedAt: 1, trialEndsAt: 1 } },
      );
    }
  } catch (err) {
    await User.updateOne(
      { _id: userId },
      { $unset: { trialStartedAt: 1, trialEndsAt: 1 } },
    );
    throw err;
  }
}

async function preparePlanCreate(userId) {
  const id = userIdOf(userId);
  const [user, plansOwned] = await Promise.all([
    loadAccessUser(id),
    ownedPlanCount(id),
  ]);
  const tier = resolveTier(user);
  const paid = tier !== 'trial';
  if (user && user.emailVerified === false && !paid) {
    return { status: 403, message: VERIFY_EMAIL_MESSAGE };
  }
  const now = new Date();
  const cap = planCapFor(tier);
  // A person who owns no plans is a guest of other plans only. Memberships
  // do not count, and the cap does not block that first owned plan.
  if (paid) {
    if (plansOwned >= cap) return blockedUpgrade(tier);
  } else if (plansOwned > 0 && (!trialIsActive(user, now) || plansOwned >= cap)) {
    return blockedUpgrade(tier);
  }
  if (plansOwned === 0 && !trialHasStarted(user)) await startTrial(id, now);
  return allowed();
}

async function preparePlanRecall(ownerId) {
  const id = userIdOf(ownerId);
  const [user, plansOwned] = await Promise.all([
    loadAccessUser(id),
    ownedPlanCount(id),
  ]);
  const tier = resolveTier(user);
  if (plansOwned >= planCapFor(tier)) return blockedUpgrade(tier);
  return allowed();
}

async function preparePlanDelete(userId, planId) {
  const user = await loadAccessUser(userId);
  if (!canRemovePlan(user)) return blocked(DELETE_MESSAGE);
  return excessPlanGate(planId);
}

async function prepareExport(userId) {
  const user = await loadAccessUser(userId);
  if (isPlus(user)) return allowed();
  return blocked(EXPORT_MESSAGE);
}

async function prepareEdit(userId, planId) {
  const user = await loadAccessUser(userId);
  if (!canEditContent(user)) return blocked(EDIT_MESSAGE);
  return excessPlanGate(planId);
}

function usesOwnKey(aiClient) {
  if (!aiClient || aiClient.source !== 'user' || aiClient.supported === false) return false;
  const key = aiClient.apiKey;
  return typeof key === 'string' && key.trim().length > 0;
}

async function prepareAi(userId, aiClient, planId) {
  if (usesOwnKey(aiClient)) return allowed();
  const gate = await prepareEdit(userId, planId);
  if (gate.status === 200 || gate.message === EXCESS_MESSAGE) return gate;
  return blocked(AI_MESSAGE);
}

async function prepareAttachment(userId, planId) {
  const gate = await prepareEdit(userId, planId);
  if (gate.status === 200 || gate.message === EXCESS_MESSAGE) return gate;
  return blocked(ATTACH_MESSAGE);
}

module.exports = {
  TRIAL_CREDITS,
  TRIAL_PLAN_LIMIT,
  CREATE_MESSAGE,
  UPGRADE_MESSAGE,
  DELETE_MESSAGE,
  EXPORT_MESSAGE,
  EDIT_MESSAGE,
  AI_MESSAGE,
  ATTACH_MESSAGE,
  EXCESS_MESSAGE,
  VERIFY_EMAIL_MESSAGE,
  excessPlanIds,
  accessSummary,
  preparePlanCreate,
  preparePlanRecall,
  preparePlanDelete,
  prepareExport,
  prepareEdit,
  prepareAi,
  prepareAttachment,
};
