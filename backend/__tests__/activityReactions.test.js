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
const ActivityReaction = require('../models/ActivityReaction');
const { setReactionIo, presenceRoom } = require('../realtime/presence');

jest.setTimeout(30000);

let mongo;

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndLogin(email, firstName = 'Ada') {
  await allowRegister(email);
  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({
      firstName,
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

async function createActivity(token, planId) {
  const res = await request(app)
    .post('/api/activities')
    .set(bearer(token))
    .send({ planId, name: 'Museum visit', type: 'tour', durationMinutes: 60 });
  expect(res.status).toBe(201);
  return res.body._id;
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

function react(token, activityId, type) {
  return request(app)
    .post(`/api/activities/${activityId}/react`)
    .set(bearer(token))
    .send({ type });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  setReactionIo(null);
  await Promise.all([
    User.deleteMany({}),
    Plan.deleteMany({}),
    PlanUser.deleteMany({}),
    Invitation.deleteMany({}),
    Event.deleteMany({}),
    ActivityReaction.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('activity reactions', () => {
  test('a member vote updates the count and a second vote of the same type replaces it', async () => {
    const owner = await registerAndLogin('ada-react@example.com');
    const planId = await createPlan(owner.token);
    const activityId = await createActivity(owner.token, planId);
    const before = await Event.countDocuments({ planId });

    const voted = await react(owner.token, activityId, 'up');
    expect(voted.status).toBe(200);
    expect(voted.body.counts).toEqual({ up: 1, down: 0, yes: 0, no: 0, maybe: 0 });
    expect(voted.body.myVotes).toEqual(['up']);
    expect(await Event.countDocuments({ planId })).toBe(before);

    const stored = await ActivityReaction.findOne({ activityId, type: 'up' });
    stored.createdAt = new Date('2020-01-01T00:00:00.000Z');
    await stored.save();

    const again = await react(owner.token, activityId, 'up');
    expect(again.status).toBe(200);
    expect(again.body.counts.up).toBe(1);
    expect(again.body.myVotes).toEqual(['up']);
    expect(await ActivityReaction.countDocuments({ activityId })).toBe(1);
    const replaced = await ActivityReaction.findOne({ activityId, type: 'up' });
    expect(String(replaced._id)).toBe(String(stored._id));
    expect(replaced.createdAt.getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00.000Z').getTime());

    const changed = await react(owner.token, activityId, 'down');
    expect(changed.status).toBe(200);
    expect(changed.body.counts).toEqual({ up: 0, down: 1, yes: 0, no: 0, maybe: 0 });
    expect(changed.body.myVotes).toEqual(['down']);
  });

  test('a guest can vote and a non-member cannot', async () => {
    const owner = await registerAndLogin('ada-react-guest@example.com');
    const guest = await registerAndLogin('gue-react@example.com', 'Grace');
    const outsider = await registerAndLogin('out-react@example.com', 'Omar');
    const planId = await createPlan(owner.token);
    const activityId = await createActivity(owner.token, planId);
    await acceptRole(owner.token, guest.token, planId, 'gue-react@example.com', 'Guest');

    const guestVote = await react(guest.token, activityId, 'up');
    expect(guestVote.status).toBe(200);
    expect(guestVote.body.counts.up).toBe(1);
    expect(guestVote.body.myVotes).toEqual(['up']);

    const ownerView = await request(app)
      .get(`/api/activities/${activityId}/reactions`)
      .set(bearer(owner.token));
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.counts.up).toBe(1);
    expect(ownerView.body.myVotes).toEqual([]);

    const denied = await react(outsider.token, activityId, 'up');
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Only plan members can react');
    expect(await ActivityReaction.countDocuments({ activityId })).toBe(1);

    const deniedRead = await request(app)
      .get(`/api/activities/${activityId}/reactions`)
      .set(bearer(outsider.token));
    expect(deniedRead.status).toBe(403);

    const noToken = await request(app)
      .post(`/api/activities/${activityId}/react`)
      .send({ type: 'up' });
    expect(noToken.status).toBe(401);
  });

  test('deleting a reaction clears that vote and deleting the activity removes the votes', async () => {
    const owner = await registerAndLogin('ada-react-clear@example.com');
    const planId = await createPlan(owner.token);
    const activityId = await createActivity(owner.token, planId);
    await react(owner.token, activityId, 'up');

    const cleared = await request(app)
      .delete(`/api/activities/${activityId}/react`)
      .set(bearer(owner.token))
      .send({ type: 'up' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.counts.up).toBe(0);
    expect(cleared.body.myVotes).toEqual([]);
    expect(await ActivityReaction.countDocuments({ activityId })).toBe(0);

    await react(owner.token, activityId, 'yes');
    const edited = await request(app)
      .put(`/api/activities/${activityId}`)
      .set(bearer(owner.token))
      .send({ name: 'Museum visit renamed' });
    expect(edited.status).toBe(200);
    const kept = await request(app)
      .get(`/api/activities/${activityId}/reactions`)
      .set(bearer(owner.token));
    expect(kept.status).toBe(200);
    expect(kept.body.counts.yes).toBe(1);
    expect(await Event.countDocuments({ planId })).toBe(1);

    const removed = await request(app)
      .delete(`/api/activities/${activityId}`)
      .set(bearer(owner.token));
    expect(removed.status).toBe(200);
    expect(await ActivityReaction.countDocuments({ activityId })).toBe(0);
    expect(await Event.countDocuments({ planId })).toBe(0);
    const gone = await request(app)
      .get(`/api/activities/${activityId}/reactions`)
      .set(bearer(owner.token));
    expect(gone.status).toBe(404);
  });

  test('a guest cannot add a poll and a yes vote replaces no', async () => {
    const owner = await registerAndLogin('ada-poll@example.com');
    const guest = await registerAndLogin('gue-poll@example.com', 'Grace');
    const planner = await registerAndLogin('coe-poll@example.com', 'Cara');
    const planId = await createPlan(owner.token);
    const activityId = await createActivity(owner.token, planId);
    const secondId = await createActivity(owner.token, planId);
    await acceptRole(owner.token, guest.token, planId, 'gue-poll@example.com', 'Guest');
    await acceptRole(owner.token, planner.token, planId, 'coe-poll@example.com', 'Collaborator');
    const before = await Event.countDocuments({ planId });

    const guestPoll = await request(app)
      .post(`/api/activities/${activityId}/poll`)
      .set(bearer(guest.token))
      .send({});
    expect(guestPoll.status).toBe(403);
    expect(guestPoll.body.message).toBe('Only Owner or Collaborator can add a poll');
    expect((await Event.findById(activityId)).poll).not.toBe(true);

    const opened = await request(app)
      .post(`/api/activities/${activityId}/poll`)
      .set(bearer(owner.token))
      .send({});
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({ poll: true });
    expect(await Event.countDocuments({ planId })).toBe(before);
    expect((await Event.findById(activityId)).poll).toBe(true);

    const plannerPoll = await request(app)
      .post(`/api/activities/${secondId}/poll`)
      .set(bearer(planner.token))
      .send({});
    expect(plannerPoll.status).toBe(200);
    expect(await Event.countDocuments({ planId })).toBe(before);

    const yes = await react(owner.token, activityId, 'yes');
    expect(yes.status).toBe(200);
    expect(yes.body.counts.yes).toBe(1);
    const no = await react(owner.token, activityId, 'no');
    expect(no.status).toBe(200);
    expect(no.body.counts).toEqual({ up: 0, down: 0, yes: 0, no: 1, maybe: 0 });
    expect(no.body.myVotes).toEqual(['no']);

    const guestMaybe = await react(guest.token, activityId, 'maybe');
    expect(guestMaybe.status).toBe(200);
    expect(guestMaybe.body.counts.maybe).toBe(1);
    expect(guestMaybe.body.counts.no).toBe(1);
    expect(guestMaybe.body.myVotes).toEqual(['maybe']);

    const bad = await react(owner.token, activityId, 'love');
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Type must be up, down, yes, no, or maybe');
  });

  test('a react emits to the plan room and still succeeds when the socket is down', async () => {
    const owner = await registerAndLogin('ada-react-live@example.com');
    const planId = await createPlan(owner.token);
    const activityId = await createActivity(owner.token, planId);
    const emitted = [];
    setReactionIo({
      to(room) {
        return {
          emit(event, payload) {
            emitted.push({ room, event, payload });
          },
        };
      },
    });

    const voted = await react(owner.token, activityId, 'up');
    expect(voted.status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe(presenceRoom(String(planId)));
    expect(emitted[0].event).toBe('reaction');
    expect(emitted[0].payload.planId).toBe(String(planId));
    expect(emitted[0].payload.activityId).toBe(String(activityId));
    expect(emitted[0].payload.type).toBe('up');
    expect(emitted[0].payload.voted).toBe(true);
    expect(emitted[0].payload.userId).toBe(String(owner.userId));
    expect(emitted[0].payload.counts).toEqual({ up: 1, down: 0, yes: 0, no: 0, maybe: 0 });

    const cleared = await request(app)
      .delete(`/api/activities/${activityId}/react`)
      .set(bearer(owner.token))
      .send({ type: 'up' });
    expect(cleared.status).toBe(200);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].room).toBe(presenceRoom(String(planId)));
    expect(emitted[1].event).toBe('reaction');
    expect(emitted[1].payload.planId).toBe(String(planId));
    expect(emitted[1].payload.activityId).toBe(String(activityId));
    expect(emitted[1].payload.type).toBe('up');
    expect(emitted[1].payload.voted).toBe(false);
    expect(emitted[1].payload.counts.up).toBe(0);

    const opened = await request(app)
      .post(`/api/activities/${activityId}/poll`)
      .set(bearer(owner.token))
      .send({});
    expect(opened.status).toBe(200);
    expect(emitted).toHaveLength(2);

    setReactionIo({
      to() {
        throw new Error('socket down');
      },
    });
    const still = await react(owner.token, activityId, 'down');
    expect(still.status).toBe(200);
    expect(still.body.counts.down).toBe(1);
    expect(still.body.myVotes).toEqual(['down']);

    setReactionIo(null);
    const without = await react(owner.token, activityId, 'up');
    expect(without.status).toBe(200);
    expect(without.body.counts).toEqual({ up: 1, down: 0, yes: 0, no: 0, maybe: 0 });
    expect(without.body.myVotes).toEqual(['up']);
  });
});
