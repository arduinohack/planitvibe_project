jest.mock('axios', () => ({
  post: jest.fn(),
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
const AiUsage = require('../models/AiUsage');
const { getBalance } = require('../utils/aiCredits');
const { SEARCH_URL, FIELD_MASK, ID_FIELD_MASK } = require('../utils/placeAutocomplete');

jest.setTimeout(30000);

let mongo;
const previousKey = process.env.GOOGLE_MAPS_API_KEY;
const previousSecret = process.env.AI_KEY_ENCRYPTION_SECRET;
const PLACE_ID = 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8';
const SECRET = '0123456789abcdef0123456789abcdef';
const USER_KEY = 'user-xai-key-9f3c2a7b-do-not-echo';

const PRO_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.timeZone',
].join(',');

function googleOk() {
  return {
    status: 200,
    data: {
      places: [
        {
          id: PLACE_ID,
          displayName: { text: 'Cafe Paris' },
          formattedAddress: 'Paris, France',
          location: { latitude: 48.86, longitude: 2.35 },
          timeZone: { id: 'Europe/Paris' },
        },
        {
          id: 'blank-zone-place',
          displayName: { text: 'Blank Zone' },
          formattedAddress: 'Somewhere',
          timeZone: { id: '   ' },
        },
        {
          id: '   ',
          displayName: { text: 'Skipped' },
        },
      ],
    },
  };
}

async function registerAndLogin({ firstName, lastName, email }) {
  await allowRegister(email);
  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({ firstName, lastName, email, password: 'password1' });
  await clearRegisterInvite(email);
  expect(registerRes.status).toBe(201);
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'password1' });
  expect(loginRes.status).toBe(200);
  return {
    token: loginRes.body.token,
    userId: loginRes.body.user._id,
  };
}

async function createPlan(token) {
  const res = await request(app)
    .post('/api/plans')
    .set('Authorization', `Bearer ${token}`)
    .send({
      type: 'trip',
      name: 'Paris',
      destination: 'Paris',
      timeZone: 'UTC',
    });
  expect(res.status).toBe(201);
  return res.body.plan._id;
}

async function acceptRole(ownerToken, memberToken, planId, email, role) {
  const inviteRes = await request(app)
    .post(`/api/plans/${planId}/invite`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email, role });
  expect(inviteRes.status).toBe(201);
  const acceptRes = await request(app)
    .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
    .set('Authorization', `Bearer ${memberToken}`)
    .send({ status: 'accepted' });
  expect(acceptRes.status).toBe(200);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

async function setCredits(userId, amount) {
  await User.updateOne(
    { _id: userId },
    { $set: { aiCredits: amount, monthlyCredits: amount, purchasedCredits: 0 } },
  );
}

