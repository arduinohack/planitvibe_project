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
const ActivityRevision = require('../models/ActivityRevision');
const { Event } = require('../models/Event');
const AiUsage = require('../models/AiUsage');
const { getBalance } = require('../utils/aiCredits');
const { SEARCH_URL, FIELD_MASK } = require('../utils/placeSuggest');
const { XAI_ENDPOINT } = require('../utils/aiCommand');

jest.setTimeout(30000);

const SECRET = '0123456789abcdef0123456789abcdef';
const USER_KEY = 'user-xai-key-9f3c2a7b-do-not-echo';
const SERVER_KEY = 'server-xai-key-should-be-fallback';
const PLACE_ID = 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8';

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
      output_text: JSON.stringify(fields),
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

function mockModel(fields) {
  axios.post.mockImplementation((url) => {
    if (url === XAI_ENDPOINT) return Promise.resolve(modelPayload(fields));
    if (url === SEARCH_URL) return Promise.resolve(googleOk());
    return Promise.resolve({ status: 500, data: {} });
  });
}

function xaiCalls() {
  return axios.post.mock.calls.filter((call) => call[0] === XAI_ENDPOINT);
}

async function registerAndLogin(email, firstName) {
  await allowRegister(email);
  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({ firstName, lastName: 'Lovelace', email, password: 'password1' });
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
      startDate: '2026-10-27T00:00:00.000Z',
      endDate: '2026-10-30T00:00:00.000Z',
    });
  expect(res.status).toBe(201);
  return res.body.plan._id;
}

async function acceptRole(ownerToken, memberToken, planId, email, role) {
  const inviteRes = await request(app)
    .post(`/api/plans/${planId}/invite`)
    .set(bearer(ownerToken))
    .send({ email, role });
  expect(inviteRes.status).toBe(201);
  const acceptRes = await request(app)
    .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
    .set(bearer(memberToken))
    .send({ status: 'accepted' });
  expect(acceptRes.status).toBe(200);
}

async function setCredits(userId, aiCredits) {
  await User.updateOne({ _id: userId }, { $set: { aiCredits } });
}

async function addMuseum(token, planId) {
  const res = await request(app)
    .post('/api/activities')
    .set(bearer(token))
    .send({
      planId,
      name: 'Museum visit',
      type: 'tour',
      location: 'The Louvre',
      startTime: '2026-10-28T12:00:00.000Z',
      endTime: '2026-10-28T13:00:00.000Z',
    });
  expect(res.status).toBe(201);
  return res.body._id;
}

