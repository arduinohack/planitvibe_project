const logger = require('./logger');
const { add, setBalance } = require('./aiCredits');
const StripeEvent = require('../models/StripeEvent');
const User = require('../models/User');
const {
  resolveTier,
  tierCredits,
  tierRank,
} = require('./membershipTiers');

const CREDIT_PACKS = {
  100: 100,
  500: 500,
};

const PACKS = {
  planitvibe: {
    mode: 'subscription',
    env: 'STRIPE_PRICE_PLANITVIBE_MONTHLY',
    type: 'planitvibe',
  },
  plus: {
    mode: 'subscription',
    env: 'STRIPE_PRICE_PLANITVIBE_PLUS_MONTHLY',
    type: 'plus',
  },
  pro: {
    mode: 'subscription',
    env: 'STRIPE_PRICE_PLANITVIBE_PRO_MONTHLY',
    type: 'pro',
  },
  '100': {
    mode: 'payment',
    env: 'STRIPE_PRICE_PLANITVIBE_CREDITS_100',
    type: 'credits_100',
  },
  '500': {
    mode: 'payment',
    env: 'STRIPE_PRICE_PLANITVIBE_CREDITS_500',
    type: 'credits_500',
  },
};

const TIER_PRICE_ENV = {
  planitvibe: 'STRIPE_PRICE_PLANITVIBE_MONTHLY',
  plus: 'STRIPE_PRICE_PLANITVIBE_PLUS_MONTHLY',
  pro: 'STRIPE_PRICE_PLANITVIBE_PRO_MONTHLY',
};

const BAD_PACK = 'Pack must be planitvibe, plus, pro, 100, or 500';
const BAD_SIGNATURE = 'Invalid signature';
const NOT_CONFIGURED = 'Credit packs are not configured';
const CHECKOUT_FAILED = 'Could not start checkout';

function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function packSpec(pack) {
  if (typeof pack !== 'string') return null;
  return PACKS[pack.trim()] || null;
}

function creditsForType(type) {
  if (type === 'credits_100') return CREDIT_PACKS[100];
  if (type === 'credits_500') return CREDIT_PACKS[500];
  return 0;
}

function stripeClient() {
  const key = envValue('STRIPE_SECRET_KEY');
  if (!key) return null;
  const Stripe = require('stripe');
  return Stripe(key);
}

function returnUrls() {
  return {
    success_url: envValue('STRIPE_SUCCESS_URL') || 'https://planitvibe.com/?checkout=success',
    cancel_url: envValue('STRIPE_CANCEL_URL') || 'https://planitvibe.com/?checkout=cancel',
  };
}

function duplicateKey(err) {
  if (!err) return false;
  if (err.code === 11000) return true;
  return Boolean(err.cause && err.cause.code === 11000);
}

function textId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripeId(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return textId(value.id);
  return '';
}

function metadataOf(value) {
  if (!value || typeof value !== 'object') return null;
  const metadata = value.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return metadata;
}

function metaUserId(value) {
  const metadata = metadataOf(value);
  return textId(metadata && metadata.userId);
}

function metaType(value) {
  const metadata = metadataOf(value);
  return textId(metadata && metadata.type);
}

