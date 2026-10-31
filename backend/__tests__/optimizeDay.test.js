const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const { allowRegister, clearRegisterInvite } = require('./inviteForRegister');
const User = require('../models/User');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const Invitation = require('../models/Invitation');
const { Event } = require('../models/Event');
const ActivityRevision = require('../models/ActivityRevision');

jest.setTimeout(30000);

let mongo;
const PLACE_A = 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8';
const PLACE_B = 'ChIJplaceB000000000000000';

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
  return loginRes.body.token;
}

async function createPlan(token) {
  const res = await request(app)
    .post('/api/plans')
    .set('Authorization', `Bearer ${token}`)
    .send({
      type: 'trip',
      name: 'Paris trip',
      destination: 'Paris',
      timeZone: 'UTC',
    });
  expect(res.status).toBe(201);
  return res.body.plan._id;
}

async function createActivity(token, planId, fields) {
  const res = await request(app)
    .post('/api/activities')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'tour', planId, ...fields });
  expect(res.status).toBe(201);
  return res.body;
}

function optimize(token, planId, body) {
  return request(app)
    .post(`/api/plans/${planId}/optimize-day`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Plan.deleteMany({}),
    PlanUser.deleteMany({}),
    Invitation.deleteMany({}),
    Event.deleteMany({}),
    ActivityRevision.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('POST /api/plans/:planId/optimize-day', () => {
  test('tighten pulls a 90-minute Place ID gap down to 30', async () => {
    const token = await registerAndLogin('ada-tighten@example.com');
    const planId = await createPlan(token);
    await createActivity(token, planId, {
      name: 'Arrival',
      startTime: '2030-06-01T09:00:00.000Z',
      endTime: '2030-06-01T10:00:00.000Z',
    });
    const museum = await createActivity(token, planId, {
      name: 'Museum',
      googlePlaceId: PLACE_A,
      startTime: '2030-06-02T10:00:00.000Z',
      endTime: '2030-06-02T11:00:00.000Z',
    });
    const lunch = await createActivity(token, planId, {
      name: 'Lunch',
      googlePlaceId: PLACE_B,
      startTime: '2030-06-02T12:30:00.000Z',
      endTime: '2030-06-02T13:30:00.000Z',
    });
    const walk = await createActivity(token, planId, {
      name: 'Walk',
      startTime: '2030-06-02T14:00:00.000Z',
      endTime: '2030-06-02T15:00:00.000Z',
    });

    const proposed = await optimize(token, planId, { day: 2, mode: 'tighten' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.summary).toContain('Day 2');
    expect(proposed.body.changes).toEqual([
      {
        activityId: String(lunch._id),
        oldStart: '2030-06-02T12:30:00.000Z',
        newStart: '2030-06-02T11:30:00.000Z',
        oldEnd: '2030-06-02T13:30:00.000Z',
        newEnd: '2030-06-02T12:30:00.000Z',
      },
      {
        activityId: String(walk._id),
        oldStart: '2030-06-02T14:00:00.000Z',
        newStart: '2030-06-02T13:00:00.000Z',
        oldEnd: '2030-06-02T15:00:00.000Z',
        newEnd: '2030-06-02T14:00:00.000Z',
      },
    ]);
    const before = await Event.findById(lunch._id).lean();
    expect(before.startTime.toISOString()).toBe('2030-06-02T12:30:00.000Z');

    const applied = await request(app)
      .post(`/api/plans/${planId}/optimize-day/apply`)
      .set('Authorization', `Bearer ${token}`)
      .send({ changes: proposed.body.changes });
    expect(applied.status).toBe(200);
    expect(applied.body.updated).toBe(2);
    const savedLunch = await Event.findById(lunch._id).lean();
    const savedWalk = await Event.findById(walk._id).lean();
    const savedMuseum = await Event.findById(museum._id).lean();
    expect(savedLunch.startTime.toISOString()).toBe('2030-06-02T11:30:00.000Z');
    expect(savedLunch.endTime.toISOString()).toBe('2030-06-02T12:30:00.000Z');
    expect(savedWalk.startTime.toISOString()).toBe('2030-06-02T13:00:00.000Z');
    expect(savedMuseum.startTime.toISOString()).toBe('2030-06-02T10:00:00.000Z');

    const history = await request(app)
      .get(`/api/activities/${lunch._id}/history`)
      .set('Authorization', `Bearer ${token}`);
    expect(history.status).toBe(200);
    expect(history.body[0].action).toBe('update');
    expect(new Date(history.body[0].snapshot.startTime).toISOString())
      .toBe('2030-06-02T11:30:00.000Z');
  });

  test('buffer inserts 30 minutes where the gap was 10', async () => {
    const token = await registerAndLogin('ada-buffer@example.com');
    const planId = await createPlan(token);
    await createActivity(token, planId, {
      name: 'Arrival',
      startTime: '2030-06-01T09:00:00.000Z',
      endTime: '2030-06-01T10:00:00.000Z',
    });
    const park = await createActivity(token, planId, {
      name: 'Park',
      startTime: '2030-06-02T10:00:00.000Z',
      endTime: '2030-06-02T11:00:00.000Z',
    });
    const cafe = await createActivity(token, planId, {
      name: 'Cafe',
      startTime: '2030-06-02T11:10:00.000Z',
      endTime: '2030-06-02T12:00:00.000Z',
    });
    const garden = await createActivity(token, planId, {
      name: 'Garden',
      startTime: '2030-06-02T12:40:00.000Z',
      endTime: '2030-06-02T13:40:00.000Z',
    });

    const proposed = await optimize(token, planId, { day: 2, mode: 'buffer' });
    expect(proposed.status).toBe(200);
    const byId = new Map(proposed.body.changes.map((change) => [change.activityId, change]));
    expect(byId.get(String(park._id))).toBeUndefined();
    expect(byId.get(String(cafe._id)).newStart).toBe('2030-06-02T11:30:00.000Z');
    expect(byId.get(String(cafe._id)).newEnd).toBe('2030-06-02T12:20:00.000Z');
    expect(byId.get(String(garden._id)).newStart).toBe('2030-06-02T12:50:00.000Z');
    expect(byId.get(String(garden._id)).newEnd).toBe('2030-06-02T13:50:00.000Z');
    const stored = await Event.findById(cafe._id).lean();
    expect(stored.startTime.toISOString()).toBe('2030-06-02T11:10:00.000Z');
  });

  test('a guest cannot optimize a day', async () => {
    const owner = await registerAndLogin('ada-opt-owner@example.com');
    const guest = await registerAndLogin('grace-opt@example.com');
    const planId = await createPlan(owner);
    const invite = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ email: 'grace-opt@example.com', role: 'Guest' });
    expect(invite.status).toBe(201);
    const accepted = await request(app)
      .post(`/api/invites/invitations/${invite.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${guest}`)
      .send({ status: 'accepted' });
    expect(accepted.status).toBe(200);

    const proposed = await optimize(guest, planId, { day: 2, mode: 'tighten' });
    expect(proposed.status).toBe(403);
    expect(proposed.body.message).toBe('Only Owner or Collaborator can optimize a day');
    const applied = await request(app)
      .post(`/api/plans/${planId}/optimize-day/apply`)
      .set('Authorization', `Bearer ${guest}`)
      .send({ changes: [] });
    expect(applied.status).toBe(403);
  });

  test('an empty day returns no changes', async () => {
    const token = await registerAndLogin('ada-empty-day@example.com');
    const planId = await createPlan(token);
    const only = await createActivity(token, planId, {
      name: 'Only day',
      startTime: '2030-06-01T10:00:00.000Z',
      endTime: '2030-06-01T11:00:00.000Z',
    });

    const proposed = await optimize(token, planId, { day: 2, mode: 'tighten' });
    expect(proposed.status).toBe(200);
    expect(proposed.body).toEqual({ summary: 'Day already fits.', changes: [] });
    const stored = await Event.findById(only._id).lean();
    expect(stored.startTime.toISOString()).toBe('2030-06-01T10:00:00.000Z');
  });
});
