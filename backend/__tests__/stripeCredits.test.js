jest.mock('stripe', () => {
  const create = jest.fn();
  const constructEvent = jest.fn();
  const client = {
    checkout: { sessions: { create } },
    webhooks: { constructEvent },
  };
  const Stripe = jest.fn(() => client);
  Stripe.__client = client;
  return Stripe;
});

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Stripe = require('stripe');
const app = require('../app');
const { allowRegister, clearRegisterInvite } = require('./inviteForRegister');
const User = require('../models/User');
const StripeEvent = require('../models/StripeEvent');
const { getBalance } = require('../utils/aiCredits');

jest.setTimeout(30000);

const CHECKOUT = '/api/users/me/ai-credits/checkout';
const WEBHOOK = '/api/stripe/webhook';
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_123';
const PRICE_100 = 'price_credits_100';
const PRICE_500 = 'price_credits_500';
const PRICE_PLUS_MONTHLY = 'price_plus_monthly';
const PRICE_PLUS_YEARLY = 'price_plus_yearly';
const CREDITS = '/api/users/me/ai-credits';

let mongo;
const previous = {
  secret: process.env.STRIPE_SECRET_KEY,
  webhook: process.env.STRIPE_WEBHOOK_SECRET,
  price100: process.env.STRIPE_PRICE_CREDITS_100,
  price500: process.env.STRIPE_PRICE_CREDITS_500,
  plusMonthly: process.env.STRIPE_PRICE_PLUS_MONTHLY,
  plusYearly: process.env.STRIPE_PRICE_PLUS_YEARLY,
  planitvibe: process.env.STRIPE_PRICE_PLANITVIBE,
  plus: process.env.STRIPE_PRICE_PLUS,
  pro: process.env.STRIPE_PRICE_PRO,
};

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function restore(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function restoreStripeEnv() {
  restore('STRIPE_SECRET_KEY', previous.secret);
  restore('STRIPE_WEBHOOK_SECRET', previous.webhook);
  restore('STRIPE_PRICE_CREDITS_100', previous.price100);
  restore('STRIPE_PRICE_CREDITS_500', previous.price500);
  restore('STRIPE_PRICE_PLUS_MONTHLY', previous.plusMonthly);
  restore('STRIPE_PRICE_PLUS_YEARLY', previous.plusYearly);
  restore('STRIPE_PRICE_PLANITVIBE', previous.planitvibe);
  restore('STRIPE_PRICE_PLUS', previous.plus);
  restore('STRIPE_PRICE_PRO', previous.pro);
}

function sessionsCreate() {
  return Stripe.__client.checkout.sessions.create;
}

function constructEvent() {
  return Stripe.__client.webhooks.constructEvent;
}

function paidEvent(eventId, userId, credits) {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${eventId}`,
        payment_status: 'paid',
        client_reference_id: userId,
        metadata: { userId, credits: String(credits) },
      },
    },
  };
}

async function registerAndLogin(email) {
  await allowRegister(email);
  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({ firstName: 'Ada', lastName: 'Lovelace', email, password: 'password1' });
  await clearRegisterInvite(email);
  expect(registerRes.status).toBe(201);
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'password1' });
  expect(loginRes.status).toBe(200);
  return { token: loginRes.body.token, userId: loginRes.body.user._id };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_credit_pack';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PRICE_CREDITS_100 = PRICE_100;
  process.env.STRIPE_PRICE_CREDITS_500 = PRICE_500;
  Stripe.mockClear();
  sessionsCreate().mockReset();
  constructEvent().mockReset();
});

afterEach(async () => {
  restoreStripeEnv();
  await Promise.all([
    User.deleteMany({}),
    StripeEvent.deleteMany({}),
  ]);
});

afterAll(async () => {
  restoreStripeEnv();
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('Stripe credit packs', () => {
  test('checkout returns a Stripe URL for 100 and 500 credits', async () => {
    const ada = await registerAndLogin('ada@example.com');
    sessionsCreate().mockResolvedValue({ url: CHECKOUT_URL });

    const missing = await request(app)
      .post(CHECKOUT)
      .send({ pack: '100' });
    expect(missing.status).toBe(401);

    const bad = await request(app)
      .post(CHECKOUT)
      .set(bearer(ada.token))
      .send({ pack: 100 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Pack must be 100 or 500');
    expect(sessionsCreate()).not.toHaveBeenCalled();

    const small = await request(app)
      .post(CHECKOUT)
      .set(bearer(ada.token))
      .send({ pack: '100' });
    expect(small.status).toBe(200);
    expect(small.body).toEqual({ url: CHECKOUT_URL });
    expect(sessionsCreate()).toHaveBeenCalledWith({
      mode: 'payment',
      line_items: [{ price: PRICE_100, quantity: 1 }],
      client_reference_id: ada.userId,
      metadata: { userId: ada.userId, credits: '100' },
      success_url: 'https://planitvibe.com/?checkout=success',
      cancel_url: 'https://planitvibe.com/?checkout=cancel',
    });
    expect(Stripe).toHaveBeenCalledWith('sk_test_credit_pack');

    const large = await request(app)
      .post(CHECKOUT)
      .set(bearer(ada.token))
      .send({ pack: '500' });
    expect(large.status).toBe(200);
    expect(large.body).toEqual({ url: CHECKOUT_URL });
    expect(sessionsCreate()).toHaveBeenLastCalledWith(expect.objectContaining({
      line_items: [{ price: PRICE_500, quantity: 1 }],
      metadata: { userId: ada.userId, credits: '500' },
    }));
    expect(await getBalance(ada.userId)).toBe(0);
  });

  test('a paid webhook grants the pack once', async () => {
    const ada = await registerAndLogin('ada@example.com');
    const event = paidEvent('evt_100', ada.userId, 100);
    constructEvent().mockReturnValue(event);

    const granted = await request(app)
      .post(WEBHOOK)
      .set('stripe-signature', 't=1,v1=test')
      .set('Content-Type', 'application/json')
      .send(event);
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ received: true });
    expect(Buffer.isBuffer(constructEvent().mock.calls[0][0])).toBe(true);
    expect(constructEvent().mock.calls[0][1]).toBe('t=1,v1=test');
    expect(constructEvent().mock.calls[0][2]).toBe('whsec_test');
    expect(await getBalance(ada.userId)).toBe(100);

    const retry = await request(app)
      .post(WEBHOOK)
      .set('stripe-signature', 't=1,v1=test')
      .set('Content-Type', 'application/json')
      .send(event);
    expect(retry.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(100);
    expect(await StripeEvent.countDocuments({})).toBe(1);

    const bigger = paidEvent('evt_500', ada.userId, 500);
    constructEvent().mockReturnValue(bigger);
    const second = await request(app)
      .post(WEBHOOK)
      .set('stripe-signature', 't=2,v1=test')
      .set('Content-Type', 'application/json')
      .send(bigger);
    expect(second.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(600);
  });

  test('an unpaid session and a bad signature do not grant credits', async () => {
    const ada = await registerAndLogin('ada@example.com');
    const unpaid = paidEvent('evt_unpaid', ada.userId, 100);
    unpaid.data.object.payment_status = 'unpaid';
    constructEvent().mockReturnValue(unpaid);
    const skipped = await request(app)
      .post(WEBHOOK)
      .set('stripe-signature', 't=1,v1=test')
      .set('Content-Type', 'application/json')
      .send(unpaid);
    expect(skipped.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(0);
    expect(await StripeEvent.countDocuments({})).toBe(0);

    const forged = paidEvent('evt_forged', ada.userId, 999);
    constructEvent().mockReturnValue(forged);
    const ignored = await request(app)
      .post(WEBHOOK)
      .set('stripe-signature', 't=1,v1=test')
      .set('Content-Type', 'application/json')
      .send(forged);
    expect(ignored.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(0);

    constructEvent().mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const bad = await request(app)
      .post(WEBHOOK)
      .set('stripe-signature', 't=1,v1=bad')
      .set('Content-Type', 'application/json')
      .send(paidEvent('evt_bad', ada.userId, 100));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ message: 'Invalid signature' });
    expect(await getBalance(ada.userId)).toBe(0);
  });
});

function plusMetadata(userId, priceId) {
  return { userId, type: 'plus', priceId };
}

async function postWebhook(event) {
  constructEvent().mockReturnValue(event);
  return request(app)
    .post(WEBHOOK)
    .set('stripe-signature', 't=1,v1=test')
    .set('Content-Type', 'application/json')
    .send(event);
}

describe('Plus subscription', () => {
  test('plus checkout returns a Stripe subscription URL', async () => {
    const ada = await registerAndLogin('plus-checkout@example.com');
    sessionsCreate().mockResolvedValue({ url: CHECKOUT_URL });
    delete process.env.STRIPE_PRICE_PLUS_MONTHLY;
    delete process.env.STRIPE_PRICE_PLUS_YEARLY;

    const missing = await request(app)
      .post(CHECKOUT)
      .set(bearer(ada.token))
      .send({ pack: 'plus_monthly' });
    expect(missing.status).toBe(503);
    expect(missing.body.message).toBe('Credit packs are not configured');
    expect(sessionsCreate()).not.toHaveBeenCalled();

    process.env.STRIPE_PRICE_PLUS_MONTHLY = PRICE_PLUS_MONTHLY;
    const monthly = await request(app)
      .post(CHECKOUT)
      .set(bearer(ada.token))
      .send({ pack: 'plus_monthly' });
    expect(monthly.status).toBe(200);
    expect(monthly.body).toEqual({ url: CHECKOUT_URL });
    const monthlyMetadata = plusMetadata(ada.userId, PRICE_PLUS_MONTHLY);
    expect(sessionsCreate()).toHaveBeenCalledWith({
      mode: 'subscription',
      line_items: [{ price: PRICE_PLUS_MONTHLY, quantity: 1 }],
      client_reference_id: ada.userId,
      metadata: monthlyMetadata,
      subscription_data: { metadata: monthlyMetadata },
      success_url: 'https://planitvibe.com/?checkout=success',
      cancel_url: 'https://planitvibe.com/?checkout=cancel',
    });

    const yearlyMissing = await request(app)
      .post(CHECKOUT)
      .set(bearer(ada.token))
      .send({ pack: 'plus_yearly' });
    expect(yearlyMissing.status).toBe(503);
    expect(yearlyMissing.body.message).toBe('Credit packs are not configured');

    process.env.STRIPE_PRICE_PLUS_YEARLY = PRICE_PLUS_YEARLY;
    const yearly = await request(app)
      .post(CHECKOUT)
      .set(bearer(ada.token))
      .send({ pack: 'plus_yearly' });
    expect(yearly.status).toBe(200);
    expect(yearly.body).toEqual({ url: CHECKOUT_URL });
    expect(sessionsCreate()).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'subscription',
      line_items: [{ price: PRICE_PLUS_YEARLY, quantity: 1 }],
      metadata: plusMetadata(ada.userId, PRICE_PLUS_YEARLY),
    }));

    const balance = await request(app).get(CREDITS).set(bearer(ada.token));
    expect(balance.status).toBe(200);
    expect(balance.body).toEqual({
      aiCredits: 0,
      plusActive: false,
      trialStartedAt: null,
      trialEndsAt: null,
      trialActive: false,
      plansOwned: 0,
      tier: 'trial',
      tierName: 'PlanItVibe (Trial)',
      planCap: 2,
      subscribedAt: null,
      currentPeriodEnd: null,
      expiredAt: null,
    });
  });

  test('a paid Plus subscription grants 100 once per invoice and cancel clears Plus', async () => {
    process.env.STRIPE_PRICE_PLUS_MONTHLY = PRICE_PLUS_MONTHLY;
    const ada = await registerAndLogin('plus-webhook@example.com');
    const period1 = 1767225600;
    const period2 = 1769904000;
    const period3 = 1772323200;

    const unrelated = await postWebhook({
      id: 'evt_not_plus',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_other',
          customer: 'cus_other',
          lines: { data: [{ price: { id: 'price_other' } }] },
        },
      },
    });
    expect(unrelated.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(0);

    const unpaid = await postWebhook({
      id: 'evt_plus_unpaid',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_plus_unpaid',
          mode: 'subscription',
          payment_status: 'unpaid',
          metadata: plusMetadata(ada.userId, PRICE_PLUS_MONTHLY),
        },
      },
    });
    expect(unpaid.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(0);

    const checkout = {
      id: 'evt_plus_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_plus',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: ada.userId,
          customer: 'cus_plus',
          subscription: 'sub_plus',
          invoice: 'in_plus_1',
          metadata: plusMetadata(ada.userId, PRICE_PLUS_MONTHLY),
        },
      },
    };
    const started = await postWebhook(checkout);
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ received: true });
    expect(await getBalance(ada.userId)).toBe(100);

    const retry = await postWebhook(checkout);
    expect(retry.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(100);

    const firstInvoice = await postWebhook({
      id: 'evt_plus_invoice_1',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_plus_1',
          customer: 'cus_plus',
          subscription: 'sub_plus',
          period_end: period1,
          metadata: { userId: ada.userId, type: 'plus' },
          lines: {
            data: [{
              price: { id: PRICE_PLUS_MONTHLY },
              period: { end: period1 },
            }],
          },
        },
      },
    });
    expect(firstInvoice.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(100);
    let stored = await User.findById(ada.userId).lean();
    expect(stored.plusActive).toBe(true);
    expect(stored.tier).toBe('plus');
    expect(stored.plusPriceId).toBe(PRICE_PLUS_MONTHLY);
    expect(stored.stripeCustomerId).toBe('cus_plus');
    expect(stored.stripeSubscriptionId).toBe('sub_plus');
    expect(stored.plusCurrentPeriodEnd.getTime()).toBe(period1 * 1000);
    expect(stored.subscribedAt).toBeInstanceOf(Date);
    expect(stored.expiredAt == null).toBe(true);
    const subscribedAt = stored.subscribedAt.toISOString();

    await User.updateOne({ _id: ada.userId }, { $set: { aiCredits: 25 } });
    const renewal = await postWebhook({
      id: 'evt_plus_invoice_2',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_plus_2',
          customer: 'cus_plus',
          subscription: 'sub_plus',
          period_end: period2,
          metadata: { userId: ada.userId, type: 'plus' },
          lines: { data: [{ period: { end: period2 }, price: { id: PRICE_PLUS_MONTHLY } }] },
        },
      },
    });
    expect(renewal.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(100);
    const renewalRetry = await postWebhook({
      id: 'evt_plus_invoice_2',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_plus_2',
          customer: 'cus_plus',
          subscription: 'sub_plus',
          period_end: period2,
          metadata: { userId: ada.userId, type: 'plus' },
        },
      },
    });
    expect(renewalRetry.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(100);
    stored = await User.findById(ada.userId).lean();
    expect(stored.plusCurrentPeriodEnd.getTime()).toBe(period2 * 1000);

    const periodCheckout = await postWebhook({
      id: 'evt_plus_period',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_plus_period',
          mode: 'subscription',
          payment_status: 'paid',
          customer: 'cus_plus',
          subscription: { id: 'sub_plus', current_period_end: period3 },
          metadata: plusMetadata(ada.userId, PRICE_PLUS_MONTHLY),
        },
      },
    });
    expect(periodCheckout.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(100);
    const samePeriod = await postWebhook({
      id: 'evt_plus_invoice_3',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_plus_3',
          customer: 'cus_plus',
          subscription: 'sub_plus',
          period_end: period3,
          metadata: { userId: ada.userId, type: 'plus' },
          lines: { data: [{ period: { end: period3 } }] },
        },
      },
    });
    expect(samePeriod.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(100);
    stored = await User.findById(ada.userId).lean();
    expect(stored.subscribedAt.toISOString()).toBe(subscribedAt);
    expect(stored.plusCurrentPeriodEnd.getTime()).toBe(period3 * 1000);

    const canceled = await postWebhook({
      id: 'evt_plus_canceled',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_plus',
          status: 'canceled',
          customer: 'cus_plus',
          metadata: { userId: ada.userId, type: 'plus' },
        },
      },
    });
    expect(canceled.status).toBe(200);
    stored = await User.findById(ada.userId).lean();
    expect(stored.plusActive).toBe(false);
    expect(stored.tier).toBe('trial');
    expect(await getBalance(ada.userId)).toBe(100);

    await User.updateOne({ _id: ada.userId }, { $set: { plusActive: true } });
    const deleted = await postWebhook({
      id: 'evt_plus_deleted',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_plus',
          status: 'canceled',
          customer: 'cus_plus',
        },
      },
    });
    expect(deleted.status).toBe(200);
    stored = await User.findById(ada.userId).lean();
    expect(stored.plusActive).toBe(false);
    expect(await getBalance(ada.userId)).toBe(100);

    await User.updateOne({ _id: ada.userId }, { $set: { plusActive: true } });
    const unpaidSub = await postWebhook({
      id: 'evt_plus_unpaid_sub',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_plus',
          status: 'unpaid',
          customer: 'cus_plus',
          metadata: { userId: ada.userId, type: 'plus' },
        },
      },
    });
    expect(unpaidSub.status).toBe(200);
    stored = await User.findById(ada.userId).lean();
    expect(stored.plusActive).toBe(false);
    expect(stored.tier).toBe('trial');
    expect(stored.expiredAt).toBeInstanceOf(Date);
    expect(stored.subscribedAt.toISOString()).toBe(subscribedAt);

    const shown = await request(app).get(CREDITS).set(bearer(ada.token));
    expect(shown.body).toEqual({
      aiCredits: 100,
      plusActive: false,
      trialStartedAt: null,
      trialEndsAt: null,
      trialActive: false,
      plansOwned: 0,
      tier: 'trial',
      tierName: 'PlanItVibe (Trial)',
      planCap: 2,
      subscribedAt,
      currentPeriodEnd: new Date(period3 * 1000).toISOString(),
      expiredAt: stored.expiredAt.toISOString(),
    });
  });

  test('tier checkout uses the matching subscription price', async () => {
    const ada = await registerAndLogin('tier-checkout@example.com');
    sessionsCreate().mockResolvedValue({ url: CHECKOUT_URL });
    process.env.STRIPE_PRICE_PLANITVIBE = 'price_planitvibe';
    process.env.STRIPE_PRICE_PLUS = 'price_plus_new';
    process.env.STRIPE_PRICE_PLUS_MONTHLY = 'price_plus_old';
    process.env.STRIPE_PRICE_PRO = 'price_pro';

    const packs = [
      ['planitvibe', 'price_planitvibe', 'planitvibe'],
      ['plus_monthly', 'price_plus_new', 'plus'],
      ['pro', 'price_pro', 'pro'],
    ];
    for (const [pack, price, type] of packs) {
      const response = await request(app)
        .post(CHECKOUT)
        .set(bearer(ada.token))
        .send({ pack });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ url: CHECKOUT_URL });
      const metadata = { userId: ada.userId, type, priceId: price };
      expect(sessionsCreate()).toHaveBeenLastCalledWith({
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        client_reference_id: ada.userId,
        metadata,
        subscription_data: { metadata },
        success_url: 'https://planitvibe.com/?checkout=success',
        cancel_url: 'https://planitvibe.com/?checkout=cancel',
      });
    }
    expect(await getBalance(ada.userId)).toBe(0);
  });

  test('each tier grants its credits once per invoice', async () => {
    process.env.STRIPE_PRICE_PLANITVIBE = 'price_planitvibe';
    process.env.STRIPE_PRICE_PLUS = 'price_plus';
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    const cases = [
      ['planitvibe', 'price_planitvibe', 50, 'planitvibe'],
      ['plus', 'price_plus', 100, 'plus'],
      ['pro', 'price_pro', 300, 'pro'],
    ];
    for (const [tier, price, credits, type] of cases) {
      const ada = await registerAndLogin(`${tier}-grant@example.com`);
      await User.updateOne(
        { _id: ada.userId },
        { $set: { stripeCustomerId: `cus_${tier}`, stripeSubscriptionId: `sub_${tier}` } },
      );
      const periodEnd = 1767225600;
      const invoice = {
        id: `evt_${tier}_invoice`,
        type: 'invoice.paid',
        data: {
          object: {
            id: `in_${tier}_1`,
            customer: `cus_${tier}`,
            subscription: `sub_${tier}`,
            lines: {
              data: [{ price: { id: price }, period: { end: periodEnd } }],
            },
          },
        },
      };
      await User.updateOne({ _id: ada.userId }, { $set: { aiCredits: 40 } });
      const paid = await postWebhook(invoice);
      expect(paid.status).toBe(200);
      expect(await getBalance(ada.userId)).toBe(credits);
      const retry = await postWebhook(invoice);
      expect(retry.status).toBe(200);
      expect(await getBalance(ada.userId)).toBe(credits);

      const checkout = {
        id: `evt_${tier}_checkout`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_${tier}`,
            mode: 'subscription',
            payment_status: 'paid',
            client_reference_id: ada.userId,
            customer: `cus_${tier}`,
            subscription: `sub_${tier}`,
            invoice: `in_${tier}_1`,
            metadata: { userId: ada.userId, type, priceId: price },
          },
        },
      };
      const started = await postWebhook(checkout);
      expect(started.status).toBe(200);
      expect(await getBalance(ada.userId)).toBe(credits);

      const renewal = {
        id: `evt_${tier}_renewal`,
        type: 'invoice.paid',
        data: {
          object: {
            id: `in_${tier}_2`,
            customer: `cus_${tier}`,
            subscription: `sub_${tier}`,
            metadata: { userId: ada.userId, type },
            lines: {
              data: [{ price: { id: price }, period: { end: periodEnd + 86400 } }],
            },
          },
        },
      };
      await User.updateOne({ _id: ada.userId }, { $set: { aiCredits: 7 } });
      const renewed = await postWebhook(renewal);
      expect(renewed.status).toBe(200);
      expect(await getBalance(ada.userId)).toBe(credits);
      const renewalRetry = await postWebhook(renewal);
      expect(renewalRetry.status).toBe(200);
      expect(await getBalance(ada.userId)).toBe(credits);

      const stored = await User.findById(ada.userId).lean();
      expect(stored.tier).toBe(tier);
      expect(stored.plusActive).toBe(true);
      expect(stored.stripeSubscriptionId).toBe(`sub_${tier}`);
    }
  });

  test('a completed checkout for a lower tier switches that subscription', async () => {
    process.env.STRIPE_PRICE_PLUS_MONTHLY = PRICE_PLUS_MONTHLY;
    process.env.STRIPE_PRICE_PLANITVIBE = 'price_planitvibe';
    const ada = await registerAndLogin('downgrade-checkout@example.com');
    const plus = await postWebhook({
      id: 'evt_down_plus',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_down_plus',
          mode: 'subscription',
          payment_status: 'paid',
          customer: 'cus_down',
          subscription: 'sub_plus_down',
          metadata: plusMetadata(ada.userId, PRICE_PLUS_MONTHLY),
        },
      },
    });
    expect(plus.status).toBe(200);
    const started = await User.findById(ada.userId).lean();
    expect(started.tier).toBe('plus');
    expect(started.subscribedAt).toBeInstanceOf(Date);

    const lower = await postWebhook({
      id: 'evt_down_base',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_down_base',
          mode: 'subscription',
          payment_status: 'paid',
          customer: 'cus_down',
          subscription: 'sub_base_down',
          metadata: {
            userId: ada.userId,
            type: 'planitvibe',
            priceId: 'price_planitvibe',
          },
        },
      },
    });
    expect(lower.status).toBe(200);
    const stored = await User.findById(ada.userId).lean();
    expect(stored.tier).toBe('planitvibe');
    expect(stored.stripeSubscriptionId).toBe('sub_base_down');
    expect(stored.subscribedAt).toBeInstanceOf(Date);
    expect(stored.expiredAt == null).toBe(true);
    const shown = await request(app).get(CREDITS).set(bearer(ada.token));
    expect(shown.status).toBe(200);
    expect(shown.body.tier).toBe('planitvibe');
    expect(shown.body.subscribedAt).toBe(stored.subscribedAt.toISOString());
    expect(shown.body.currentPeriodEnd).toBeNull();
    expect(shown.body.expiredAt).toBeNull();
  });
});