function unixDate(value) {
  const seconds = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function createCreditCheckout({ userId, pack }) {
  const spec = packSpec(pack);
  if (!spec) return { status: 400, body: { message: BAD_PACK } };
  const price = envValue(spec.env);
  const stripe = stripeClient();
  if (!stripe || !price) return { status: 503, body: { message: NOT_CONFIGURED } };
  try {
    const metadata = { userId, type: spec.type, priceId: price };
    const payload = {
      mode: spec.mode,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: userId,
      metadata,
      ...returnUrls(),
    };
    if (spec.mode === 'subscription') payload.subscription_data = { metadata };
    const session = await stripe.checkout.sessions.create(payload);
    const url = session && typeof session.url === 'string' ? session.url.trim() : '';
    if (!url) return { status: 502, body: { message: CHECKOUT_FAILED } };
    return { status: 200, body: { url } };
  } catch (err) {
    const message = err && err.message ? err.message : 'request failed';
    logger.error(`Stripe checkout failed: ${message}`, {
      event: 'StripeCheckout',
      userId,
    });
    return { status: 502, body: { message: CHECKOUT_FAILED } };
  }
}

function readWebhookEvent(rawBody, signature) {
  const secret = envValue('STRIPE_WEBHOOK_SECRET');
  const stripe = stripeClient();
  if (!secret || !stripe) {
    const error = new Error(NOT_CONFIGURED);
    error.status = 500;
    throw error;
  }
  try {
    return stripe.webhooks.constructEvent(rawBody, signature || '', secret);
  } catch (_) {
    const error = new Error(BAD_SIGNATURE);
    error.status = 400;
    throw error;
  }
}

function sessionUserId(session) {
  const metadata = session && session.metadata;
  const userId = metadata && metadata.userId;
  return typeof userId === 'string' ? userId.trim() : '';
}

function plusCheckoutUserId(session) {
  const fromMeta = sessionUserId(session);
  if (fromMeta) return fromMeta;
  return textId(session && session.client_reference_id);
}

function isPaidTierType(type) {
  return type === 'planitvibe' || type === 'plus' || type === 'pro';
}

function isPlusSession(session) {
  if (isPaidTierType(metaType(session))) return true;
  return Boolean(session && session.mode === 'subscription');
}

function lineItems(value) {
  const lines = value && value.lines && value.lines.data;
  if (Array.isArray(lines)) return lines;
  const items = value && value.items && value.items.data;
  return Array.isArray(items) ? items : [];
}

function linePriceId(line) {
  if (!line || typeof line !== 'object') return '';
  const price = stripeId(line.price);
  if (price) return price;
  const details = line.pricing && line.pricing.price_details;
  return details ? stripeId(details.price) : '';
}

function configuredTierPrices() {
  return Object.values(TIER_PRICE_ENV).map((name) => envValue(name)).filter(Boolean);
}

function tierFromPriceId(priceId) {
  if (!priceId) return '';
  for (const [tier, name] of Object.entries(TIER_PRICE_ENV)) {
    const configured = envValue(name);
    if (configured && priceId === configured) return tier;
  }
  return '';
}

function matchesPlusPrice(invoice) {
  const configured = configuredTierPrices();
  if (!configured.length) return false;
  return lineItems(invoice).some((line) => configured.includes(linePriceId(line)));
}

function invoiceUserId(invoice) {
  const lines = lineItems(invoice);
  const candidates = [
    invoice,
    invoice && invoice.subscription_details,
    invoice && invoice.parent && invoice.parent.subscription_details,
    lines[0],
  ];
  for (const candidate of candidates) {
    const id = metaUserId(candidate);
    if (id) return id;
  }
  return '';
}

function subscriptionIdOfInvoice(invoice) {
  const direct = stripeId(invoice && invoice.subscription);
  if (direct) return direct;
  const parent = invoice && invoice.parent && invoice.parent.subscription_details;
  return parent ? stripeId(parent.subscription) : '';
}

function tierFromMetadata(value) {
  const type = metaType(value);
  return isPaidTierType(type) ? type : '';
}

function isPlusInvoice(invoice) {
  if (!invoice) return false;
  if (tierFromMetadata(invoice)) return true;
  if (tierFromMetadata(invoice.subscription_details)) return true;
  if (invoice.parent && tierFromMetadata(invoice.parent.subscription_details)) return true;
  if (lineItems(invoice).some((line) => tierFromMetadata(line) || tierFromPriceId(linePriceId(line)))) {
    return true;
  }
  return matchesPlusPrice(invoice);
}

function tierFromInvoice(invoice) {
  const fromMeta = tierFromMetadata(invoice)
    || tierFromMetadata(invoice && invoice.subscription_details)
    || (invoice && invoice.parent ? tierFromMetadata(invoice.parent.subscription_details) : '');
  if (fromMeta) return fromMeta;
  for (const line of lineItems(invoice)) {
    const fromLine = tierFromMetadata(line) || tierFromPriceId(linePriceId(line));
    if (fromLine) return fromLine;
  }
  const fromPrice = tierFromPriceId(priceIdFromInvoice(invoice));
  return fromPrice || 'plus';
}

function periodEndFromSession(session) {
  const direct = unixDate(session && session.current_period_end);
  if (direct) return direct;
  const subscription = session && session.subscription;
  if (subscription && typeof subscription === 'object') {
    return unixDate(subscription.current_period_end);
  }
  return null;
}

function periodEndFromInvoice(invoice) {
  for (const line of lineItems(invoice)) {
    const end = unixDate(line && line.period && line.period.end);
    if (end) return end;
  }
  return unixDate(invoice && invoice.period_end);
}

function plusPriceFromSubscription(subscription) {
  const fromItem = linePriceId(lineItems(subscription)[0]);
  if (fromItem) return fromItem;
  const metadata = metadataOf(subscription);
  return textId(metadata && metadata.priceId);
}

function plusPriceFromSession(session) {
  const metadata = metadataOf(session);
  const fromMeta = textId(metadata && metadata.priceId);
  if (fromMeta) return fromMeta;
  const subscription = session && session.subscription;
  if (subscription && typeof subscription === 'object') {
    return plusPriceFromSubscription(subscription);
  }
  return '';
}

function priceIdFromInvoice(invoice) {
  const fromLine = linePriceId(lineItems(invoice)[0]);
  if (fromLine) return fromLine;
  const metadata = metadataOf(invoice);
  return textId(metadata && metadata.priceId);
}

function periodGrantKey(subscriptionId, periodEnd) {
  if (!subscriptionId || !periodEnd) return '';
  return `grant:period:${subscriptionId}:${periodEnd.getTime()}`;
}

async function runOnce(eventId, fields, work) {
  const id = textId(eventId);
  if (!id) return;
  let claimed = false;
  try {
    await StripeEvent.create({
      _id: id,
      sessionId: '',
      userId: '',
      credits: 0,
      ...fields,
    });
    claimed = true;
    await work();
  } catch (err) {
    if (duplicateKey(err)) return;
    if (claimed) await StripeEvent.deleteOne({ _id: id });
    throw err;
  }
}

// Invoice id is shared by checkout.session.completed and invoice.paid.
// The period key covers a checkout session that has no invoice id yet.
async function grantTierOnce(userId, keys, credits) {
  const grant = Number(credits);
  if (!Number.isFinite(grant) || grant <= 0) return;
  const unique = [];
  const seen = new Set();
  for (const key of keys) {
    const id = textId(key);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (!unique.length) return;
  const created = [];
  try {
    for (const key of unique) {
      try {
        await StripeEvent.create({
          _id: key,
          sessionId: '',
          userId,
          credits: grant,
        });
        created.push(key);
      } catch (err) {
        if (duplicateKey(err)) return;
        throw err;
      }
    }
    const balance = await setBalance(userId, grant);
    if (balance == null) {
      logger.error('Stripe Plus user was not found', {
        event: 'StripeWebhook',
        userId,
      });
    }
  } catch (err) {
    if (created.length) await StripeEvent.deleteMany({ _id: { $in: created } });
    throw err;
  }
}

function paidTierOf(user) {
  return resolveTier(user);
}

function subscriptionEndedAt(subscription) {
  return unixDate(subscription && subscription.ended_at)
    || unixDate(subscription && subscription.canceled_at)
    || new Date();
}

async function markPlus({
  userId,
  customerId,
  subscriptionId,
  priceId,
  periodEnd,
  active,
  tier,
  setSubscribedAt,
  allowLower,
}) {
  const existing = await User.findById(userId)
    .select('tier plusActive stripeSubscriptionId subscribedAt')
    .lean();
  if (!existing) {
    logger.error('Stripe Plus user was not found', {
      event: 'StripeWebhook',
      userId,
    });
    return;
  }
  const currentTier = paidTierOf(existing);
  const currentSub = textId(existing.stripeSubscriptionId);
  if (tier && subscriptionId && currentSub && currentSub !== subscriptionId) {
    if (!allowLower && tierRank(tier) < tierRank(currentTier)) return;
  }
  const update = {};
  const unset = {};
  if (typeof active === 'boolean') update.plusActive = active;
  if (tier) update.tier = tier;
  if (customerId) update.stripeCustomerId = customerId;
  if (subscriptionId) update.stripeSubscriptionId = subscriptionId;
  if (priceId) update.plusPriceId = priceId;
  if (periodEnd) update.plusCurrentPeriodEnd = periodEnd;
  if (active === true) unset.expiredAt = '';
  if (setSubscribedAt) {
    const sameSubscription = Boolean(subscriptionId) && currentSub === subscriptionId;
    if (!(sameSubscription && existing.subscribedAt)) update.subscribedAt = new Date();
  }
  const op = {};
  if (Object.keys(update).length) op.$set = update;
  if (Object.keys(unset).length) op.$unset = unset;
  if (!Object.keys(op).length) return;
  await User.updateOne({ _id: userId }, op);
}

async function userIdForSubscription(subscriptionId, customerId) {
  if (subscriptionId) {
    const bySubscription = await User.findOne({ stripeSubscriptionId: subscriptionId }).select('_id').lean();
    if (bySubscription) return bySubscription._id;
  }
  if (customerId) {
    const byCustomer = await User.findOne({ stripeCustomerId: customerId }).select('_id').lean();
    if (byCustomer) return byCustomer._id;
  }
  return '';
}

async function applyPlusCheckout(event, session) {
  const userId = plusCheckoutUserId(session);
  const eventId = textId(event.id);
  if (!eventId || !userId) {
    logger.error('Stripe Plus checkout was missing a user', {
      event: 'StripeWebhook',
      context: { eventId },
    });
    return;
  }
  const customerId = stripeId(session.customer);
  const subscriptionId = stripeId(session.subscription);
  const priceId = plusPriceFromSession(session);
  const periodEnd = periodEndFromSession(session);
  const invoiceId = stripeId(session.invoice);
  const sessionId = textId(session.id);
  const tier = tierFromMetadata(session) || tierFromPriceId(priceId) || 'plus';
  const credits = tierCredits(tier);
  await runOnce(eventId, { sessionId, userId, credits }, async () => {
    await markPlus({
      userId,
      customerId,
      subscriptionId,
      priceId,
      periodEnd,
      active: true,
      tier,
      setSubscribedAt: true,
      allowLower: true,
    });
    const keys = [
      periodGrantKey(subscriptionId, periodEnd),
      invoiceId ? `grant:invoice:${invoiceId}` : '',
    ];
    if (!keys.some(Boolean) && sessionId) keys.push(`grant:session:${sessionId}`);
    await grantTierOnce(userId, keys, credits);
  });
}

async function plusInvoiceUserId(invoice) {
  const fromMeta = invoiceUserId(invoice);
  if (fromMeta) return fromMeta;
  return userIdForSubscription(subscriptionIdOfInvoice(invoice), stripeId(invoice.customer));
}

async function ownsPlusSubscription(invoice, userId) {
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  if (!subscriptionId || !userId) return false;
  const user = await User.findById(userId).select('stripeSubscriptionId').lean();
  return Boolean(user && user.stripeSubscriptionId === subscriptionId);
}

async function applyPlusInvoice(event) {
  const invoice = event.data && event.data.object;
  const eventId = textId(event && event.id);
  const invoiceId = textId(invoice && invoice.id);
  if (!invoice || !eventId || !invoiceId) return;
  const plusInvoice = isPlusInvoice(invoice);
  const userId = await plusInvoiceUserId(invoice);
  const owned = plusInvoice ? false : await ownsPlusSubscription(invoice, userId);
  if (!plusInvoice && !owned) return;
  if (!userId) {
    logger.error('Stripe Plus invoice was missing a user', {
      event: 'StripeWebhook',
      context: { eventId },
    });
    return;
  }
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  const periodEnd = periodEndFromInvoice(invoice);
  const tier = tierFromInvoice(invoice);
  const credits = tierCredits(tier);
  await runOnce(eventId, { sessionId: invoiceId, userId, credits }, async () => {
    await markPlus({
      userId,
      customerId: stripeId(invoice.customer),
      subscriptionId,
      priceId: priceIdFromInvoice(invoice),
      periodEnd,
      active: true,
      tier,
    });
    await grantTierOnce(userId, [
      periodGrantKey(subscriptionId, periodEnd),
      `grant:invoice:${invoiceId}`,
    ], credits);
  });
}

async function applyPlusSubscription(event) {
  const subscription = event.data && event.data.object;
  const eventId = textId(event && event.id);
  if (!subscription || !eventId) return;
  const status = textId(subscription.status);
  const deleted = event.type === 'customer.subscription.deleted';
  const turnOff = deleted || status === 'canceled' || status === 'unpaid';
  const stillOn = !deleted && (status === 'active' || status === 'trialing');
  if (!turnOff && !stillOn) return;
  const subscriptionId = textId(subscription.id);
  const customerId = stripeId(subscription.customer);
  const userId = metaUserId(subscription) || await userIdForSubscription(subscriptionId, customerId);
  if (!userId) {
    logger.error('Stripe Plus subscription was missing a user', {
      event: 'StripeWebhook',
      context: { eventId },
    });
    return;
  }
  await runOnce(eventId, { sessionId: subscriptionId, userId, credits: 0 }, async () => {
    if (turnOff) {
      const existing = await User.findById(userId).select('stripeSubscriptionId').lean();
      const currentSub = existing ? textId(existing.stripeSubscriptionId) : '';
      if (subscriptionId && currentSub && currentSub !== subscriptionId) return;
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            plusActive: false,
            tier: 'trial',
            expiredAt: subscriptionEndedAt(subscription),
          },
        },
      );
      return;
    }
    const priceId = plusPriceFromSubscription(subscription);
    const tier = tierFromMetadata(subscription) || tierFromPriceId(priceId) || '';
    await markPlus({
      userId,
      customerId,
      subscriptionId,
      priceId,
      periodEnd: unixDate(subscription.current_period_end),
      active: true,
      tier,
    });
  });
}

