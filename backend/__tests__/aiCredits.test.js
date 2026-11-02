jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

const request = require('supertest');
const mongoose = require('mongoose');
const axios = require('axios');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const { allowRegister, clearRegisterInvite } = require('./inviteForRegister');
const User = require('../models/User');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const Invitation = require('../models/Invitation');
const { Event } = require('../models/Event');
const AiUsage = require('../models/AiUsage');
const { add, deduct, getBalance } = require('../utils/aiCredits');
const { SEARCH_URL, XAI_ENDPOINT } = require('../utils/placeSuggest');

jest.setTimeout(30000);

const SECRET = '0123456789abcdef0123456789abcdef';
const USER_KEY = 'user-xai-key-9f3c2a7b-do-not-echo';
const SERVER_KEY = 'server-xai-key-should-be-fallback';
const PLACE_ID = 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8';
const CREDITS = '/api/users/me/ai-credits';
const PASTE_TEXT = [
  'Confirmation: CONF-88',
  'From: JFK',
  'To: LAX',
  'Departure: 2026-07-02 08:15',
  'Arrival: 2026-07-02 11:40',
].join('\n');

let mongo;
const previousXai = process.env.XAI_API_KEY;
const previousSecret = process.env.AI_KEY_ENCRYPTION_SECRET;
const previousGoogle = process.env.GOOGLE_MAPS_API_KEY;

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function modelPayload(fields) {
  return {
    status: 200,
    data: {
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(fields) }],
        },
      ],
    },
  };
}

function suggestPayload() {
  return {
    status: 200,
    data: {
      output_text: JSON.stringify({
        textQuery: 'small cafe in Paris',
        summaries: [{ placeId: PLACE_ID, summary: 'A small cafe in Paris.' }],
      }),
    },
  };
}