function command(planId) {
  return `/api/plans/${planId}/ai-command`;
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
    ActivityRevision.deleteMany({}),
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

describe('AI command', () => {
  test('server-key add proposes a real place and apply creates it', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    process.env.GOOGLE_MAPS_API_KEY = 'test-google-key';
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 1.5);
    const missing = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.message).toBe('Instruction is required');

    mockModel({
      action: 'add',
      message: '',
      activityId: '',
      activity: {
        title: 'Kid-friendly dinner',
        type: 'dining',
        location: 'cafe near the hotel',
        startTime: '2026-10-28T18:00:00.000Z',
        endTime: '2026-10-28T19:30:00.000Z',
        details: 'Kid friendly',
        googlePlaceId: 'fake-from-model',
      },
      changes: {
        title: '',
        startTime: '',
        endTime: '',
        location: '',
        details: '',
      },
    });

    const proposed = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'add a kid-friendly dinner near the hotel on day 2' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.summary).toContain('Kid-friendly dinner');
    expect(proposed.body.summary).toContain('Cafe Paris');
    expect(proposed.body.proposal).toEqual({
      action: 'add',
      activity: {
        title: 'Kid-friendly dinner',
        type: 'dining',
        location: 'cafe near the hotel',
        startTime: '2026-10-28T18:00:00.000Z',
        endTime: '2026-10-28T19:30:00.000Z',
        details: 'Kid friendly',
        googlePlaceId: PLACE_ID,
        placeName: 'Cafe Paris',
        address: 'Paris, France',
      },
    });
    expect(await Event.countDocuments({ planId })).toBe(0);
    expect(await getBalance(owner.userId)).toBe(0);
    const calls = xaiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1].model).toBe('grok-4.7');
    expect(calls[0][1].input).toContain('add a kid-friendly dinner near the hotel on day 2');
    expect(calls[0][2].headers.Authorization).toBe(`Bearer ${SERVER_KEY}`);
    expect(axios.post.mock.calls.filter((call) => call[0] === SEARCH_URL)).toHaveLength(1);
    const rows = await AiUsage.find({ feature: 'command' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(true);
    expect(rows[0].provider).toBe('server');
    expect(rows[0].usedUserKey).toBe(false);
    expect(rows[0].planId).toBe(planId);

    axios.post.mockClear();
    const applied = await request(app)
      .post(`${command(planId)}/apply`)
      .set(bearer(owner.token))
      .send(proposed.body.proposal);
    expect(applied.status).toBe(201);
    expect(applied.body.name).toBe('Kid-friendly dinner');
    expect(applied.body.type).toBe('dining');
    expect(applied.body.googlePlaceId).toBe(PLACE_ID);
    expect(applied.body.location).toBe('cafe near the hotel');
    expect(new Date(applied.body.startTime).toISOString()).toBe('2026-10-28T18:00:00.000Z');
    expect(axios.post).not.toHaveBeenCalled();
    const stored = await Event.findById(applied.body._id).lean();
    expect(stored.planId).toBe(planId);
    expect(stored.details).toBe('Kid friendly');
    const revision = await ActivityRevision.findOne({
      eventId: applied.body._id,
      action: 'create',
    }).lean();
    expect(revision).toBeTruthy();
    expect(await getBalance(owner.userId)).toBe(0);
  });

  test('update proposes a new time and apply writes it', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 1);
    const activityId = await addMuseum(owner.token, planId);
    mockModel({
      action: 'update',
      message: '',
      activityId,
      activity: {
        title: '',
        type: '',
        location: '',
        startTime: '',
        endTime: '',
        details: '',
        googlePlaceId: '',
      },
      changes: {
        title: '',
        startTime: '2026-10-28T15:00:00.000Z',
        endTime: '2026-10-28T16:00:00.000Z',
        location: '',
        details: '',
      },
    });

    const proposed = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'move the museum visit to 3pm' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.summary).toContain('Museum visit');
    expect(proposed.body.proposal.action).toBe('update');
    expect(proposed.body.proposal.activityId).toBe(activityId);
    expect(proposed.body.proposal.changes.startTime).toBe('2026-10-28T15:00:00.000Z');
    expect(new Date((await Event.findById(activityId)).startTime).toISOString())
      .toBe('2026-10-28T12:00:00.000Z');
    expect(await getBalance(owner.userId)).toBe(0);
    expect(xaiCalls()[0][1].input).toContain(activityId);

    const applied = await request(app)
      .post(`${command(planId)}/apply`)
      .set(bearer(owner.token))
      .send(proposed.body.proposal);
    expect(applied.status).toBe(200);
    expect(applied.body._id).toBe(activityId);
    expect(new Date(applied.body.startTime).toISOString()).toBe('2026-10-28T15:00:00.000Z');
    expect(new Date(applied.body.endTime).toISOString()).toBe('2026-10-28T16:00:00.000Z');
    expect(applied.body.name).toBe('Museum visit');
    const revision = await ActivityRevision.findOne({
      eventId: activityId,
      action: 'update',
    }).lean();
    expect(revision).toBeTruthy();
  });

  test('delete proposes removal and apply removes the activity', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 1);
    const activityId = await addMuseum(owner.token, planId);
    mockModel({
      action: 'delete',
      message: '',
      activityId,
      activity: {
        title: '',
        type: '',
        location: '',
        startTime: '',
        endTime: '',
        details: '',
        googlePlaceId: '',
      },
      changes: {
        title: '',
        startTime: '',
        endTime: '',
        location: '',
        details: '',
      },
    });

    const proposed = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'delete the duplicate lunch' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposal).toEqual({ action: 'delete', activityId });
    expect(proposed.body.summary).toContain('Museum visit');
    expect(await Event.findById(activityId)).toBeTruthy();

    const applied = await request(app)
      .post(`${command(planId)}/apply`)
      .set(bearer(owner.token))
      .send(proposed.body.proposal);
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ deleted: true });
    expect(await Event.findById(activityId)).toBeNull();
    const revision = await ActivityRevision.findOne({
      eventId: activityId,
      action: 'delete',
    }).lean();
    expect(revision).toBeTruthy();
    expect(await getBalance(owner.userId)).toBe(0);
  });

  test('a guest cannot propose or apply', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const guest = await registerAndLogin('gus@example.com', 'Gus');
    await setCredits(guest.userId, 5);
    const planId = await createPlan(owner.token);
    await acceptRole(owner.token, guest.token, planId, 'gus@example.com', 'Guest');
    const activityId = await addMuseum(owner.token, planId);

    const denied = await request(app)
      .post(command(planId))
      .set(bearer(guest.token))
      .send({ instruction: 'delete the museum visit' });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Only Owner or Collaborator can use AI edit');
    const deniedApply = await request(app)
      .post(`${command(planId)}/apply`)
      .set(bearer(guest.token))
      .send({ action: 'delete', activityId });
    expect(deniedApply.status).toBe(403);
    expect(deniedApply.body.message).toBe('Only Owner or Collaborator can use AI edit');
    expect(axios.post).not.toHaveBeenCalled();
    expect(await Event.findById(activityId)).toBeTruthy();
    expect(await getBalance(guest.userId)).toBe(5);
  });

  test('a server key with no credits returns 402 and skips the model', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 0);
    const blocked = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'add a dinner near the hotel on day 2' });
    expect(blocked.status).toBe(402);
    expect(blocked.body).toEqual({ message: 'Insufficient AI credits' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(await getBalance(owner.userId)).toBe(0);
    expect(await Event.countDocuments({ planId })).toBe(0);
    const rows = await AiUsage.find({ feature: 'command' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(false);
    expect(rows[0].provider).toBe('server');
    expect(rows[0].usedUserKey).toBe(false);
    expect(rows[0].error).toBe('Insufficient AI credits');
    expect(rows[0].planId).toBe(planId);
  });

  test('a user key proposes without deducting credits', async () => {
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const saved = await request(app)
      .put('/api/users/me/ai-settings')
      .set(bearer(owner.token))
      .send({ aiProvider: 'xai', apiKey: USER_KEY });
    expect(saved.status).toBe(200);
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 4);
    mockModel({
      action: 'add',
      activity: {
        title: 'Quiet coffee',
        type: 'dining',
        location: 'cafe in Paris',
        startTime: '2026-10-28T09:00:00.000Z',
        endTime: '2026-10-28T10:00:00.000Z',
      },
    });
    const proposed = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'add a quiet coffee on day 2' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposal.action).toBe('add');
    expect(proposed.body.proposal.activity.title).toBe('Quiet coffee');
    expect(await getBalance(owner.userId)).toBe(4);
    expect(await Event.countDocuments({ planId })).toBe(0);
    const calls = xaiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][2].headers.Authorization).toBe(`Bearer ${USER_KEY}`);
    const rows = await AiUsage.find({ feature: 'command' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('xai');
    expect(rows[0].usedUserKey).toBe(true);
    expect(rows[0].success).toBe(true);
  });

  test('apply rejects a bad proposal and a missing activity', async () => {
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    const bad = await request(app)
      .post(`${command(planId)}/apply`)
      .set(bearer(owner.token))
      .send({ action: 'add', activity: { type: 'dining' } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Invalid proposal');
    expect(await Event.countDocuments({ planId })).toBe(0);

    const missing = await request(app)
      .post(`${command(planId)}/apply`)
      .set(bearer(owner.token))
      .send({
        action: 'update',
        activityId: 'missing-activity',
        changes: { startTime: '2026-10-28T15:00:00.000Z' },
      });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('Event not found');

    const none = await request(app)
      .post(`${command(planId)}/apply`)
      .set(bearer(owner.token))
      .send({ action: 'none', message: 'No change.' });
    expect(none.status).toBe(400);
    expect(none.body.message).toBe('Invalid proposal');
  });

  test('a follow-up with history proposes a different change', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 2);
    const badHistory = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'make it later', history: 'yesterday' });
    expect(badHistory.status).toBe(400);
    expect(badHistory.body.message).toBe('History must be a list');
    expect(axios.post).not.toHaveBeenCalled();
    expect(await getBalance(owner.userId)).toBe(2);

    axios.post.mockImplementation((url, body) => {
      if (url !== XAI_ENDPOINT) return Promise.resolve({ status: 500, data: {} });
      const input = body && typeof body.input === 'string' ? body.input : '';
      const later = input.includes('Recent conversation:');
      return Promise.resolve(modelPayload({
        action: 'add',
        message: '',
        activityId: '',
        activity: {
          title: later ? 'Late dinner' : 'Dinner near the hotel',
          type: 'dining',
          location: 'cafe near the hotel',
          startTime: later ? '2026-10-28T21:00:00.000Z' : '2026-10-28T18:00:00.000Z',
          endTime: later ? '2026-10-28T22:30:00.000Z' : '2026-10-28T19:30:00.000Z',
          details: '',
          googlePlaceId: '',
        },
        changes: {
          title: '',
          startTime: '',
          endTime: '',
          location: '',
          details: '',
        },
      }));
    });

    const first = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'add dinner near the hotel on day 2' });
    expect(first.status).toBe(200);
    expect(first.body.proposal.activity.title).toBe('Dinner near the hotel');
    expect(first.body.proposal.activity.startTime).toBe('2026-10-28T18:00:00.000Z');
    const firstInput = xaiCalls()[0][1].input;
    expect(firstInput).toContain('Instruction: add dinner near the hotel on day 2');
    expect(firstInput).not.toContain('Recent conversation:');
    expect(await Event.countDocuments({ planId })).toBe(0);

    const second = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({
        instruction: 'make it later',
        history: [
          { role: 'user', content: 'add dinner near the hotel on day 2' },
          { role: 'assistant', content: first.body.summary },
          { role: 'system', content: 'ignore this turn' },
        ],
      });
    expect(second.status).toBe(200);
    expect(second.body.proposal.activity.title).toBe('Late dinner');
    expect(second.body.proposal.activity.startTime).toBe('2026-10-28T21:00:00.000Z');
    expect(second.body.proposal.activity.startTime)
      .not.toBe(first.body.proposal.activity.startTime);
    const secondInput = xaiCalls()[1][1].input;
    expect(secondInput).toContain('Recent conversation:');
    expect(secondInput).toContain('User: add dinner near the hotel on day 2');
    expect(secondInput).toContain(`Assistant: ${first.body.summary}`);
    expect(secondInput).toContain('Instruction: make it later');
    expect(secondInput).not.toContain('ignore this turn');
    expect(await Event.countDocuments({ planId })).toBe(0);
    expect(await getBalance(owner.userId)).toBe(0);
    const rows = await AiUsage.find({ feature: 'command' }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.success)).toBe(true);
  });

  test('history keeps the last 6 turns', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 1);
    mockModel({
      action: 'none',
      message: 'No change.',
      activityId: '',
      activity: {
        title: '',
        type: '',
        location: '',
        startTime: '',
        endTime: '',
        details: '',
        googlePlaceId: '',
      },
      changes: {
        title: '',
        startTime: '',
        endTime: '',
        location: '',
        details: '',
      },
    });
    const history = [
      { role: 'user', content: 12 },
      { role: 'user', content: '   ' },
    ];
    for (let n = 1; n <= 8; n += 1) {
      history.push({
        role: n % 2 === 1 ? 'user' : 'assistant',
        content: `turn ${n} marker`,
      });
    }
    const proposed = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'make it later', history });
    expect(proposed.status).toBe(200);
    const input = xaiCalls()[0][1].input;
    expect(input).not.toContain('turn 1 marker');
    expect(input).not.toContain('turn 2 marker');
    expect(input).toContain('User: turn 3 marker');
    expect(input).toContain('Assistant: turn 8 marker');
    expect(input).toContain('Instruction: make it later');
  });

  test('what is missing can return action none', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    process.env.GOOGLE_MAPS_API_KEY = 'test-google-key';
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 1);
    await addMuseum(owner.token, planId);
    mockModel({
      action: 'none',
      message: 'Day 2 has a museum at noon and no dinner.',
      activityId: '',
      activity: {
        title: '',
        type: '',
        location: '',
        startTime: '',
        endTime: '',
        details: '',
        googlePlaceId: '',
      },
      changes: {
        title: '',
        startTime: '',
        endTime: '',
        location: '',
        details: '',
      },
    });
    const proposed = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'what’s missing on day 2?' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposal).toEqual({
      action: 'none',
      message: 'Day 2 has a museum at noon and no dinner.',
    });
    expect(proposed.body.summary).toBe('Day 2 has a museum at noon and no dinner.');
    const input = xaiCalls()[0][1].input;
    expect(input).toContain("Phrase: what's missing on day 2?");
    expect(input).toContain('Instruction: what’s missing on day 2?');
    expect(await Event.countDocuments({ planId })).toBe(1);
    expect(await getBalance(owner.userId)).toBe(0);
    expect(axios.post.mock.calls.filter((call) => call[0] === SEARCH_URL)).toHaveLength(0);
  });

  test('a free afternoon asks for one afternoon block', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const owner = await registerAndLogin('ada@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 1);
    mockModel({
      action: 'add',
      message: '',
      activityId: '',
      activity: {
        title: 'Free afternoon',
        type: 'tour',
        location: '',
        startTime: '2026-10-29T13:00:00.000Z',
        endTime: '2026-10-29T16:00:00.000Z',
        details: 'Open time',
        googlePlaceId: '',
      },
      changes: {
        title: '',
        startTime: '',
        endTime: '',
        location: '',
        details: '',
      },
    });
    const proposed = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction: 'add a free afternoon on day 3' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposal.action).toBe('add');
    expect(proposed.body.proposal.activity.type).toBe('tour');
    expect(proposed.body.proposal.activity.title).toBe('Free afternoon');
    expect(proposed.body.proposal.activity.startTime).toBe('2026-10-29T13:00:00.000Z');
    expect(proposed.body.proposal.activity.endTime).toBe('2026-10-29T16:00:00.000Z');
    const input = xaiCalls()[0][1].input;
    expect(input).toContain('Phrase: add a free afternoon on day 3.');
    expect(input).toContain('type tour lasting about three hours');
    expect(await Event.countDocuments({ planId })).toBe(0);
    expect(await getBalance(owner.userId)).toBe(0);
  });

  test('a gap-fill phrase proposes one add with a real place', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    process.env.GOOGLE_MAPS_API_KEY = 'test-google-key';
    const owner = await registerAndLogin('ada-gap@example.com', 'Ada');
    const planId = await createPlan(owner.token);
    await setCredits(owner.userId, 3);
    const hotel = await request(app)
      .post('/api/activities')
      .set(bearer(owner.token))
      .send({
        planId,
        name: 'Hotel Le Marais',
        type: 'hotel',
        location: 'Hotel Le Marais, Paris',
        startTime: '2026-10-27T15:00:00.000Z',
        endTime: '2026-10-30T11:00:00.000Z',
      });
    expect(hotel.status).toBe(201);

    axios.post.mockImplementation((url, body) => {
      if (url === SEARCH_URL) return Promise.resolve(googleOk());
      if (url !== XAI_ENDPOINT) return Promise.resolve({ status: 500, data: {} });
      const input = body && typeof body.input === 'string' ? body.input : '';
      const cheaper = input.includes('Instruction: something cheaper');
      return Promise.resolve(modelPayload({
        action: 'add',
        message: '',
        activityId: '',
        activity: {
          title: cheaper ? 'Cheaper museum' : 'Kid-friendly park',
          type: 'attraction',
          location: 'near the hotel',
          startTime: cheaper ? '2026-10-28T13:00:00.000Z' : '2026-10-28T14:00:00.000Z',
          endTime: cheaper ? '2026-10-28T15:00:00.000Z' : '2026-10-28T17:00:00.000Z',
          details: cheaper ? 'Lower cost' : 'Outdoor and kid-friendly',
          googlePlaceId: 'fake-from-model',
        },
        changes: {
          title: '',
          startTime: '',
          endTime: '',
          location: '',
          details: '',
        },
      }));
    });

    const instruction = 'Fill the free afternoon on day 2 with something kid-friendly near the hotel';
    const proposed = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({ instruction });
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposal.action).toBe('add');
    expect(proposed.body.proposal.activity.title).toBe('Kid-friendly park');
    expect(proposed.body.proposal.activity.googlePlaceId).toBe(PLACE_ID);
    expect(proposed.body.proposal.activity.placeName).toBe('Cafe Paris');
    expect(proposed.body.proposal.activity.address).toBe('Paris, France');
    expect(proposed.body.proposal.activity.location).toBe('Paris, France');
    expect(proposed.body.summary).toContain('Cafe Paris');
    expect(await Event.countDocuments({ planId })).toBe(1);

    const input = xaiCalls()[0][1].input;
    expect(input).toContain('Fill the free afternoon on day N with something kid-friendly near the hotel');
    expect(input).toContain('Suggest something for the gap on day N');
    expect(input).toContain('Add a kid-friendly, quiet, or outdoor activity near the hotel on day N');
    expect(input).toContain('Phrase: fill one open gap on day 2');
    expect(input).toContain('Hotel Le Marais, Paris');
    expect(input).toContain(`Instruction: ${instruction}`);

    const placeCalls = axios.post.mock.calls.filter((call) => call[0] === SEARCH_URL);
    expect(placeCalls).toHaveLength(1);
    expect(placeCalls[0][2].headers['X-Goog-FieldMask']).toBe(FIELD_MASK);
    expect(String(placeCalls[0][1].textQuery).toLowerCase()).toContain('kid-friendly');
    expect(String(placeCalls[0][1].textQuery)).toContain('Hotel Le Marais, Paris');
    const suggestRows = await AiUsage.find({ feature: 'suggest', provider: 'google' }).lean();
    expect(suggestRows).toHaveLength(1);
    expect(suggestRows[0].credits).toBe(0.5);
    expect(await getBalance(owner.userId)).toBe(1.5);

    const refined = await request(app)
      .post(command(planId))
      .set(bearer(owner.token))
      .send({
        instruction: 'something cheaper',
        history: [
          { role: 'user', content: instruction },
          { role: 'assistant', content: proposed.body.summary },
        ],
      });
    expect(refined.status).toBe(200);
    expect(refined.body.proposal.action).toBe('add');
    expect(refined.body.proposal.activity.title).toBe('Cheaper museum');
    expect(refined.body.proposal.activity.googlePlaceId).toBe(PLACE_ID);
    expect(refined.body.proposal.activity.startTime).toBe('2026-10-28T13:00:00.000Z');
    expect(refined.body.proposal.activity.startTime)
      .not.toBe(proposed.body.proposal.activity.startTime);
    const refinedInput = xaiCalls()[1][1].input;
    expect(refinedInput).toContain('Recent conversation:');
    expect(refinedInput).toContain(`User: ${instruction}`);
    expect(refinedInput).toContain('Instruction: something cheaper');
    expect(await Event.countDocuments({ planId })).toBe(1);
    expect(await getBalance(owner.userId)).toBe(0);

    const applied = await request(app)
      .post(`${command(planId)}/apply`)
      .set(bearer(owner.token))
      .send(refined.body.proposal);
    expect(applied.status).toBe(201);
    expect(applied.body.name).toBe('Cheaper museum');
    expect(applied.body.googlePlaceId).toBe(PLACE_ID);
    expect(applied.body.location).toBe('Paris, France');
    expect(await Event.countDocuments({ planId })).toBe(2);
  });
});