async function applyCheckoutEvent(event) {
  if (!event || typeof event.type !== 'string') return;
  if (event.type === 'invoice.paid') {
    await applyPlusInvoice(event);
    return;
  }
  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
    await applyPlusSubscription(event);
    return;
  }
  if (event.type !== 'checkout.session.completed') return;
  const session = event.data && event.data.object;
  if (!session || session.payment_status !== 'paid') return;
  const type = metaType(session);
  const credits = creditsForType(type);
  if (credits) {
    await applyCreditCheckout(event, session, credits);
    return;
  }
  if (isPlusSession(session)) {
    await applyPlusCheckout(event, session);
    return;
  }
  logger.error('Stripe checkout session was missing a user or pack', {
    event: 'StripeWebhook',
    context: { eventId: textId(event.id) },
  });
}

async function applyCreditCheckout(event, session, credits) {
  const userId = sessionUserId(session);
  const eventId = typeof event.id === 'string' ? event.id.trim() : '';
  if (!eventId || !userId || !credits) {
    logger.error('Stripe checkout session was missing a user or pack', {
      event: 'StripeWebhook',
      context: { eventId },
    });
    return;
  }
  let claimed = false;
  try {
    await StripeEvent.create({
      _id: eventId,
      sessionId: typeof session.id === 'string' ? session.id : '',
      userId,
      credits,
    });
    claimed = true;
    const balance = await add(userId, credits);
    if (balance == null) {
      logger.error('Stripe checkout user was not found', {
        event: 'StripeWebhook',
        userId,
        context: { eventId },
      });
    }
  } catch (err) {
    if (duplicateKey(err)) return;
    if (claimed) await StripeEvent.deleteOne({ _id: eventId });
    throw err;
  }
}

module.exports = {
  CREDIT_PACKS,
  BAD_PACK,
  BAD_SIGNATURE,
  NOT_CONFIGURED,
  CHECKOUT_FAILED,
  createCreditCheckout,
  readWebhookEvent,
  applyCheckoutEvent,
};