afterEach(async () => {
  axios.post.mockReset();
  if (previousKey == null) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previousKey;
  if (previousSecret == null) delete process.env.AI_KEY_ENCRYPTION_SECRET;
  else process.env.AI_KEY_ENCRYPTION_SECRET = previousSecret;
  await Promise.all([
    User.deleteMany({}),
    Plan.deleteMany({}),
    PlanUser.deleteMany({}),
    Invitation.deleteMany({}),
    AiUsage.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (previousKey == null) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previousKey;
  if (previousSecret == null) delete process.env.AI_KEY_ENCRYPTION_SECRET;
  else process.env.AI_KEY_ENCRYPTION_SECRET = previousSecret;
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('GET /api/places/autocomplete', () => {
  test('text search returns the place id and time zone', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    axios.post.mockResolvedValue(googleOk());
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-places@example.com',
    });
    await createPlan(ada.token);
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace-places@example.com',
    });
    const planId = await createPlan(ada.token);
    await acceptRole(
      ada.token,
      grace.token,
      planId,
      'grace-places@example.com',
      'Collaborator',
    );
    await setCredits(grace.userId, 2);

    const found = await request(app)
      .get('/api/places/autocomplete')
      .query({ q: 'Cafe Paris' })
      .set('Authorization', `Bearer ${grace.token}`);

    expect(found.status).toBe(200);
    expect(found.body).toEqual([
      {
        googlePlaceId: PLACE_ID,
        name: 'Cafe Paris',
        address: 'Paris, France',
        timeZone: 'Europe/Paris',
      },
      {
        googlePlaceId: 'blank-zone-place',
        name: 'Blank Zone',
        address: 'Somewhere',
        timeZone: null,
      },
    ]);
    expect(JSON.stringify(found.body)).not.toMatch(/rating|userRatingCount|priceLevel|latitude/);
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe(SEARCH_URL);
    expect(body).toEqual({ textQuery: 'Cafe Paris', pageSize: 5 });
    expect(options.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(FIELD_MASK).toBe(PRO_FIELD_MASK);
    expect(options.headers['X-Goog-FieldMask']).toBe(PRO_FIELD_MASK);
    expect(FIELD_MASK).not.toMatch(/rating|userRatingCount|priceLevel/);
    expect(url).not.toContain('test-key');
    expect(JSON.stringify(body)).not.toContain('test-key');
    expect(JSON.stringify(found.body)).not.toContain('test-key');
    expect(await getBalance(grace.userId)).toBe(2);
    expect(await AiUsage.countDocuments({ feature: 'placeSearch' })).toBe(0);
  });

  test('a zero balance uses the ID-only mask and does not deduct', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        places: [
          {
            id: PLACE_ID,
            displayName: { text: 'Cafe Paris' },
            formattedAddress: 'Paris, France',
            timeZone: { id: 'Europe/Paris' },
          },
        ],
      },
    });
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-zero-places@example.com',
    });
    await createPlan(ada.token);
    await setCredits(ada.userId, 0);

    const found = await request(app)
      .get('/api/places/autocomplete')
      .query({ q: 'Cafe Paris' })
      .set('Authorization', `Bearer ${ada.token}`);

    expect(found.status).toBe(200);
    expect(found.body).toEqual({
      message: 'Insufficient AI credits',
      places: [{ googlePlaceId: PLACE_ID }],
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe(SEARCH_URL);
    expect(body).toEqual({ textQuery: 'Cafe Paris', pageSize: 5 });
    expect(ID_FIELD_MASK).toBe('places.id');
    expect(options.headers['X-Goog-FieldMask']).toBe(ID_FIELD_MASK);
    expect(options.headers['X-Goog-FieldMask']).not.toMatch(
      /displayName|formattedAddress|location|timeZone|rating|userRatingCount|priceLevel/,
    );
    expect(await getBalance(ada.userId)).toBe(0);
    expect(await AiUsage.countDocuments({ feature: 'placeSearch' })).toBe(0);
  });

  test('a user-owned key stays on Pro and does not change the balance', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    process.env.AI_KEY_ENCRYPTION_SECRET = SECRET;
    axios.post.mockResolvedValue(googleOk());
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-own-key-places@example.com',
    });
    await createPlan(ada.token);
    await setCredits(ada.userId, 0);
    const saved = await request(app)
      .put('/api/users/me/ai-settings')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ aiProvider: 'xai', apiKey: USER_KEY });
    expect(saved.status).toBe(200);

    const found = await request(app)
      .get('/api/places/autocomplete')
      .query({ q: 'Cafe Paris' })
      .set('Authorization', `Bearer ${ada.token}`);

    expect(found.status).toBe(200);
    expect(found.body[0]).toEqual({
      googlePlaceId: PLACE_ID,
      name: 'Cafe Paris',
      address: 'Paris, France',
      timeZone: 'Europe/Paris',
    });
    const options = axios.post.mock.calls[0][2];
    expect(options.headers['X-Goog-FieldMask']).toBe(PRO_FIELD_MASK);
    expect(await getBalance(ada.userId)).toBe(0);
    expect(await AiUsage.countDocuments({ feature: 'placeSearch' })).toBe(0);
  });

  test('a missing key returns a clear error and does not call Google', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-nokey@example.com',
    });
    await createPlan(ada.token);

    const missing = await request(app)
      .get('/api/places/autocomplete')
      .query({ q: 'Cafe' })
      .set('Authorization', `Bearer ${ada.token}`);

    expect(missing.status).toBe(503);
    expect(missing.body.message).toBe('Google Maps is not configured');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a guest cannot search places', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-guest-places@example.com',
    });
    const planId = await createPlan(ada.token);
    const gus = await registerAndLogin({
      firstName: 'Gus',
      lastName: 'Guest',
      email: 'gus-places@example.com',
    });
    await acceptRole(ada.token, gus.token, planId, 'gus-places@example.com', 'Guest');

    const denied = await request(app)
      .get('/api/places/autocomplete')
      .query({ q: 'Cafe' })
      .set('Authorization', `Bearer ${gus.token}`);

    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Only Owner or Collaborator can search places');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('no token is 401', async () => {
    const missing = await request(app)
      .get('/api/places/autocomplete')
      .query({ q: 'Cafe' });

    expect(missing.status).toBe(401);
    expect(missing.body.message).toBe('No token, authorization denied');
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('POST /api/places/select', () => {
  test('selecting a place deducts 0.5 and records placeSearch', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-select@example.com',
    });
    await createPlan(ada.token);
    await setCredits(ada.userId, 0.5);

    const selected = await request(app)
      .post('/api/places/select')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ googlePlaceId: PLACE_ID, query: 'Cafe Paris' });

    expect(selected.status).toBe(200);
    expect(selected.body).toEqual({ ok: true });
    expect(await getBalance(ada.userId)).toBe(0);
    const rows = await AiUsage.find({ feature: 'placeSearch' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(true);
    expect(rows[0].usedUserKey).toBe(false);
    expect(rows[0].credits).toBe(0.5);
    expect(rows[0].provider).toBe('google');

    const listed = await request(app)
      .get('/api/users/me/ai-usage')
      .set('Authorization', `Bearer ${ada.token}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        createdAt: rows[0].createdAt.toISOString(),
        feature: 'placeSearch',
        creditCost: 0.5,
        success: true,
      },
    ]);
  });

  test('a balance under 0.5 is 402 and does not deduct', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-select-short@example.com',
    });
    await createPlan(ada.token);
    await setCredits(ada.userId, 0.4);

    const denied = await request(app)
      .post('/api/places/select')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ googlePlaceId: PLACE_ID, query: 'Cafe Paris' });

    expect(denied.status).toBe(402);
    expect(denied.body).toEqual({ message: 'Insufficient AI credits' });
    expect(await getBalance(ada.userId)).toBe(0.4);
    expect(await AiUsage.countDocuments({ feature: 'placeSearch' })).toBe(0);
  });

  test('a user-owned key selects without changing the balance', async () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = SECRET;
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-select-key@example.com',
    });
    await createPlan(ada.token);
    await setCredits(ada.userId, 0);
    const saved = await request(app)
      .put('/api/users/me/ai-settings')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ aiProvider: 'xai', apiKey: USER_KEY });
    expect(saved.status).toBe(200);

    const selected = await request(app)
      .post('/api/places/select')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ googlePlaceId: PLACE_ID, query: 'Cafe Paris' });

    expect(selected.status).toBe(200);
    expect(await getBalance(ada.userId)).toBe(0);
    const rows = await AiUsage.find({ feature: 'placeSearch' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].usedUserKey).toBe(true);
    expect(rows[0].success).toBe(true);
    expect(rows[0].credits == null).toBe(true);

    const listed = await request(app)
      .get('/api/users/me/ai-usage')
      .set('Authorization', `Bearer ${ada.token}`);
    expect(listed.body[0].creditCost).toBe(0);
  });
});