function googleOk() {
  return {
    status: 200,
    data: {
      places: [
        {
          id: PLACE_ID,
          displayName: { text: 'Cafe Paris' },
          formattedAddress: 'Paris, France',
        },
      ],
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

async function createPlan(token) {
  const res = await request(app)
    .post('/api/plans')
    .set(bearer(token))
    .send({
      type: 'trip',
      name: 'Paris trip',
      destination: 'Paris',
      timeZone: 'UTC',
    });
  expect(res.status).toBe(201);
  return res.body.plan._id;
}

async function setCredits(userId, aiCredits) {
  await User.updateOne(
    { _id: userId },
    { $set: { aiCredits, monthlyCredits: aiCredits, purchasedCredits: 0 } },
  );
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(() => {
  process.env.AI_KEY_ENCRYPTION_SECRET = SECRET;
  delete process.env.XAI_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  axios.post.mockReset();
  axios.get.mockReset();
});

afterEach(async () => {
  if (previousXai == null) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = previousXai;
  if (previousSecret == null) delete process.env.AI_KEY_ENCRYPTION_SECRET;
  else process.env.AI_KEY_ENCRYPTION_SECRET = previousSecret;
  if (previousGoogle == null) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previousGoogle;
  await Promise.all([
    User.deleteMany({}),
    Plan.deleteMany({}),
    PlanUser.deleteMany({}),
    Invitation.deleteMany({}),
    Event.deleteMany({}),
    AiUsage.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (previousXai == null) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = previousXai;
  if (previousSecret == null) delete process.env.AI_KEY_ENCRYPTION_SECRET;
  else process.env.AI_KEY_ENCRYPTION_SECRET = previousSecret;
  if (previousGoogle == null) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previousGoogle;
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('AI credits', () => {
  test('a new user starts at 0 and GET returns that balance', async () => {
    const ada = await registerAndLogin('ada-credits-zero@example.com');
    const stored = await User.findById(ada.userId).select('aiCredits').lean();
    expect(stored.aiCredits).toBe(0);

    const balance = await request(app).get(CREDITS).set(bearer(ada.token));
    expect(balance.status).toBe(200);
    expect(balance.body).toEqual({
      aiCredits: 0,
      monthlyCredits: 0,
      purchasedCredits: 0,
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

    const missing = await request(app).get(CREDITS);
    expect(missing.status).toBe(401);
    expect(missing.body.message).toBe('No token, authorization denied');
  });

  test('deduct lowers the balance and refuses to go negative', async () => {
    const ada = await registerAndLogin('ada-credits-deduct@example.com');
    await setCredits(ada.userId, 2);

    const first = await deduct(ada.userId, 1);
    expect(first.ok).toBe(true);
    expect(first.aiCredits).toBe(1);
    expect(await getBalance(ada.userId)).toBe(1);

    const second = await deduct(ada.userId, 1);
    expect(second.ok).toBe(true);
    expect(second.aiCredits).toBe(0);

    const third = await deduct(ada.userId, 1);
    expect(third.ok).toBe(false);
    expect(await getBalance(ada.userId)).toBe(0);
  });

  test('calls spend monthly credits before purchased credits', async () => {
    const ada = await registerAndLogin('ada-credits-split@example.com');
    await User.updateOne(
      { _id: ada.userId },
      { $set: { monthlyCredits: 1, purchasedCredits: 2, aiCredits: 3 } },
    );

    const places = await deduct(ada.userId, 0.5);
    expect(places.ok).toBe(true);
    expect(places.aiCredits).toBe(2.5);
    let stored = await User.findById(ada.userId)
      .select('monthlyCredits purchasedCredits aiCredits')
      .lean();
    expect(stored.monthlyCredits).toBe(0.5);
    expect(stored.purchasedCredits).toBe(2);

    const across = await deduct(ada.userId, 1);
    expect(across.ok).toBe(true);
    expect(across.aiCredits).toBe(1.5);
    stored = await User.findById(ada.userId)
      .select('monthlyCredits purchasedCredits')
      .lean();
    expect(stored.monthlyCredits).toBe(0);
    expect(stored.purchasedCredits).toBe(1.5);

    const short = await deduct(ada.userId, 2);
    expect(short.ok).toBe(false);
    expect(short.aiCredits).toBe(1.5);
    stored = await User.findById(ada.userId)
      .select('monthlyCredits purchasedCredits')
      .lean();
    expect(stored.monthlyCredits).toBe(0);
    expect(stored.purchasedCredits).toBe(1.5);

    const shown = await request(app).get(CREDITS).set(bearer(ada.token));
    expect(shown.status).toBe(200);
    expect(shown.body.monthlyCredits).toBe(0);
    expect(shown.body.purchasedCredits).toBe(1.5);
    expect(shown.body.aiCredits).toBe(1.5);
  });

  test('deduct and add accept a half credit', async () => {
    const ada = await registerAndLogin('ada-credits-half@example.com');
    expect(await add(ada.userId, 0.5)).toBe(0.5);
    const paid = await deduct(ada.userId, 0.5);
    expect(paid.ok).toBe(true);
    expect(paid.aiCredits).toBe(0);
    expect(await getBalance(ada.userId)).toBe(0);
    const short = await deduct(ada.userId, 0.5);
    expect(short.ok).toBe(false);
  });

  test('an admin grant increases the balance and a member cannot grant', async () => {
    const ada = await registerAndLogin('ada-credits-grant@example.com');
    const admin = await registerAndLogin('admin-credits@example.com');
    await User.updateOne({ _id: admin.userId }, { $set: { role: 'admin' } });

    const denied = await request(app)
      .post(`/api/admin/users/${ada.userId}/ai-credits`)
      .set(bearer(ada.token))
      .send({ amount: 5 });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Admin access required');
    expect(await getBalance(ada.userId)).toBe(0);

    const granted = await request(app)
      .post(`/api/admin/users/${ada.userId}/ai-credits`)
      .set(bearer(admin.token))
      .send({ amount: 4 });
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ aiCredits: 4 });

    const again = await request(app)
      .post(`/api/admin/users/${ada.userId}/ai-credits`)
      .set(bearer(admin.token))
      .send({ amount: 1 });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ aiCredits: 5 });

    const balance = await request(app).get(CREDITS).set(bearer(ada.token));
    expect(balance.body).toEqual({
      aiCredits: 5,
      monthlyCredits: 0,
      purchasedCredits: 5,
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
    expect(await getBalance(admin.userId)).toBe(0);

    const zero = await request(app)
      .post(`/api/admin/users/${ada.userId}/ai-credits`)
      .set(bearer(admin.token))
      .send({ amount: 0 });
    expect(zero.status).toBe(400);
    expect(zero.body.message).toBe('Amount must be a positive number');

    const text = await request(app)
      .post(`/api/admin/users/${ada.userId}/ai-credits`)
      .set(bearer(admin.token))
      .send({ amount: '4' });
    expect(text.status).toBe(400);

    const missing = await request(app)
      .post('/api/admin/users/missing-user/ai-credits')
      .set(bearer(admin.token))
      .send({ amount: 1 });
    expect(missing.status).toBe(404);
    expect(await getBalance(ada.userId)).toBe(5);
  });

  test('a server-key paste deducts 1 and a zero balance returns 402 without calling the model', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const ada = await registerAndLogin('ada-credits-paste@example.com');
    await createPlan(ada.token);
    await setCredits(ada.userId, 1);
    axios.post.mockResolvedValue(modelPayload({
      bookingReference: 'ABC123',
      confirmation: 'CONF-88',
      origin: 'JFK',
      destination: 'LAX',
      start: '2026-07-02T08:15',
      end: '2026-07-02T11:40',
    }));

    const parsed = await request(app)
      .post('/api/activities/parse-confirmation')
      .set(bearer(ada.token))
      .send({ text: PASTE_TEXT, type: 'flight' });

    expect(parsed.status).toBe(200);
    expect(parsed.body.confirmation).toBe('CONF-88');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe(`Bearer ${SERVER_KEY}`);
    expect(await getBalance(ada.userId)).toBe(0);
    expect(await AiUsage.countDocuments({ feature: 'paste', success: true })).toBe(1);

    axios.post.mockClear();
    const blocked = await request(app)
      .post('/api/activities/parse-confirmation')
      .set(bearer(ada.token))
      .send({ text: PASTE_TEXT, type: 'flight' });

    expect(blocked.status).toBe(402);
    expect(blocked.body.message).toBe('Insufficient AI credits');
    expect(blocked.body.bookingReference).toBe('CONF-88');
    expect(blocked.body.origin).toBe('JFK');
    expect(axios.post).not.toHaveBeenCalled();
    expect(await getBalance(ada.userId)).toBe(0);
    const rows = await AiUsage.find({ success: false }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].feature).toBe('paste');
    expect(rows[0].provider).toBe('server');
    expect(rows[0].usedUserKey).toBe(false);
    expect(rows[0].error).toBe('Insufficient AI credits');
  });

  test('a user key does not deduct credits', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const ada = await registerAndLogin('ada-credits-userkey@example.com');
    await createPlan(ada.token);
    await setCredits(ada.userId, 4);
    await request(app)
      .put('/api/users/me/ai-settings')
      .set(bearer(ada.token))
      .send({ aiProvider: 'xai', apiKey: USER_KEY });
    axios.post.mockResolvedValue(modelPayload({
      confirmation: 'CONF-88',
      origin: 'JFK',
      destination: 'LAX',
      start: '2026-07-02T08:15',
      end: '2026-07-02T11:40',
    }));

    const parsed = await request(app)
      .post('/api/activities/parse-confirmation')
      .set(bearer(ada.token))
      .send({ text: PASTE_TEXT, type: 'flight' });

    expect(parsed.status).toBe(200);
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe(`Bearer ${USER_KEY}`);
    expect(await getBalance(ada.userId)).toBe(4);
  });

  test('server-key suggest deducts 1, and a zero balance still returns places', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    process.env.GOOGLE_MAPS_API_KEY = 'maps-key';
    axios.get.mockResolvedValue({ status: 200, data: { results: [] } });
    axios.post.mockImplementation(async (url) => {
      if (url === SEARCH_URL) return googleOk();
      return suggestPayload();
    });
    const ada = await registerAndLogin('ada-credits-suggest@example.com');
    const planId = await createPlan(ada.token);
    await setCredits(ada.userId, 2);

    const found = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set(bearer(ada.token))
      .send({ query: 'cafe' });

    expect(found.status).toBe(200);
    expect(Array.isArray(found.body)).toBe(true);
    expect(found.body[0].summary).toBe('A small cafe in Paris.');
    expect(await getBalance(ada.userId)).toBe(0.5);
    const placesCharge = await AiUsage.findOne({ provider: 'google' }).lean();
    expect(placesCharge.feature).toBe('suggest');
    expect(placesCharge.credits).toBe(0.5);
    expect(placesCharge.success).toBe(true);
    expect(await AiUsage.countDocuments({ feature: 'suggest', provider: 'server', success: true })).toBeGreaterThan(0);

    await setCredits(ada.userId, 0);
    await AiUsage.deleteMany({});
    axios.post.mockClear();
    axios.get.mockClear();

    const blocked = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set(bearer(ada.token))
      .send({ query: 'museum' });

    expect(blocked.status).toBe(402);
    expect(blocked.body.message).toBe('Insufficient AI credits');
    expect(blocked.body.places).toEqual([]);
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(await getBalance(ada.userId)).toBe(0);
    const rows = await AiUsage.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].feature).toBe('suggest');
    expect(rows[0].provider).toBe('google');
    expect(rows[0].credits).toBe(0.5);
    expect(rows[0].usedUserKey).toBe(false);
    expect(rows[0].success).toBe(false);
    expect(rows[0].error).toBe('Insufficient AI credits');
    expect(rows[0].planId).toBe(planId);
  });

  test('a balance of 0.5 pays for Places and 0.4 does not call Places', async () => {
    delete process.env.XAI_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = 'maps-key';
    axios.get.mockResolvedValue({ status: 200, data: { results: [] } });
    axios.post.mockResolvedValue(googleOk());
    const ada = await registerAndLogin('ada-credits-places@example.com');
    const planId = await createPlan(ada.token);
    await setCredits(ada.userId, 0.5);

    const found = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set(bearer(ada.token))
      .send({ query: 'cafe' });

    expect(found.status).toBe(200);
    expect(found.body[0].placeId).toBe(PLACE_ID);
    expect(found.body[0].name).toBe('Cafe Paris');
    expect(await getBalance(ada.userId)).toBe(0);
    expect(axios.post.mock.calls.some((call) => call[0] === SEARCH_URL)).toBe(true);
    const charged = await AiUsage.find({ provider: 'google' }).lean();
    expect(charged).toHaveLength(1);
    expect(charged[0].feature).toBe('suggest');
    expect(charged[0].credits).toBe(0.5);
    expect(charged[0].success).toBe(true);

    await setCredits(ada.userId, 0.4);
    await AiUsage.deleteMany({});
    axios.post.mockClear();

    const blocked = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set(bearer(ada.token))
      .send({ query: 'museum' });

    expect(blocked.status).toBe(402);
    expect(blocked.body.message).toBe('Insufficient AI credits');
    expect(axios.post).not.toHaveBeenCalled();
    expect(await getBalance(ada.userId)).toBe(0.4);
  });
});
