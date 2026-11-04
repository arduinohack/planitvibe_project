jest.mock('../utils/notifications', () => ({
  notifyUsers: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('axios', () => ({
  post: jest.fn(() => Promise.resolve({ status: 500, data: {} })),
  get: jest.fn(() => Promise.resolve({ status: 500, data: {} })),
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
const Attachment = require('../models/Attachment');
const ActivityRevision = require('../models/ActivityRevision');
const SupportLog = require('../models/SupportLog');
const AiUsage = require('../models/AiUsage');
const { getBalance } = require('../utils/aiCredits');
const { XAI_ENDPOINT } = require('../utils/aiCommand');
const { SEARCH_URL } = require('../utils/placeSuggest');
const {
  DELETE_MESSAGE,
  EXPORT_MESSAGE,
  EDIT_MESSAGE,
  AI_MESSAGE,
  EXCESS_MESSAGE,
} = require('../utils/planAccess');
const { upgradeBody } = require('../utils/membershipTiers');

jest.setTimeout(30000);

const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
const SECRET = '0123456789abcdef0123456789abcdef';
const USER_KEY = 'user-xai-key-9f3c2a7b-do-not-echo';
const SERVER_KEY = 'server-xai-key-should-be-fallback';
const CREDITS = '/api/users/me/ai-credits';

let mongo;
const previousXai = process.env.XAI_API_KEY;
const previousSecret = process.env.AI_KEY_ENCRYPTION_SECRET;
const previousGoogle = process.env.GOOGLE_MAPS_API_KEY;

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndLogin(email) {
  await allowRegister(email);
  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email,
      password: 'password1',
    });
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

async function postPlan(token, name) {
  return request(app)
    .post('/api/plans')
    .set(bearer(token))
    .send({
      type: 'trip',
      name,
      destination: 'Paris',
      timeZone: 'UTC',
      startDate: '2026-10-27T00:00:00.000Z',
      endDate: '2026-10-30T00:00:00.000Z',
    });
}

async function postActivity(token, planId, name = 'Dinner') {
  return request(app)
    .post('/api/activities')
    .set(bearer(token))
    .send({
      name,
      type: 'dining',
      planId,
      startTime: '2026-10-28T19:00:00.000Z',
      endTime: '2026-10-28T21:00:00.000Z',
    });
}

function exportPlan(token, planId) {
  return request(app)
    .get(`/api/plans/${planId}/export`)
    .query({ format: 'csv', fields: 'name' })
    .set(bearer(token));
}

async function credits(token) {
  const res = await request(app).get(CREDITS).set(bearer(token));
  expect(res.status).toBe(200);
  return res.body;
}

async function endAccess(userId) {
  const started = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const ended = new Date(Date.now() - 60 * 60 * 1000);
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        plusActive: false,
        trialStartedAt: started,
        trialEndsAt: ended,
      },
    },
  );
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

beforeAll(async () => {
  process.env.AI_KEY_ENCRYPTION_SECRET = SECRET;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  axios.post.mockReset();
  axios.get.mockReset();
  await Promise.all([
    User.deleteMany({}),
    Plan.deleteMany({}),
    PlanUser.deleteMany({}),
    Invitation.deleteMany({}),
    Event.deleteMany({}),
    ActivityRevision.deleteMany({}),
    SupportLog.deleteMany({}),
    AiUsage.deleteMany({}),
    Attachment.deleteMany({}),
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

describe('free-owner trial and Plus gating', () => {
  test('the first owned plan starts a 14-day trial and grants 15 credits once', async () => {
    const ada = await registerAndLogin('ada-trial-first@example.com');
    expect(await getBalance(ada.userId)).toBe(0);

    const before = Date.now();
    const first = await postPlan(ada.token, 'Paris');
    const after = Date.now();
    expect(first.status).toBe(201);
    const shown = await credits(ada.token);
    const started = Date.parse(shown.trialStartedAt);
    const ends = Date.parse(shown.trialEndsAt);
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(after);
    expect(ends - started).toBe(TRIAL_MS);
    expect(shown.trialActive).toBe(true);
    expect(shown.plusActive).toBe(false);
    expect(shown.tier).toBe('trial');
    expect(shown.tierName).toBe('PlanItVibe (Trial)');
    expect(shown.planCap).toBe(2);
    expect(shown.plansOwned).toBe(1);
    expect(shown.aiCredits).toBe(15);
    const startedAt = shown.trialStartedAt;

    const second = await postPlan(ada.token, 'Lyon');
    expect(second.status).toBe(201);
    expect(await getBalance(ada.userId)).toBe(15);
    expect((await credits(ada.token)).plansOwned).toBe(2);

    const removedFirst = await request(app)
      .delete(`/api/plans/${first.body.plan._id}`)
      .set(bearer(ada.token));
    expect(removedFirst.status).toBe(200);
    const removedSecond = await request(app)
      .delete(`/api/plans/${second.body.plan._id}`)
      .set(bearer(ada.token));
    expect(removedSecond.status).toBe(200);

    const again = await postPlan(ada.token, 'Nice');
    expect(again.status).toBe(201);
    const afterAgain = await credits(ada.token);
    expect(afterAgain.aiCredits).toBe(15);
    expect(afterAgain.trialStartedAt).toBe(startedAt);
    expect(afterAgain.plansOwned).toBe(1);
  });

  test('a trial allows two plans, blocks a third and import, and blocks export', async () => {
    const ada = await registerAndLogin('ada-trial-cap@example.com');
    const first = await postPlan(ada.token, 'Paris');
    const second = await postPlan(ada.token, 'Lyon');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const third = await postPlan(ada.token, 'Nice');
    expect(third.status).toBe(402);
    expect(third.body).toEqual(upgradeBody('trial'));
    expect(await Plan.countDocuments({ ownerId: ada.userId })).toBe(2);

    const imported = await request(app)
      .post(`/api/plans/${first.body.plan._id}/import`)
      .set(bearer(ada.token))
      .field('map', JSON.stringify({ name: 'name', type: 'type' }))
      .field('defaultType', 'dining')
      .attach('file', Buffer.from('name,type\nDinner,dining\n', 'utf8'), 'import.csv');
    expect(imported.status).toBe(402);
    expect(imported.body).toEqual(upgradeBody('trial'));
    expect(await Plan.countDocuments({ ownerId: ada.userId })).toBe(2);

    const exported = await exportPlan(ada.token, first.body.plan._id);
    expect(exported.status).toBe(402);
    expect(exported.body).toEqual({ message: EXPORT_MESSAGE });
  });

  test('after the trial, create and delete are blocked and the plan stays readable', async () => {
    const ada = await registerAndLogin('ada-trial-ended@example.com');
    const grace = await registerAndLogin('grace-trial-ended@example.com');
    const created = await postPlan(ada.token, 'Paris');
    expect(created.status).toBe(201);
    const planId = created.body.plan._id;
    const dinner = await postActivity(ada.token, planId);
    expect(dinner.status).toBe(201);
    await acceptRole(ada.token, grace.token, planId, 'grace-trial-ended@example.com', 'Guest');
    await endAccess(ada.userId);

    const another = await postPlan(ada.token, 'Lyon');
    expect(another.status).toBe(402);
    expect(another.body).toEqual(upgradeBody('trial'));

    const removed = await request(app)
      .delete(`/api/plans/${planId}`)
      .set(bearer(ada.token));
    expect(removed.status).toBe(402);
    expect(removed.body).toEqual({ message: DELETE_MESSAGE });
    expect(await Plan.findById(planId)).not.toBeNull();

    const edited = await postActivity(ada.token, planId, 'Lunch');
    expect(edited.status).toBe(402);
    expect(edited.body).toEqual({ message: EDIT_MESSAGE });

    const guestEdit = await postActivity(grace.token, planId, 'Guest lunch');
    expect(guestEdit.status).toBe(403);

    const plan = await request(app)
      .get(`/api/plans/${planId}`)
      .set(bearer(ada.token));
    expect(plan.status).toBe(200);
    expect(plan.body.plan.name).toBe('Paris');

    const itinerary = await request(app)
      .get(`/api/plans/${planId}/itinerary`)
      .set(bearer(ada.token));
    expect(itinerary.status).toBe(200);
    expect(itinerary.body.events.some((event) => event.name === 'Dinner')).toBe(true);

    const listed = await request(app).get('/api/plans').set(bearer(ada.token));
    expect(listed.status).toBe(200);
    expect(listed.body.plans.some((item) => item._id === planId)).toBe(true);

    const shown = await credits(ada.token);
    expect(shown.trialActive).toBe(false);
    expect(shown.plusActive).toBe(false);
    expect(shown.tier).toBe('trial');
    expect(shown.tierName).toBe('PlanItVibe (Trial)');
    expect(shown.planCap).toBe(2);
    expect(shown.plansOwned).toBe(1);
  });

  test('Plus can create, delete, and export', async () => {
    const ada = await registerAndLogin('ada-plus-open@example.com');
    await User.updateOne(
      { _id: ada.userId },
      { $set: { plusActive: true, tier: 'plus', subscriptionStatus: 'active' } },
    );
    const names = ['Paris', 'Lyon', 'Nice'];
    const ids = [];
    for (const name of names) {
      const created = await postPlan(ada.token, name);
      expect(created.status).toBe(201);
      ids.push(created.body.plan._id);
    }
    const open = await credits(ada.token);
    expect(open.plansOwned).toBe(3);
    expect(open.plusActive).toBe(true);
    expect(open.tier).toBe('plus');
    expect(open.tierName).toBe('PlanItVibe Plus');
    expect(open.planCap).toBe(10);
    expect(await getBalance(ada.userId)).toBe(15);

    const exported = await exportPlan(ada.token, ids[0]);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('name');

    const removed = await request(app)
      .delete(`/api/plans/${ids[2]}`)
      .set(bearer(ada.token));
    expect(removed.status).toBe(200);
    expect(await Plan.findById(ids[2])).toBeNull();
  });

  test('a lapsed Plus subscription is read-only and export stays blocked', async () => {
    const ada = await registerAndLogin('ada-plus-lapsed@example.com');
    const created = await postPlan(ada.token, 'Paris');
    expect(created.status).toBe(201);
    const planId = created.body.plan._id;
    const dinner = await postActivity(ada.token, planId);
    expect(dinner.status).toBe(201);

    await User.updateOne({ _id: ada.userId }, { $set: { plusActive: false } });
    const whileTrial = await postActivity(ada.token, planId, 'Still in trial');
    expect(whileTrial.status).toBe(201);
    const trialExport = await exportPlan(ada.token, planId);
    expect(trialExport.status).toBe(402);
    expect(trialExport.body).toEqual({ message: EXPORT_MESSAGE });

    await endAccess(ada.userId);
    const another = await postPlan(ada.token, 'Lyon');
    expect(another.status).toBe(402);
    expect(another.body).toEqual(upgradeBody('trial'));
    const removed = await request(app)
      .delete(`/api/plans/${planId}`)
      .set(bearer(ada.token));
    expect(removed.status).toBe(402);
    expect(removed.body).toEqual({ message: DELETE_MESSAGE });
    const edited = await request(app)
      .put(`/api/plans/${planId}`)
      .set(bearer(ada.token))
      .send({ name: 'Renamed' });
    expect(edited.status).toBe(402);
    expect(edited.body).toEqual({ message: EDIT_MESSAGE });
    const exported = await exportPlan(ada.token, planId);
    expect(exported.status).toBe(402);
    expect(exported.body).toEqual({ message: EXPORT_MESSAGE });

    const plan = await request(app)
      .get(`/api/plans/${planId}`)
      .set(bearer(ada.token));
    expect(plan.status).toBe(200);
    expect(plan.body.plan.name).toBe('Paris');
    const itinerary = await request(app)
      .get(`/api/plans/${planId}/itinerary`)
      .set(bearer(ada.token));
    expect(itinerary.status).toBe(200);
    expect(itinerary.body.events.some((event) => event.name === 'Dinner')).toBe(true);
  });

  test('server-key AI at zero credits during the trial is still insufficient credits', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    const ada = await registerAndLogin('ada-trial-credits@example.com');
    const created = await postPlan(ada.token, 'Paris');
    expect(created.status).toBe(201);
    await User.updateOne(
      { _id: ada.userId },
      { $set: { aiCredits: 0, monthlyCredits: 0, purchasedCredits: 0 } },
    );

    const blocked = await request(app)
      .post(`/api/plans/${created.body.plan._id}/ai-command`)
      .set(bearer(ada.token))
      .send({ instruction: 'add a dinner near the hotel on day 2' });
    expect(blocked.status).toBe(402);
    expect(blocked.body).toEqual({ message: 'Insufficient AI credits' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(await getBalance(ada.userId)).toBe(0);
  });

  test('after the trial, server-key AI asks for Plus and a user key still works', async () => {
    process.env.XAI_API_KEY = SERVER_KEY;
    process.env.GOOGLE_MAPS_API_KEY = 'test-google-key';
    const ada = await registerAndLogin('ada-trial-byok@example.com');
    const created = await postPlan(ada.token, 'Paris');
    expect(created.status).toBe(201);
    const planId = created.body.plan._id;
    await User.updateOne(
      { _id: ada.userId },
      { $set: { aiCredits: 5, monthlyCredits: 5, purchasedCredits: 0 } },
    );
    await endAccess(ada.userId);

    const blocked = await request(app)
      .post(`/api/plans/${planId}/ai-command`)
      .set(bearer(ada.token))
      .send({ instruction: 'add a dinner near the hotel on day 2' });
    expect(blocked.status).toBe(402);
    expect(blocked.body).toEqual({ message: AI_MESSAGE });
    expect(axios.post).not.toHaveBeenCalled();
    expect(await getBalance(ada.userId)).toBe(5);

    const suggested = await request(app)
      .post(`/api/plans/${planId}/suggest`)
      .set(bearer(ada.token))
      .send({ query: 'cafe' });
    expect(suggested.status).toBe(402);
    expect(suggested.body).toEqual({ message: AI_MESSAGE });

    const saved = await request(app)
      .put('/api/users/me/ai-settings')
      .set(bearer(ada.token))
      .send({ aiProvider: 'xai', apiKey: USER_KEY });
    expect(saved.status).toBe(200);
    axios.post.mockImplementation((url) => {
      if (url === SEARCH_URL) {
        return Promise.resolve({ status: 200, data: { places: [] } });
      }
      if (url !== XAI_ENDPOINT) return Promise.resolve({ status: 500, data: {} });
      return Promise.resolve({
        status: 200,
        data: {
          output_text: JSON.stringify({
            action: 'add',
            activity: {
              title: 'Quiet coffee',
              type: 'dining',
              location: 'cafe in Paris',
              startTime: '2026-10-28T09:00:00.000Z',
              endTime: '2026-10-28T10:00:00.000Z',
            },
          }),
        },
      });
    });
    const proposed = await request(app)
      .post(`/api/plans/${planId}/ai-command`)
      .set(bearer(ada.token))
      .send({ instruction: 'add a quiet coffee on day 2' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposal.action).toBe('add');
    expect(await getBalance(ada.userId)).toBe(4.5);
    const placesUsed = await AiUsage.find({ feature: 'suggest', provider: 'google' }).lean();
    expect(placesUsed).toHaveLength(1);
    expect(placesUsed[0].credits).toBe(0.5);
    const calls = axios.post.mock.calls.filter((call) => call[0] === XAI_ENDPOINT);
    expect(calls).toHaveLength(1);
    expect(calls[0][2].headers.Authorization).toBe(`Bearer ${USER_KEY}`);

    const applied = await request(app)
      .post(`/api/plans/${planId}/ai-command/apply`)
      .set(bearer(ada.token))
      .send(proposed.body.proposal);
    expect(applied.status).toBe(402);
    expect(applied.body).toEqual({ message: EDIT_MESSAGE });
    expect(await Event.countDocuments({ planId })).toBe(0);
  });

  test('a collaborator keeps role rules until their own trial has ended', async () => {
    const ada = await registerAndLogin('ada-trial-collab@example.com');
    const grace = await registerAndLogin('grace-trial-collab@example.com');
    const created = await postPlan(ada.token, 'Paris');
    expect(created.status).toBe(201);
    const planId = created.body.plan._id;
    await acceptRole(
      ada.token,
      grace.token,
      planId,
      'grace-trial-collab@example.com',
      'Collaborator',
    );
    await endAccess(ada.userId);

    const open = await postActivity(grace.token, planId, 'Grace dinner');
    expect(open.status).toBe(201);

    const own = await postPlan(grace.token, 'Grace trip');
    expect(own.status).toBe(201);
    await endAccess(grace.userId);
    const closed = await postActivity(grace.token, planId, 'Too late');
    expect(closed.status).toBe(402);
    expect(closed.body).toEqual({ message: EDIT_MESSAGE });
  });

  test('a guest membership does not count toward the plan cap', async () => {
    const ada = await registerAndLogin('ada-guest-cap@example.com');
    const grace = await registerAndLogin('grace-guest-cap@example.com');
    const owned = await postPlan(ada.token, 'Paris');
    expect(owned.status).toBe(201);
    const planId = owned.body.plan._id;
    await acceptRole(ada.token, grace.token, planId, 'grace-guest-cap@example.com', 'Guest');

    const inbox = await request(app).get('/api/invites').set(bearer(grace.token));
    expect(inbox.status).toBe(200);
    const plan = await request(app).get(`/api/plans/${planId}`).set(bearer(grace.token));
    expect(plan.status).toBe(200);
    const itinerary = await request(app)
      .get(`/api/plans/${planId}/itinerary`)
      .set(bearer(grace.token));
    expect(itinerary.status).toBe(200);

    const first = await postPlan(grace.token, 'Grace one');
    const second = await postPlan(grace.token, 'Grace two');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const third = await postPlan(grace.token, 'Grace three');
    expect(third.status).toBe(402);
    expect(third.body).toEqual(upgradeBody('trial'));
    expect(await Plan.countDocuments({ ownerId: grace.userId })).toBe(2);
    expect(await Plan.countDocuments({ ownerId: ada.userId })).toBe(1);
    const shown = await credits(grace.token);
    expect(shown.plansOwned).toBe(2);
    expect(shown.tierName).toBe('PlanItVibe (Trial)');
  });

  test('each paid tier stops at its plan cap', async () => {
    const cases = [
      ['planitvibe', 4, upgradeBody('planitvibe')],
      ['plus', 10, upgradeBody('plus')],
      ['pro', 30, upgradeBody('pro')],
    ];
    for (const [tier, cap, blockedBody] of cases) {
      const ada = await registerAndLogin(`${tier}-cap@example.com`);
      await User.updateOne({ _id: ada.userId }, { $set: { tier, plusActive: true } });
      const existing = [];
      for (let i = 0; i < cap - 1; i += 1) {
        existing.push({
          _id: `${tier}-owned-${i}`,
          type: 'trip',
          name: `${tier} ${i}`,
          destination: 'Paris',
          ownerId: ada.userId,
        });
      }
      await Plan.insertMany(existing);
      const allowed = await postPlan(ada.token, 'Room for one more');
      expect(allowed.status).toBe(201);
      const blocked = await postPlan(ada.token, 'Over the cap');
      expect(blocked.status).toBe(402);
      expect(blocked.body).toEqual(blockedBody);
      expect(await Plan.countDocuments({ ownerId: ada.userId })).toBe(cap);
      const shown = await credits(ada.token);
      expect(shown.tier).toBe(tier);
      expect(shown.planCap).toBe(cap);
      expect(shown.plansOwned).toBe(cap);
    }
  });

  test('an active trial keeps the two oldest owned plans editable', async () => {
    const ada = await registerAndLogin('ada-trial-excess@example.com');
    const grace = await registerAndLogin('grace-trial-excess@example.com');
    const guest = await registerAndLogin('guest-trial-excess@example.com');
    const first = await postPlan(ada.token, 'Paris');
    const second = await postPlan(ada.token, 'Lyon');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const olderIds = [first.body.plan._id, second.body.plan._id];

    const thirdCreate = await postPlan(ada.token, 'Nice');
    expect(thirdCreate.status).toBe(402);
    expect(thirdCreate.body).toEqual(upgradeBody('trial'));
    expect(await Plan.countDocuments({ ownerId: ada.userId })).toBe(2);

    const newestId = 'trial-excess-nice';
    await Plan.create({
      _id: newestId,
      type: 'trip',
      name: 'Nice',
      destination: 'Paris',
      ownerId: ada.userId,
      timeZone: 'UTC',
    });
    await PlanUser.create({ planId: newestId, userId: ada.userId, role: 'Owner' });
    await Plan.updateOne({ _id: olderIds[0] }, { $set: { createdAt: new Date('2026-01-01T00:00:00.000Z') } });
    await Plan.updateOne({ _id: olderIds[1] }, { $set: { createdAt: new Date('2026-02-01T00:00:00.000Z') } });
    await Plan.updateOne({ _id: newestId }, { $set: { createdAt: new Date('2026-03-01T00:00:00.000Z') } });

    const dinner = await Event.create({
      _id: 'trial-excess-dinner',
      name: 'Dinner',
      type: 'dining',
      planId: newestId,
      ownerId: ada.userId,
    });
    await Attachment.create({
      _id: 'trial-excess-file',
      activityId: dinner._id,
      planId: newestId,
      uploadedBy: ada.userId,
      filename: 'note.pdf',
      mimeType: 'application/pdf',
      size: 12,
      storageKey: 'trial-excess-file',
    });

    const listed = await request(app).get('/api/plans').set(bearer(ada.token));
    expect(listed.status).toBe(200);
    const byId = new Map(listed.body.plans.map((plan) => [plan._id, plan]));
    expect(byId.get(olderIds[0]).trialReadOnly).toBe(false);
    expect(byId.get(olderIds[1]).trialReadOnly).toBe(false);
    expect(byId.get(newestId).trialReadOnly).toBe(true);

    const opened = await request(app).get(`/api/plans/${newestId}`).set(bearer(ada.token));
    expect(opened.status).toBe(200);
    expect(opened.body.plan.name).toBe('Nice');
    expect(opened.body.plan.trialReadOnly).toBe(true);
    const itinerary = await request(app)
      .get(`/api/plans/${newestId}/itinerary`)
      .set(bearer(ada.token));
    expect(itinerary.status).toBe(200);

    for (const planId of olderIds) {
      const added = await postActivity(ada.token, planId, 'Older dinner');
      expect(added.status).toBe(201);
    }
    const blockedAdd = await postActivity(ada.token, newestId, 'New dinner');
    expect(blockedAdd.status).toBe(402);
    expect(blockedAdd.body).toEqual({ message: EXCESS_MESSAGE });
    expect(await Event.countDocuments({ planId: newestId, name: 'New dinner' })).toBe(0);

    const blockedEdit = await request(app)
      .put(`/api/plans/${newestId}`)
      .set(bearer(ada.token))
      .send({ name: 'Renamed' });
    expect(blockedEdit.status).toBe(402);
    expect(blockedEdit.body).toEqual({ message: EXCESS_MESSAGE });
    expect((await Plan.findById(newestId)).name).toBe('Nice');

    const blockedActivity = await request(app)
      .put(`/api/activities/${dinner._id}`)
      .set(bearer(ada.token))
      .send({ name: 'Late dinner' });
    expect(blockedActivity.status).toBe(402);
    expect(blockedActivity.body).toEqual({ message: EXCESS_MESSAGE });
    expect((await Event.findById(dinner._id)).name).toBe('Dinner');

    const blockedRemoveActivity = await request(app)
      .delete(`/api/activities/${dinner._id}`)
      .set(bearer(ada.token));
    expect(blockedRemoveActivity.status).toBe(402);
    expect(blockedRemoveActivity.body).toEqual({ message: EXCESS_MESSAGE });
    expect(await Event.findById(dinner._id)).not.toBeNull();

    const blockedApply = await request(app)
      .post(`/api/plans/${newestId}/ai-command/apply`)
      .set(bearer(ada.token))
      .send({ action: 'add', activity: { title: 'Cafe' } });
    expect(blockedApply.status).toBe(402);
    expect(blockedApply.body).toEqual({ message: EXCESS_MESSAGE });

    const blockedSuggest = await request(app)
      .post(`/api/plans/${newestId}/suggest`)
      .set(bearer(ada.token))
      .send({ query: 'cafe' });
    expect(blockedSuggest.status).toBe(402);
    expect(blockedSuggest.body).toEqual({ message: EXCESS_MESSAGE });

    const blockedUpload = await request(app)
      .post(`/api/activities/${dinner._id}/attachments`)
      .set(bearer(ada.token));
    expect(blockedUpload.status).toBe(402);
    expect(blockedUpload.body).toEqual({ message: EXCESS_MESSAGE });

    const blockedFile = await request(app)
      .delete('/api/attachments/trial-excess-file')
      .set(bearer(ada.token));
    expect(blockedFile.status).toBe(402);
    expect(blockedFile.body).toEqual({ message: EXCESS_MESSAGE });
    expect(await Attachment.findById('trial-excess-file')).not.toBeNull();

    const blockedDelete = await request(app)
      .delete(`/api/plans/${newestId}`)
      .set(bearer(ada.token));
    expect(blockedDelete.status).toBe(402);
    expect(blockedDelete.body).toEqual({ message: EXCESS_MESSAGE });
    expect(await Plan.findById(newestId)).not.toBeNull();

    const exported = await exportPlan(ada.token, olderIds[0]);
    expect(exported.status).toBe(402);
    expect(exported.body).toEqual({ message: EXPORT_MESSAGE });

    await acceptRole(ada.token, grace.token, newestId, 'grace-trial-excess@example.com', 'Collaborator');
    await acceptRole(ada.token, guest.token, newestId, 'guest-trial-excess@example.com', 'Guest');
    const collaboratorWrite = await postActivity(grace.token, newestId, 'Grace dinner');
    expect(collaboratorWrite.status).toBe(402);
    expect(collaboratorWrite.body).toEqual({ message: EXCESS_MESSAGE });
    const guestWrite = await postActivity(guest.token, newestId, 'Guest dinner');
    expect(guestWrite.status).toBe(403);
    const olderCollaborator = await postActivity(grace.token, olderIds[0], 'Grace on Paris');
    expect(olderCollaborator.status).toBe(403);

    await acceptRole(ada.token, grace.token, olderIds[0], 'grace-trial-excess@example.com', 'Collaborator');
    const olderAllowed = await postActivity(grace.token, olderIds[0], 'Grace on Paris');
    expect(olderAllowed.status).toBe(201);

    await User.updateOne(
      { _id: ada.userId },
      { $set: { plusActive: true, tier: 'trial', subscriptionStatus: '' } },
    );
    const flagOnly = await postActivity(ada.token, newestId, 'Flag dinner');
    expect(flagOnly.status).toBe(402);
    expect(flagOnly.body).toEqual({ message: EXCESS_MESSAGE });
    expect(await Event.countDocuments({ planId: newestId, name: 'Flag dinner' })).toBe(0);

    await User.updateOne(
      { _id: ada.userId },
      { $set: { plusActive: false, tier: 'planitvibe', subscriptionStatus: 'canceled' } },
    );
    const canceled = await postActivity(ada.token, newestId, 'Canceled dinner');
    expect(canceled.status).toBe(402);
    expect(canceled.body).toEqual({ message: EXCESS_MESSAGE });
    expect(await Event.countDocuments({ planId: newestId, name: 'Canceled dinner' })).toBe(0);

    await User.updateOne(
      { _id: ada.userId },
      { $set: { plusActive: true, tier: 'planitvibe', subscriptionStatus: 'active' } },
    );
    const planitvibeNewest = await postActivity(ada.token, newestId, 'PlanItVibe dinner');
    expect(planitvibeNewest.status).toBe(201);
    const planitvibeFirst = await postActivity(ada.token, olderIds[0], 'PlanItVibe Paris');
    expect(planitvibeFirst.status).toBe(201);
    const planitvibeSecond = await postActivity(ada.token, olderIds[1], 'PlanItVibe Lyon');
    expect(planitvibeSecond.status).toBe(201);
    const planitvibeEdit = await request(app)
      .put(`/api/plans/${newestId}`)
      .set(bearer(ada.token))
      .send({ name: 'Nice planitvibe' });
    expect(planitvibeEdit.status).toBe(200);
    expect(planitvibeEdit.body.plan.name).toBe('Nice planitvibe');
    const planitvibeOpen = await request(app).get(`/api/plans/${newestId}`).set(bearer(ada.token));
    expect(planitvibeOpen.status).toBe(200);
    expect(planitvibeOpen.body.plan.trialReadOnly).toBe(false);

    await User.updateOne(
      { _id: ada.userId },
      { $set: { plusActive: true, tier: 'plus', subscriptionStatus: 'active' } },
    );
    const plusAdd = await postActivity(ada.token, newestId, 'Plus dinner');
    expect(plusAdd.status).toBe(201);
    const plusFirst = await postActivity(ada.token, olderIds[0], 'Plus Paris');
    expect(plusFirst.status).toBe(201);
    const plusSecond = await postActivity(ada.token, olderIds[1], 'Plus Lyon');
    expect(plusSecond.status).toBe(201);
    const plusOpen = await request(app).get(`/api/plans/${newestId}`).set(bearer(ada.token));
    expect(plusOpen.status).toBe(200);
    expect(plusOpen.body.plan.trialReadOnly).toBe(false);

    await User.updateOne(
      { _id: ada.userId },
      { $set: { plusActive: true, tier: 'pro', subscriptionStatus: 'trialing' } },
    );
    const proAdd = await postActivity(ada.token, newestId, 'Pro dinner');
    expect(proAdd.status).toBe(201);
    const proFirst = await postActivity(ada.token, olderIds[0], 'Pro Paris');
    expect(proFirst.status).toBe(201);
    const proSecond = await postActivity(ada.token, olderIds[1], 'Pro Lyon');
    expect(proSecond.status).toBe(201);
    const proOpen = await request(app).get(`/api/plans/${newestId}`).set(bearer(ada.token));
    expect(proOpen.status).toBe(200);
    expect(proOpen.body.plan.trialReadOnly).toBe(false);
  });

  test('an ended trial still uses the existing edit message on a newer plan', async () => {
    const ada = await registerAndLogin('ada-trial-excess-ended@example.com');
    const created = await postPlan(ada.token, 'Paris');
    expect(created.status).toBe(201);
    const oldestId = created.body.plan._id;
    const middleId = 'trial-excess-ended-middle';
    const newestId = 'trial-excess-ended';
    await Plan.create({
      _id: middleId,
      type: 'trip',
      name: 'Middle',
      destination: 'Paris',
      ownerId: ada.userId,
      timeZone: 'UTC',
    });
    await Plan.create({
      _id: newestId,
      type: 'trip',
      name: 'Later',
      destination: 'Paris',
      ownerId: ada.userId,
      timeZone: 'UTC',
    });
    await Plan.updateOne({ _id: oldestId }, { $set: { createdAt: new Date('2026-01-01T00:00:00.000Z') } });
    await Plan.updateOne({ _id: middleId }, { $set: { createdAt: new Date('2026-02-01T00:00:00.000Z') } });
    await Plan.updateOne({ _id: newestId }, { $set: { createdAt: new Date('2026-03-01T00:00:00.000Z') } });
    await endAccess(ada.userId);
    const blocked = await postActivity(ada.token, newestId, 'Too late');
    expect(blocked.status).toBe(402);
    expect(blocked.body).toEqual({ message: EDIT_MESSAGE });
  });
});
