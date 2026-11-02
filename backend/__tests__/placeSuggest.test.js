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
const { getBalance } = require('../utils/aiCredits');
const {
  SEARCH_URL,
  FIELD_MASK,
  XAI_ENDPOINT,
  suggestPlaces,
  clearSuggestCache,
  expireSuggestCache,
} = require('../utils/placeSuggest');

jest.setTimeout(30000);

let mongo;
const previousKey = process.env.GOOGLE_MAPS_API_KEY;
const previousXai = process.env.XAI_API_KEY;
const PLACE_ID = 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8';

function placeRow(id, name) {
  return {
    id,
    displayName: { text: name },
    formattedAddress: 'Paris, France',
  };
}

function googleOk(places) {
  return {
    status: 200,
    data: { places: places || [placeRow(PLACE_ID, 'Cafe Paris')] },
  };
}

function modelReply(payload) {
  return {
    status: 200,
    data: { output_text: JSON.stringify(payload) },
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
  const userId = loginRes.body.user._id;
  await User.updateOne({ _id: userId }, { $set: { aiCredits: 20 } });
  return {
    token: loginRes.body.token,
    userId,
  };
}

async function createPlan(token, destination = 'Paris') {
  const res = await request(app)
    .post('/api/plans')
    .set('Authorization', `Bearer ${token}`)
    .send({
      type: 'trip',
      name: 'Paris trip',
      destination,
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

function googleCall() {
  return axios.post.mock.calls.find((call) => call[0] === SEARCH_URL);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

function placesCalls() {
  return axios.post.mock.calls.filter((call) => call[0] === SEARCH_URL);
}

afterEach(async () => {
  clearSuggestCache();
  axios.post.mockReset();
  axios.get.mockReset();
  if (previousKey == null) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previousKey;
  if (previousXai == null) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = previousXai;
  await Promise.all([
    User.deleteMany({}),
    Plan.deleteMany({}),
    PlanUser.deleteMany({}),
    Invitation.deleteMany({}),
    Event.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (previousKey == null) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previousKey;
  if (previousXai == null) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = previousXai;
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('POST /api/plans/:planId/suggest', () => {
  test('an owner gets places and nothing is written', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    delete process.env.XAI_API_KEY;
    axios.get.mockResolvedValue({ status: 200, data: { results: [] } });
    axios.post.mockResolvedValue(googleOk());
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest@example.com',
    });
    const planId = await createPlan(ada.token);
    const before = await Event.countDocuments({ planId });

    const found = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'quiet cafe', activityType: 'dining' });

    expect(found.status).toBe(200);
    expect(found.body).toEqual([
      {
        placeId: PLACE_ID,
        name: 'Cafe Paris',
        address: 'Paris, France',
      },
    ]);
    expect(found.body[0].summary).toBeUndefined();
    const call = googleCall();
    expect(call).toBeTruthy();
    expect(call[1].textQuery).toBe('quiet cafe in Paris');
    expect(call[1].includedType).toBe('restaurant');
    expect(call[1].pageSize).toBe(8);
    expect(call[1].locationBias).toBeUndefined();
    expect(call[2].headers['X-Goog-Api-Key']).toBe('test-key');
    expect(FIELD_MASK).toBe('places.id,places.displayName,places.formattedAddress');
    expect(call[2].headers['X-Goog-FieldMask']).toBe(FIELD_MASK);
    expect(JSON.stringify(call[1])).not.toContain('test-key');
    expect(JSON.stringify(found.body)).not.toContain('test-key');
    expect(axios.post.mock.calls.every((item) => item[0] !== XAI_ENDPOINT)).toBe(true);
    expect(await Event.countDocuments({ planId })).toBe(before);
    const plan = await Plan.findById(planId).lean();
    expect(plan.destination).toBe('Paris');
  });

  test('a supplied location is used instead of the plan destination', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    delete process.env.XAI_API_KEY;
    axios.get.mockResolvedValue({
      status: 200,
      data: {
        results: [{ geometry: { location: { lat: 41.9, lng: 12.5 } } }],
      },
    });
    axios.post.mockResolvedValue(googleOk());
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-loc@example.com',
    });
    const planId = await createPlan(ada.token);

    const found = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'museum', location: 'Rome' });

    expect(found.status).toBe(200);
    const call = googleCall();
    expect(call[1].textQuery).toBe('museum in Rome');
    expect(call[1].locationBias).toEqual({
      circle: {
        center: { latitude: 41.9, longitude: 12.5 },
        radius: 20000,
      },
    });
  });

  test('a collaborator can suggest places', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    delete process.env.XAI_API_KEY;
    axios.get.mockResolvedValue({ status: 200, data: { results: [] } });
    axios.post.mockResolvedValue(googleOk());
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-collab@example.com',
    });
    const planId = await createPlan(ada.token);
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace-suggest@example.com',
    });
    await acceptRole(
      ada.token,
      grace.token,
      planId,
      'grace-suggest@example.com',
      'Collaborator',
    );

    const found = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ query: 'cafe' });

    expect(found.status).toBe(200);
    expect(found.body[0].placeId).toBe(PLACE_ID);
  });

  test('results stop at 8', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    delete process.env.XAI_API_KEY;
    axios.get.mockResolvedValue({ status: 200, data: { results: [] } });
    const many = [];
    for (let index = 0; index < 9; index += 1) {
      many.push(placeRow(`place-${index}`, `Cafe ${index}`));
    }
    axios.post.mockResolvedValue(googleOk(many));
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-max@example.com',
    });
    const planId = await createPlan(ada.token);

    const found = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'cafe' });

    expect(found.status).toBe(200);
    expect(found.body).toHaveLength(8);
    expect(found.body[0].placeId).toBe('place-0');
    expect(found.body[7].placeId).toBe('place-7');
  });

  test('a missing Places key returns a clear error', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.XAI_API_KEY;
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-nokey@example.com',
    });
    const planId = await createPlan(ada.token);

    const missing = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'cafe' });

    expect(missing.status).toBe(503);
    expect(missing.body.message).toBe('Google Maps is not configured');
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('a missing xAI key still returns Places results', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    delete process.env.XAI_API_KEY;
    axios.get.mockResolvedValue({ status: 200, data: { results: [] } });
    axios.post.mockResolvedValue(googleOk());
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-noxai@example.com',
    });
    const planId = await createPlan(ada.token);

    const found = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'cafe' });

    expect(found.status).toBe(200);
    expect(found.body[0].name).toBe('Cafe Paris');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][0]).toBe(SEARCH_URL);
  });

  test('xAI can clean the query and add a summary, and a model failure still returns places', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    process.env.XAI_API_KEY = 'xai-test';
    axios.get.mockResolvedValue({ status: 200, data: { results: [] } });
    axios.post.mockImplementation(async (url) => {
      if (url === XAI_ENDPOINT) {
        return modelReply({
          textQuery: 'small cafe in Paris',
          summaries: [{ placeId: PLACE_ID, summary: 'A small cafe in Paris.' }],
        });
      }
      return googleOk();
    });
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-xai@example.com',
    });
    const planId = await createPlan(ada.token);

    const found = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'somewhere quiet for coffee' });

    expect(found.status).toBe(200);
    expect(found.body[0].summary).toBe('A small cafe in Paris.');
    expect(googleCall()[1].textQuery).toBe('small cafe in Paris');

    axios.post.mockReset();
    axios.post.mockImplementation(async (url) => {
      if (url === XAI_ENDPOINT) {
        const error = new Error('model down');
        throw error;
      }
      return googleOk();
    });
    const again = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'cafe' });

    expect(again.status).toBe(200);
    expect(again.body[0].placeId).toBe(PLACE_ID);
    expect(again.body[0].summary).toBeUndefined();
  });

  test('a guest is forbidden', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-guest@example.com',
    });
    const planId = await createPlan(ada.token);
    const gus = await registerAndLogin({
      firstName: 'Gus',
      lastName: 'Guest',
      email: 'gus-suggest@example.com',
    });
    await acceptRole(ada.token, gus.token, planId, 'gus-suggest@example.com', 'Guest');

    const denied = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${gus.token}`)
      .send({ query: 'cafe' });

    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Only Owner or Collaborator can suggest places');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('no token is 401 and a blank query is 400', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-blank@example.com',
    });
    const planId = await createPlan(ada.token);

    const missing = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .send({ query: 'cafe' });
    expect(missing.status).toBe(401);

    const blank = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.message).toBe('Query is required');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('an identical suggest within 5 minutes skips Google and still costs 0.5', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    delete process.env.XAI_API_KEY;
    axios.get.mockResolvedValue({ status: 200, data: { results: [] } });
    axios.post.mockResolvedValue(googleOk());
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-suggest-cache@example.com',
    });
    const planId = await createPlan(ada.token);
    await User.updateOne(
      { _id: ada.userId },
      { $set: { aiCredits: 20, monthlyCredits: 20, purchasedCredits: 0 } },
    );
    const body = { query: 'quiet cafe', activityType: 'dining', location: 'Paris' };

    const first = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send(body);

    expect(first.status).toBe(200);
    expect(first.body[0].placeId).toBe(PLACE_ID);
    expect(placesCalls()).toHaveLength(1);
    expect(await getBalance(ada.userId)).toBe(19.5);
    expect(await AiUsage.countDocuments({
      userId: ada.userId,
      provider: 'google',
      credits: 0.5,
    })).toBe(1);

    axios.post.mockClear();
    axios.get.mockClear();
    const again = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send(body);

    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(await getBalance(ada.userId)).toBe(19);
    expect(await AiUsage.countDocuments({
      userId: ada.userId,
      provider: 'google',
      credits: 0.5,
    })).toBe(2);

    const spaced = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: '  Quiet   Cafe ', activityType: 'Dining', location: ' paris ' });
    expect(spaced.status).toBe(200);
    expect(spaced.body).toEqual(first.body);
    expect(axios.post).not.toHaveBeenCalled();
    expect(await getBalance(ada.userId)).toBe(18.5);

    axios.post.mockResolvedValue(googleOk([placeRow('museum-1', 'Louvre')]));
    const otherQuery = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'museum', activityType: 'dining', location: 'Paris' });
    expect(otherQuery.status).toBe(200);
    expect(otherQuery.body[0].placeId).toBe('museum-1');
    expect(placesCalls()).toHaveLength(1);
    expect(await getBalance(ada.userId)).toBe(18);

    axios.post.mockClear();
    axios.get.mockClear();
    const otherPlace = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'quiet cafe', activityType: 'dining', location: 'Rome' });
    expect(otherPlace.status).toBe(200);
    expect(placesCalls()).toHaveLength(1);
    expect(await getBalance(ada.userId)).toBe(17.5);

    axios.post.mockClear();
    axios.get.mockClear();
    const otherType = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ query: 'quiet cafe', activityType: 'hotel', location: 'Paris' });
    expect(otherType.status).toBe(200);
    expect(placesCalls()).toHaveLength(1);
    expect(placesCalls()[0][1].includedType).toBe('lodging');
    expect(await getBalance(ada.userId)).toBe(17);

    axios.post.mockClear();
    axios.get.mockClear();
    axios.post.mockResolvedValue(googleOk());
    expireSuggestCache();
    const expired = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send(body);
    expect(expired.status).toBe(200);
    expect(expired.body[0].placeId).toBe(PLACE_ID);
    expect(placesCalls()).toHaveLength(1);
    expect(await getBalance(ada.userId)).toBe(16.5);
    expect(await AiUsage.countDocuments({
      userId: ada.userId,
      provider: 'google',
      success: true,
    })).toBe(7);

    await User.updateOne(
      { _id: ada.userId },
      { $set: { aiCredits: 0, monthlyCredits: 0, purchasedCredits: 0 } },
    );
    axios.post.mockClear();
    axios.get.mockClear();
    const broke = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send(body);
    expect(broke.status).toBe(402);
    expect(broke.body.message).toBe('Insufficient AI credits');
    expect(broke.body.places).toEqual([]);
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(await getBalance(ada.userId)).toBe(0);

    axios.post.mockClear();
    axios.get.mockClear();
    const uncached = await suggestPlaces({
      query: 'quiet cafe',
      activityType: 'dining',
      location: 'Paris',
      destination: 'Paris',
    });
    const uncachedAgain = await suggestPlaces({
      query: 'quiet cafe',
      activityType: 'dining',
      location: 'Paris',
      destination: 'Paris',
    });
    expect(uncached.status).toBe(200);
    expect(uncachedAgain.status).toBe(200);
    expect(placesCalls()).toHaveLength(2);
  });
});
