jest.mock('../utils/notifications', () => ({
  notifyUsers: jest.fn().mockResolvedValue(undefined),
}));

const { notifyUsers } = require('../utils/notifications');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/User');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const Invitation = require('../models/Invitation');
const { Event } = require('../models/Event');
const ActivityRevision = require('../models/ActivityRevision');
const { allowRegister, allowEmail, clearRegisterInvite } = require('./inviteForRegister');

jest.setTimeout(30000);

let mongo;

async function registerAndLogin({ firstName, lastName, email, password }) {
  await allowRegister(email);
  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({ firstName, lastName, email, password });
  await clearRegisterInvite(email);
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password });
  return {
    registerRes,
    loginRes,
    token: loginRes.body.token,
    userId: loginRes.body.user && loginRes.body.user._id,
  };
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

describe('auth', () => {
  test('register + login returns a token', async () => {
    const { registerRes, loginRes, token } = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });

    expect(registerRes.status).toBe(201);
    expect(loginRes.status).toBe(200);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  test('register without a pending invitation is forbidden', async () => {
    await allowEmail('ada@example.com');
    const missing = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        password: 'password1',
      });
    expect(missing.status).toBe(403);
    expect(missing.body.msg).toBe('Signup is by invitation.');
    expect(await User.countDocuments({ email: 'ada@example.com' })).toBe(0);

    await Invitation.create({
      _id: 'rejected-invite',
      planId: 'plan-1',
      email: 'ada@example.com',
      invitedBy: 'owner-1',
      role: 'Guest',
      status: 'rejected',
    });
    const rejected = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        password: 'password1',
      });
    expect(rejected.status).toBe(403);
    expect(rejected.body.msg).toBe('Signup is by invitation.');
    expect(await User.countDocuments({ email: 'ada@example.com' })).toBe(0);
  });

  test('an invited person registers and the pending invite stays attached', async () => {
    await allowEmail('ada@example.com');
    await Invitation.create({
      _id: 'pending-invite',
      planId: 'plan-1',
      email: 'Ada@Example.com',
      invitedBy: 'owner-1',
      role: 'Guest',
      status: 'pending',
    });
    const registered = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        password: 'password1',
      });
    expect(registered.status).toBe(201);
    const user = await User.findOne({ email: 'ada@example.com' });
    const stored = await Invitation.findById('pending-invite');
    expect(stored.userId).toBe(String(user._id));
    expect(stored.status).toBe('pending');

    const again = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        password: 'password1',
      });
    expect(again.status).toBe(400);
    expect(again.body.msg).toBe('User already exists with this email');
  });
});

describe('plans', () => {
  test('request without a token gets 401 and does not create a plan', async () => {
    const res = await request(app)
      .post('/api/plans')
      .send({ type: 'trip', name: 'Nope' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token, authorization denied');
    expect(await Plan.countDocuments()).toBe(0);
  });

  test('coordinator creates a plan', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });

    const res = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });

    expect(res.status).toBe(201);
    expect(res.body.plan.ownerId).toBe(ada.userId);

    const membership = await PlanUser.findOne({ planId: res.body.plan._id, userId: ada.userId });
    expect(membership).toBeTruthy();
    expect(membership.role).toBe('Owner');
  });

  test('creator sees the plan on GET /api/plans', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const listRes = await request(app)
      .get('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.plans.map((plan) => plan._id)).toContain(planId);
  });

  test('creator still sees the plan when the PlanUser row is missing', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;
    await PlanUser.deleteOne({ planId, userId: ada.userId });

    const listRes = await request(app)
      .get('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.plans.map((plan) => plan._id)).toContain(planId);
  });

  test('an accepted member sees the plan and the owner still does', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'VibePlanner' });
    expect(inviteRes.status).toBe(201);

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    const graceList = await request(app)
      .get('/api/plans')
      .set('Authorization', `Bearer ${grace.token}`);
    expect(graceList.status).toBe(200);
    expect(graceList.body.plans.map((plan) => plan._id)).toContain(planId);

    const adaList = await request(app)
      .get('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`);
    expect(adaList.status).toBe(200);
    expect(adaList.body.plans.map((plan) => plan._id)).toContain(planId);
  });

  test('a pending invitation does not add the plan', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const alan = await registerAndLogin({
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      password: 'password3',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'alan@example.com', role: 'Wanderer' });
    expect(inviteRes.status).toBe(201);

    const alanList = await request(app)
      .get('/api/plans')
      .set('Authorization', `Bearer ${alan.token}`);
    expect(alanList.status).toBe(200);
    expect(alanList.body.plans.map((plan) => plan._id)).not.toContain(planId);

    const adaList = await request(app)
      .get('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`);
    expect(adaList.status).toBe(200);
    expect(adaList.body.plans.map((plan) => plan._id)).toContain(planId);
  });
});

describe('invites', () => {
  test('coordinator invites a second user as VibePlanner and they show up after accept', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const oldInvite = await request(app)
      .post(`/api/invites/trips/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'VibePlanner' });
    expect(oldInvite.status).toBe(404);

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'VibePlanner' });

    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.invitation.planId).toBe(planId);
    expect(inviteRes.body.invitation.role).toBe('Collaborator');

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });

    expect(acceptRes.status).toBe(200);

    const usersRes = await request(app)
      .get(`/api/plans/${planId}/users`)
      .set('Authorization', `Bearer ${ada.token}`);

    expect(usersRes.status).toBe(200);
    const graceRow = usersRes.body.users.find((user) => user.email === 'grace@example.com');
    expect(graceRow).toBeTruthy();
    expect(graceRow.role).toBe('Collaborator');
  });

  test('a wanderer cannot invite', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const alan = await registerAndLogin({
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      password: 'password3',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const wandererInvite = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'Wanderer' });
    expect(wandererInvite.status).toBe(201);

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${wandererInvite.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    for (const role of ['VibePlanner', 'Guest']) {
      const denied = await request(app)
        .post(`/api/plans/${planId}/invite`)
        .set('Authorization', `Bearer ${grace.token}`)
        .send({ email: 'alan@example.com', role });
      expect(denied.status).toBe(403);
    }
    expect(await Invitation.findOne({ userId: alan.userId })).toBeNull();
  });

  test('a planner may invite a wanderer as Guest', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const alan = await registerAndLogin({
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      password: 'password3',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const plannerInvite = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'VibePlanner' });
    expect(plannerInvite.status).toBe(201);

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${plannerInvite.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    const guestInvite = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ email: 'alan@example.com', role: 'Guest' });

    expect(guestInvite.status).toBe(201);
    expect(guestInvite.body.invitation.planId).toBe(planId);
    expect(guestInvite.body.invitation.role).toBe('Guest');
    expect(guestInvite.body.invitation.userId).toBe(alan.userId);

    const alanAccept = await request(app)
      .post(`/api/invites/invitations/${guestInvite.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${alan.token}`)
      .send({ status: 'accepted' });
    expect(alanAccept.status).toBe(200);

    const membership = await PlanUser.findOne({ planId, userId: alan.userId });
    expect(membership).toBeTruthy();
    expect(membership.role).toBe('Guest');
  });

  test('a planner cannot invite a VibePlanner', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const alan = await registerAndLogin({
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      password: 'password3',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const plannerInvite = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'VibePlanner' });
    expect(plannerInvite.status).toBe(201);

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${plannerInvite.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    for (const role of ['Collaborator', 'VibePlanner']) {
      const denied = await request(app)
        .post(`/api/plans/${planId}/invite`)
        .set('Authorization', `Bearer ${grace.token}`)
        .send({ email: 'alan@example.com', role });
      expect(denied.status).toBe(403);
    }
    expect(await Invitation.findOne({ userId: alan.userId })).toBeNull();
  });

  test('short membership names follow the same invite rules', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const alan = await registerAndLogin({
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      password: 'password3',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;
    await PlanUser.updateOne({ planId, userId: ada.userId }, { $set: { role: 'coordinator' } });

    const plannerInvite = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'planner' });
    expect(plannerInvite.status).toBe(201);
    expect(plannerInvite.body.invitation.role).toBe('Collaborator');

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${plannerInvite.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);
    await PlanUser.updateOne({ planId, userId: grace.userId }, { $set: { role: 'planner' } });

    const guestInvite = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ email: 'alan@example.com', role: 'wanderer' });
    expect(guestInvite.status).toBe(201);
    expect(guestInvite.body.invitation.role).toBe('Guest');

    await PlanUser.updateOne({ planId, userId: grace.userId }, { $set: { role: 'wanderer' } });
    const denied = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ email: 'alan@example.com', role: 'Guest' });
    expect(denied.status).toBe(403);
  });

  test('invite rejects owner and UI role labels', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    for (const role of ['Owner', 'VibeCoordinator', 'Organizer', 'Host', 'Co-Planner', 'Attendee', 'Planner']) {
      const res = await request(app)
        .post(`/api/plans/${planId}/invite`)
        .set('Authorization', `Bearer ${ada.token}`)
        .send({ email: 'grace@example.com', role });
      expect(res.status).toBe(400);
    }

    expect(await Invitation.countDocuments({ userId: grace.userId })).toBe(0);
  });

  test('invite stores an email with no user id when the person has no account', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;
    const email = 'new.person@example.com';
    notifyUsers.mockClear();

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email, role: 'Guest' });

    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.invitation.role).toBe('Guest');
    expect(inviteRes.body.invitation.email).toBe(email);
    expect(inviteRes.body.invitation.userId).toBeFalsy();
    expect(await User.findOne({ email })).toBeNull();
    expect(await User.countDocuments()).toBe(1);
    expect(notifyUsers).toHaveBeenCalledWith(
      [email],
      expect.stringContaining(`https://planitvibe.com/signup?email=${encodeURIComponent(email)}`),
      'email',
    );
    expect(notifyUsers).toHaveBeenCalledWith(
      [email],
      expect.stringContaining('as Traveler'),
      'email',
    );
    expect(notifyUsers.mock.calls.every((call) => !String(call[1]).includes('undefined'))).toBe(true);
    expect(notifyUsers.mock.calls.every((call) => !String(call[1]).includes('Collaborator'))).toBe(true);
    expect(notifyUsers.mock.calls.every((call) => !/\bGuest\b/.test(String(call[1])))).toBe(true);

    const again = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email, role: 'Guest' });
    expect(again.status).toBe(201);
    expect(again.body.invitation.role).toBe('Guest');
    expect(again.body.invitation.email).toBe(email);
    expect(again.body.invitation.userId).toBeFalsy();
    const pendingRows = await Invitation.find({ planId, email });
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]._id).toBe(again.body.invitation._id);
    expect(await Invitation.findById(inviteRes.body.invitation._id)).toBeNull();

    await allowEmail(email);
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'New',
        lastName: 'Person',
        email,
        password: 'password2',
      });
    expect(registerRes.status).toBe(201);
    const stored = await Invitation.findById(again.body.invitation._id);
    expect(stored.userId).toBeTruthy();
    expect(stored.status).toBe('pending');
    expect(await PlanUser.findOne({ planId, userId: stored.userId })).toBeNull();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'password2' });
    const inbox = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(inbox.status).toBe(200);
    expect(inbox.body.some((row) => row._id === stored._id)).toBe(true);

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${stored._id}/respond`)
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);
    const membership = await PlanUser.findOne({ planId, userId: stored.userId });
    expect(membership).toBeTruthy();
    expect(membership.role).toBe('Guest');
  });

  test('invite of an existing user still stores the user id', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;
    notifyUsers.mockClear();

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'Collaborator' });

    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.invitation.userId).toBe(grace.userId);
    expect(inviteRes.body.invitation.email).toBe('grace@example.com');
    expect(inviteRes.body.invitation.role).toBe('Collaborator');
    expect(notifyUsers).toHaveBeenCalledWith(
      [grace.userId],
      expect.stringContaining('Check app to accept'),
      'email',
    );
    expect(notifyUsers).toHaveBeenCalledWith(
      [grace.userId],
      expect.stringContaining('as Co-Planner'),
      'email',
    );
    expect(notifyUsers).toHaveBeenCalledWith(
      [ada.userId],
      'Invited Grace Hopper as Co-Planner.',
      'email',
    );
    expect(notifyUsers.mock.calls.some((call) => String(call[1]).includes('planitvibe.com/signup'))).toBe(false);
    expect(notifyUsers.mock.calls.every((call) => !String(call[1]).includes('undefined'))).toBe(true);
    expect(notifyUsers.mock.calls.every((call) => !String(call[1]).includes('Collaborator'))).toBe(true);

    notifyUsers.mockClear();
    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);
    expect(notifyUsers).toHaveBeenCalledWith(
      expect.any(Array),
      'Grace Hopper accepted your invite as Co-Planner!',
      'email',
    );
    expect(notifyUsers).toHaveBeenCalledWith(
      [grace.userId],
      'Welcome to the trip as Co-Planner!',
      'email',
    );
    expect(notifyUsers.mock.calls.every((call) => !String(call[1]).includes('undefined'))).toBe(true);
    expect(notifyUsers.mock.calls.every((call) => !String(call[1]).includes('Collaborator'))).toBe(true);
    expect(notifyUsers.mock.calls.every((call) => !/\bGuest\b/.test(String(call[1])))).toBe(true);
  });

  test('reassign writes Owner to the target and Collaborator to the previous owner', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'VibePlanner' });
    expect(inviteRes.status).toBe(201);

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    const reassignRes = await request(app)
      .post(`/api/plans/${planId}/reassign-coordinator`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ targetUserId: grace.userId });
    expect(reassignRes.status).toBe(200);

    const adaMembership = await PlanUser.findOne({ planId, userId: ada.userId });
    const graceMembership = await PlanUser.findOne({ planId, userId: grace.userId });
    expect(adaMembership.role).toBe('Collaborator');
    expect(graceMembership.role).toBe('Owner');
    expect((await Plan.findById(planId)).ownerId).toBe(grace.userId);
  });

  test('a leftover Wanderer invitation is stored as Guest on accept', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    await Invitation.collection.insertOne({
      _id: 'legacy-wanderer-invite',
      planId,
      userId: grace.userId,
      invitedBy: ada.userId,
      role: 'Wanderer',
      status: 'pending',
    });

    const acceptRes = await request(app)
      .post('/api/invites/invitations/legacy-wanderer-invite/respond')
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.invitation.role).toBe('Guest');

    const membership = await PlanUser.findOne({ planId, userId: grace.userId });
    expect(membership.role).toBe('Guest');
  });

  test('a leftover VibeCoordinator row can still invite', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;
    await PlanUser.updateOne({ planId, userId: ada.userId }, { $set: { role: 'VibeCoordinator' } });

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'VibePlanner' });
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.invitation.role).toBe('Collaborator');
  });
});

describe('invitation inbox', () => {
  test('unauthenticated GET /api/invites is 401', async () => {
    const res = await request(app).get('/api/invites');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token, authorization denied');
  });

  test('the invitee sees the invitation and the inviter does not', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'Collaborator' });
    expect(inviteRes.status).toBe(201);
    const invitationId = inviteRes.body.invitation._id;

    const graceList = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${grace.token}`);
    expect(graceList.status).toBe(200);
    expect(Array.isArray(graceList.body)).toBe(true);
    const pending = graceList.body.find((invitation) => invitation._id === invitationId);
    expect(pending).toBeTruthy();
    expect(pending.planId).toBe(planId);
    expect(pending.role).toBe('Collaborator');
    expect(pending.status).toBe('pending');
    expect(pending.invitedBy).toBe(ada.userId);
    expect(pending.createdAt).toBeTruthy();
    expect(pending.planName).toBe('Paris');

    const adaList = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${ada.token}`);
    expect(adaList.status).toBe(200);
    expect(adaList.body.map((invitation) => invitation._id)).not.toContain(invitationId);

    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${invitationId}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    const afterAccept = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${grace.token}`);
    const accepted = afterAccept.body.find((invitation) => invitation._id === invitationId);
    expect(accepted).toBeTruthy();
    expect(accepted.status).toBe('accepted');

    const pendingOnly = await request(app)
      .get('/api/invites')
      .query({ status: 'pending' })
      .set('Authorization', `Bearer ${grace.token}`);
    expect(pendingOnly.body.map((invitation) => invitation._id)).not.toContain(invitationId);

    const acceptedOnly = await request(app)
      .get('/api/invites')
      .query({ status: 'accepted' })
      .set('Authorization', `Bearer ${grace.token}`);
    expect(acceptedOnly.body.map((invitation) => invitation._id)).toContain(invitationId);

    const invalid = await request(app)
      .get('/api/invites')
      .query({ status: 'nope' })
      .set('Authorization', `Bearer ${grace.token}`);
    expect(invalid.status).toBe(400);
  });
});

describe('itinerary', () => {
  test('numbers days from the stored itinerary order', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });

    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const earlier = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Earlier dinner',
        type: 'dining',
        planId,
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T18:00:00.000Z',
      });
    expect(earlier.status).toBe(201);

    const later = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Later dinner',
        type: 'dining',
        planId,
        startTime: '2026-06-02T15:00:00.000Z',
        endTime: '2026-06-02T18:00:00.000Z',
      });
    expect(later.status).toBe(201);

    const res = await request(app)
      .get(`/api/plans/${planId}/itinerary`)
      .set('Authorization', `Bearer ${ada.token}`);

    expect(res.status).toBe(200);
    expect(new Date(res.body.events[0].startTime).toISOString()).toBe('2026-06-01T15:00:00.000Z');
    expect(res.body.events[0].dayNumber).toBe(1);
    expect(res.body.events[1].dayNumber).toBe(2);
  });
});

describe('activity permissions', () => {
  const dinner = (planId, name) => ({
    name,
    type: 'dining',
    planId,
    startTime: '2026-06-01T15:00:00.000Z',
    endTime: '2026-06-01T18:00:00.000Z',
  });

  test('the owner can create an activity', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send(dinner(planId, 'Owner dinner'));

    expect(created.status).toBe(201);
    expect(created.body.planId).toBe(planId);
  });

  test('an owner without a PlanUser row can still create an activity', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;
    await PlanUser.deleteOne({ planId, userId: ada.userId });

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send(dinner(planId, 'Owner dinner'));

    expect(created.status).toBe(201);
  });

  test('a collaborator can create and update an activity', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'Collaborator' });
    expect(inviteRes.status).toBe(201);
    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${grace.token}`)
      .send(dinner(planId, 'Collaborator dinner'));
    expect(created.status).toBe(201);

    const ownerEvent = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send(dinner(planId, 'Owner dinner'));
    expect(ownerEvent.status).toBe(201);

    const updated = await request(app)
      .put(`/api/activities/${ownerEvent.body._id}`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ name: 'Updated by collaborator' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Updated by collaborator');

    await PlanUser.updateOne({ planId, userId: grace.userId }, { $set: { role: 'planner' } });
    const aliasCreate = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${grace.token}`)
      .send(dinner(planId, 'Alias dinner'));
    expect(aliasCreate.status).toBe(201);

    const removed = await request(app)
      .delete(`/api/activities/${ownerEvent.body._id}`)
      .set('Authorization', `Bearer ${grace.token}`);
    expect(removed.status).toBe(200);
    expect(await Event.findById(ownerEvent.body._id)).toBeNull();
  });

  test('a guest cannot create or update an activity', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const ownerEvent = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send(dinner(planId, 'Owner dinner'));
    expect(ownerEvent.status).toBe(201);

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'Guest' });
    expect(inviteRes.status).toBe(201);
    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    const before = await Event.countDocuments({ planId });
    const denied = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${grace.token}`)
      .send(dinner(planId, 'Guest dinner'));
    expect(denied.status).toBe(403);
    expect(await Event.countDocuments({ planId })).toBe(before);

    const deniedUpdate = await request(app)
      .put(`/api/activities/${ownerEvent.body._id}`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ name: 'Guest edit' });
    expect(deniedUpdate.status).toBe(403);
    expect((await Event.findById(ownerEvent.body._id)).name).toBe('Owner dinner');

    const itinerary = await request(app)
      .get(`/api/plans/${planId}/itinerary`)
      .set('Authorization', `Bearer ${grace.token}`);
    expect(itinerary.status).toBe(200);
  });

  test('a user who is not a member cannot create an activity', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const alan = await registerAndLogin({
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      password: 'password3',
    });
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const before = await Event.countDocuments({ planId });
    const denied = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${alan.token}`)
      .send(dinner(planId, 'Stranger dinner'));

    expect(denied.status).toBe(403);
    expect(await Event.countDocuments({ planId })).toBe(before);
  });

  test('changing a flight to a hotel clears flight-only fields', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'AA 100',
        type: 'flight',
        planId,
        location: 'JFK',
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T18:00:00.000Z',
        originTimeZone: 'America/New_York',
        destinationTimeZone: 'Europe/Paris',
        gate: 'B12',
        baggageClaim: '4',
      });
    expect(created.status).toBe(201);

    const updated = await request(app)
      .put(`/api/activities/${created.body._id}`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'hotel', gate: 'Z9' });
    expect(updated.status).toBe(200);
    expect(updated.body.type).toBe('hotel');
    expect(updated.body.name).toBe('AA 100');
    expect(updated.body.location).toBe('JFK');

    const stored = await Event.findById(created.body._id);
    expect(stored.type).toBe('hotel');
    expect(stored.name).toBe('AA 100');
    expect(stored.location).toBe('JFK');
    expect(stored.originTimeZone).toBeFalsy();
    expect(stored.destinationTimeZone).toBeFalsy();
    expect(stored.gate).toBeFalsy();
    expect(stored.baggageClaim).toBeFalsy();
  });
});

describe('activity routes', () => {
  const dinner = (planId, name) => ({
    name,
    type: 'dining',
    planId,
    startTime: '2026-06-01T15:00:00.000Z',
    endTime: '2026-06-01T18:00:00.000Z',
  });

  test('POST /api/activities creates in the activities collection', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send(dinner(planId, 'Harbor dinner'));

    expect(created.status).toBe(201);
    expect(created.body.planId).toBe(planId);
    expect(Event.collection.collectionName).toBe('activities');
    expect(Plan.collection.collectionName).toBe('plans');
    const stored = await Event.find({ planId }).select('name');
    expect(stored.map((row) => row.name)).toEqual(['Harbor dinner']);
    const inActivities = await mongoose.connection.db.collection('activities').find({ planId }).toArray();
    expect(inActivities.map((row) => row.name)).toEqual(['Harbor dinner']);
    expect(await mongoose.connection.db.collection('events').countDocuments({ planId })).toBe(0);

    const inviteRes = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ email: 'grace@example.com', role: 'Guest' });
    expect(inviteRes.status).toBe(201);
    const acceptRes = await request(app)
      .post(`/api/invites/invitations/${inviteRes.body.invitation._id}/respond`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ status: 'accepted' });
    expect(acceptRes.status).toBe(200);

    const before = await Event.countDocuments({ planId });
    const denied = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${grace.token}`)
      .send(dinner(planId, 'Guest dinner'));
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Only Owner or Collaborator can change activities');
    expect(await Event.countDocuments({ planId })).toBe(before);
  });

  test('authenticated POST /api/events returns 404', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada-old-path@example.com',
      password: 'password1',
    });
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'trip', name: 'Lisbon', destination: 'Lisbon', timeZone: 'UTC' });
    const planId = planRes.body.plan._id;
    const before = await Event.countDocuments({ planId });

    const removed = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ada.token}`)
      .send(dinner(planId, 'Old path dinner'));

    expect(removed.status).toBe(404);
    expect(await Event.countDocuments({ planId })).toBe(before);
  });
});

describe('activity history', () => {
  const flight = (planId) => ({
    name: 'AA 100',
    type: 'flight',
    planId,
    location: 'JFK',
    startTime: '2026-06-01T15:00:00.000Z',
    endTime: '2026-06-01T18:00:00.000Z',
    originTimeZone: 'America/New_York',
    destinationTimeZone: 'Europe/Paris',
    gate: 'B12',
    baggageClaim: '4',
  });

  async function planFor(token) {
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    return planRes.body.plan._id;
  }

  async function acceptInvite(ownerToken, planId, email, role, memberToken) {
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

  test('create, update, and delete record revisions that stay readable after delete', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const sam = await registerAndLogin({
      firstName: 'Sam',
      lastName: 'Guest',
      email: 'sam@example.com',
      password: 'password3',
    });
    const planId = await planFor(ada.token);
    await acceptInvite(ada.token, planId, 'grace@example.com', 'Collaborator', grace.token);
    await acceptInvite(ada.token, planId, 'sam@example.com', 'Guest', sam.token);

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send(flight(planId));
    expect(created.status).toBe(201);
    const eventId = created.body._id;

    const afterCreate = await request(app)
      .get(`/api/activities/${eventId}/history`)
      .set('Authorization', `Bearer ${ada.token}`);
    expect(afterCreate.status).toBe(200);
    expect(afterCreate.body).toHaveLength(1);
    expect(afterCreate.body[0].action).toBe('create');
    expect(afterCreate.body[0].eventId).toBe(eventId);
    expect(afterCreate.body[0].planId).toBe(planId);
    expect(afterCreate.body[0].userId).toBe(ada.userId);
    expect(afterCreate.body[0].snapshot.name).toBe('AA 100');
    expect(afterCreate.body[0].snapshot.type).toBe('flight');
    expect(afterCreate.body[0].snapshot.gate).toBe('B12');
    expect(afterCreate.body[0].deleted).toBe(false);

    const updated = await request(app)
      .put(`/api/activities/${eventId}`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ type: 'hotel', gate: 'Z9' });
    expect(updated.status).toBe(200);
    const stored = await Event.findById(eventId);
    expect(stored.type).toBe('hotel');
    expect(stored.name).toBe('AA 100');
    expect(stored.gate).toBeFalsy();
    expect(stored.originTimeZone).toBeFalsy();

    const afterUpdate = await request(app)
      .get(`/api/activities/${eventId}/history`)
      .set('Authorization', `Bearer ${grace.token}`);
    expect(afterUpdate.status).toBe(200);
    expect(afterUpdate.body.map((row) => row.action)).toEqual(['update', 'create']);
    const updateRow = afterUpdate.body[0];
    expect(updateRow.userId).toBe(grace.userId);
    expect(updateRow.planId).toBe(planId);
    expect(updateRow.snapshot.name).toBe(stored.name);
    expect(updateRow.snapshot.type).toBe(stored.type);
    expect(updateRow.snapshot.location).toBe(stored.location);
    expect(updateRow.snapshot.gate).toBeFalsy();
    expect(updateRow.snapshot.originTimeZone).toBeFalsy();
    expect(updateRow.snapshot.destinationTimeZone).toBeFalsy();
    expect(updateRow.snapshot.baggageClaim).toBeFalsy();
    expect(await ActivityRevision.countDocuments({ eventId, action: 'update' })).toBe(1);

    const guestPut = await request(app)
      .put(`/api/activities/${eventId}`)
      .set('Authorization', `Bearer ${sam.token}`)
      .send({ name: 'Guest edit' });
    expect(guestPut.status).toBe(403);
    const guestDelete = await request(app)
      .delete(`/api/activities/${eventId}`)
      .set('Authorization', `Bearer ${sam.token}`);
    expect(guestDelete.status).toBe(403);
    expect(await ActivityRevision.countDocuments({ eventId })).toBe(2);
    expect((await Event.findById(eventId)).name).toBe('AA 100');

    const removed = await request(app)
      .delete(`/api/activities/${eventId}`)
      .set('Authorization', `Bearer ${ada.token}`);
    expect(removed.status).toBe(200);
    expect(await Event.findById(eventId)).toBeNull();

    await PlanUser.updateOne({ planId, userId: sam.userId }, { $set: { role: 'Wanderer' } });
    const history = await request(app)
      .get(`/api/activities/${eventId}/history`)
      .set('Authorization', `Bearer ${sam.token}`);
    expect(history.status).toBe(200);
    expect(Array.isArray(history.body)).toBe(true);
    expect(history.body.map((row) => row.action)).toEqual(['delete', 'update', 'create']);
    expect(history.body[0].deleted).toBe(true);
    expect(history.body[0].userId).toBe(ada.userId);
    expect(history.body[0].snapshot.name).toBe('AA 100');
    expect(history.body[0].snapshot.type).toBe('hotel');
    expect(history.body[0].snapshot.deleted).toBeUndefined();
    expect(history.body[1].snapshot.type).toBe('hotel');
    expect(history.body[2].snapshot.name).toBe('AA 100');
    expect(history.body[2].snapshot.gate).toBe('B12');
    for (const row of history.body) {
      expect(row).toEqual(expect.objectContaining({
        _id: expect.any(String),
        eventId,
        planId,
        userId: expect.any(String),
        action: expect.any(String),
        snapshot: expect.any(Object),
        createdAt: expect.any(String),
      }));
    }
  });

  test('a failed type change does not record a revision', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planId = await planFor(ada.token);
    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Lunch',
        type: 'dining',
        planId,
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T16:00:00.000Z',
      });
    expect(created.status).toBe(201);

    await Event.updateOne({ _id: created.body._id }, {
      $set: {
        startTimeZone: '',
        endTimeZone: '',
        originTimeZone: '',
        destinationTimeZone: '',
        timeZone: '',
      },
    });

    const denied = await request(app)
      .put(`/api/activities/${created.body._id}`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'flight' });
    expect(denied.status).toBe(400);
    expect((await Event.findById(created.body._id)).type).toBe('dining');
    expect(await ActivityRevision.countDocuments({ eventId: created.body._id })).toBe(1);
    expect(await ActivityRevision.countDocuments({ eventId: created.body._id, action: 'update' })).toBe(0);
  });

  test('the plan owner can read history without a PlanUser row', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planId = await planFor(ada.token);
    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Owner dinner',
        type: 'dining',
        planId,
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T18:00:00.000Z',
      });
    expect(created.status).toBe(201);
    await PlanUser.deleteOne({ planId, userId: ada.userId });

    const history = await request(app)
      .get(`/api/activities/${created.body._id}/history`)
      .set('Authorization', `Bearer ${ada.token}`);
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].snapshot.name).toBe('Owner dinner');
  });

  test('a non-member cannot read history', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const alan = await registerAndLogin({
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      password: 'password3',
    });
    const planId = await planFor(ada.token);
    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Owner dinner',
        type: 'dining',
        planId,
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T18:00:00.000Z',
      });
    expect(created.status).toBe(201);

    const denied = await request(app)
      .get(`/api/activities/${created.body._id}/history`)
      .set('Authorization', `Bearer ${alan.token}`);
    expect(denied.status).toBe(403);
    expect(Array.isArray(denied.body)).toBe(false);
  });

  test('history without a token is 401', async () => {
    const res = await request(app).get('/api/activities/missing-event/history');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token, authorization denied');
  });

  test('an unknown activity with no revisions is 404', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const res = await request(app)
      .get('/api/activities/does-not-exist/history')
      .set('Authorization', `Bearer ${ada.token}`);
    expect(res.status).toBe(404);
  });
});

describe('activity restore', () => {
  const flight = (planId) => ({
    name: 'AA 100',
    type: 'flight',
    planId,
    location: 'JFK',
    startTime: '2026-06-01T15:00:00.000Z',
    endTime: '2026-06-01T18:00:00.000Z',
    originTimeZone: 'America/New_York',
    destinationTimeZone: 'Europe/Paris',
    gate: 'B12',
    baggageClaim: '4',
  });

  async function planFor(token) {
    const planRes = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'trip', name: 'Paris', destination: 'Paris', timeZone: 'UTC' });
    return planRes.body.plan._id;
  }

  async function acceptInvite(ownerToken, planId, email, role, memberToken) {
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

  async function historyOf(eventId, token) {
    const res = await request(app)
      .get(`/api/activities/${eventId}/history`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  test('a collaborator can restore the create revision over a later edit', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const planId = await planFor(ada.token);
    await acceptInvite(ada.token, planId, 'grace@example.com', 'Collaborator', grace.token);

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Lunch',
        type: 'dining',
        planId,
        location: 'Cafe',
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T16:00:00.000Z',
      });
    expect(created.status).toBe(201);
    const eventId = created.body._id;
    const createRevisionId = (await historyOf(eventId, ada.token))[0]._id;

    const updated = await request(app)
      .put(`/api/activities/${eventId}`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ name: 'Dinner' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Dinner');

    const restored = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ revisionId: createRevisionId, name: 'Hacked', location: 'Nowhere' });
    expect(restored.status).toBe(200);
    expect(restored.body._id).toBe(eventId);
    expect(restored.body.name).toBe('Lunch');
    expect(restored.body.location).toBe('Cafe');
    expect(restored.body.type).toBe('dining');
    expect(restored.body.planId).toBe(planId);

    const stored = await Event.findById(eventId);
    expect(stored.name).toBe('Lunch');
    expect(stored.location).toBe('Cafe');

    const history = await historyOf(eventId, ada.token);
    expect(history.map((row) => row.action)).toEqual(['update', 'update', 'create']);
    expect(history[0].deleted).toBe(false);
    expect(history[0].userId).toBe(grace.userId);
    expect(history[0].snapshot.name).toBe('Lunch');
    expect(history[0].snapshot.location).toBe('Cafe');

    const listed = await request(app)
      .get(`/api/activities/plan/${planId}`)
      .set('Authorization', `Bearer ${ada.token}`);
    expect(listed.status).toBe(200);
    const row = listed.body.find((event) => event._id === eventId);
    expect(row.name).toBe('Lunch');
    expect(row.location).toBe('Cafe');
    expect(row.type).toBe('dining');
  });

  test('restoring a deleted activity reinserts the same id and records an update', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planId = await planFor(ada.token);
    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Museum',
        type: 'tour',
        planId,
        location: 'Louvre',
        startTime: '2026-06-02T10:00:00.000Z',
        endTime: '2026-06-02T12:00:00.000Z',
      });
    expect(created.status).toBe(201);
    const eventId = created.body._id;

    const removed = await request(app)
      .delete(`/api/activities/${eventId}`)
      .set('Authorization', `Bearer ${ada.token}`);
    expect(removed.status).toBe(200);
    expect(await Event.findById(eventId)).toBeNull();

    const deleteRevisionId = (await historyOf(eventId, ada.token))[0]._id;
    expect((await historyOf(eventId, ada.token))[0].action).toBe('delete');

    const restored = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ revisionId: deleteRevisionId });
    expect(restored.status).toBe(200);
    expect(restored.body._id).toBe(eventId);
    expect(restored.body.name).toBe('Museum');
    expect(restored.body.type).toBe('tour');
    expect(restored.body.location).toBe('Louvre');
    expect(restored.body.planId).toBe(planId);

    const stored = await Event.findById(eventId);
    expect(stored).not.toBeNull();
    expect(String(stored._id)).toBe(eventId);
    expect(stored.name).toBe('Museum');

    // Reinsert keeps the original activity id, so the new revision is action update.
    const history = await historyOf(eventId, ada.token);
    expect(history.map((row) => row.action)).toEqual(['update', 'delete', 'create']);
    expect(history[0].deleted).toBe(false);
    expect(history[0].snapshot.name).toBe('Museum');
    expect(history[0].snapshot._id).toBe(eventId);
    expect(history[1].action).toBe('delete');
    expect(history[1].deleted).toBe(true);

    const itinerary = await request(app)
      .get(`/api/plans/${planId}/itinerary`)
      .set('Authorization', `Bearer ${ada.token}`);
    expect(itinerary.status).toBe(200);
    const row = itinerary.body.events.find((event) => event._id === eventId);
    expect(row).toBeTruthy();
    expect(row.name).toBe('Museum');
    expect(row.type).toBe('tour');
    expect(row.location).toBe('Louvre');
  });

  test('a guest cannot restore an activity', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const sam = await registerAndLogin({
      firstName: 'Sam',
      lastName: 'Guest',
      email: 'sam@example.com',
      password: 'password3',
    });
    const planId = await planFor(ada.token);
    await acceptInvite(ada.token, planId, 'sam@example.com', 'Guest', sam.token);

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Lunch',
        type: 'dining',
        planId,
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T16:00:00.000Z',
      });
    expect(created.status).toBe(201);
    const eventId = created.body._id;
    const createRevisionId = (await historyOf(eventId, ada.token))[0]._id;
    const before = await ActivityRevision.countDocuments({ eventId });

    const denied = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${sam.token}`)
      .send({ revisionId: createRevisionId, name: 'Guest edit' });
    expect(denied.status).toBe(403);
    expect((await Event.findById(eventId)).name).toBe('Lunch');
    expect(await ActivityRevision.countDocuments({ eventId })).toBe(before);
  });

  test('a non-member cannot restore an activity', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const alan = await registerAndLogin({
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.com',
      password: 'password3',
    });
    const planId = await planFor(ada.token);
    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Lunch',
        type: 'dining',
        planId,
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T16:00:00.000Z',
      });
    expect(created.status).toBe(201);
    const eventId = created.body._id;
    const createRevisionId = (await historyOf(eventId, ada.token))[0]._id;
    const before = await ActivityRevision.countDocuments({ eventId });

    const denied = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${alan.token}`)
      .send({ revisionId: createRevisionId });
    expect(denied.status).toBe(403);
    expect((await Event.findById(eventId)).name).toBe('Lunch');
    expect(await ActivityRevision.countDocuments({ eventId })).toBe(before);
  });

  test('restore without a token is 401', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planId = await planFor(ada.token);
    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Lunch',
        type: 'dining',
        planId,
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T16:00:00.000Z',
      });
    expect(created.status).toBe(201);
    const eventId = created.body._id;
    const before = await ActivityRevision.countDocuments({ eventId });

    const res = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .send({ revisionId: 'any-revision' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token, authorization denied');
    expect((await Event.findById(eventId)).name).toBe('Lunch');
    expect(await ActivityRevision.countDocuments({ eventId })).toBe(before);
  });

  test('a revision from a different activity is 400', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planId = await planFor(ada.token);
    const first = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Lunch',
        type: 'dining',
        planId,
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T16:00:00.000Z',
      });
    const second = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Museum',
        type: 'tour',
        planId,
        startTime: '2026-06-02T10:00:00.000Z',
        endTime: '2026-06-02T12:00:00.000Z',
      });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const eventId = first.body._id;
    const otherRevisionId = (await historyOf(second.body._id, ada.token))[0]._id;
    const before = await ActivityRevision.countDocuments({ eventId });

    const res = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ revisionId: otherRevisionId });
    expect(res.status).toBe(400);
    expect((await Event.findById(eventId)).name).toBe('Lunch');
    expect(await ActivityRevision.countDocuments({ eventId })).toBe(before);
    expect(await ActivityRevision.countDocuments({ eventId: second.body._id })).toBe(1);
  });

  test('restoring a flight snapshot keeps type flight and time zones', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const grace = await registerAndLogin({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
      password: 'password2',
    });
    const planId = await planFor(ada.token);
    await acceptInvite(ada.token, planId, 'grace@example.com', 'Collaborator', grace.token);

    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send(flight(planId));
    expect(created.status).toBe(201);
    const eventId = created.body._id;
    const createRevisionId = (await historyOf(eventId, ada.token))[0]._id;

    const updated = await request(app)
      .put(`/api/activities/${eventId}`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ type: 'hotel', roomNumber: '12' });
    expect(updated.status).toBe(200);
    expect(updated.body.type).toBe('hotel');
    expect(updated.body.roomNumber).toBe('12');
    expect(updated.body.originTimeZone).toBeFalsy();
    expect(updated.body.destinationTimeZone).toBeFalsy();
    expect(updated.body.gate).toBeFalsy();

    const restored = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${grace.token}`)
      .send({ revisionId: createRevisionId, type: 'dining', originTimeZone: 'UTC' });
    expect(restored.status).toBe(200);
    expect(restored.body._id).toBe(eventId);
    expect(restored.body.type).toBe('flight');
    expect(restored.body.name).toBe('AA 100');
    expect(restored.body.originTimeZone).toBe('America/New_York');
    expect(restored.body.destinationTimeZone).toBe('Europe/Paris');
    expect(restored.body.gate).toBe('B12');
    expect(restored.body.baggageClaim).toBe('4');
    expect(restored.body.roomNumber).toBeFalsy();

    const stored = await Event.findById(eventId);
    expect(stored.type).toBe('flight');
    expect(stored.originTimeZone).toBe('America/New_York');
    expect(stored.destinationTimeZone).toBe('Europe/Paris');
    expect(stored.gate).toBe('B12');
    expect(stored.baggageClaim).toBe('4');
    expect(stored.roomNumber).toBeFalsy();

    const history = await historyOf(eventId, grace.token);
    expect(history[0].action).toBe('update');
    expect(history[0].deleted).toBe(false);
    expect(history[0].userId).toBe(grace.userId);
    expect(history[0].snapshot.type).toBe('flight');
    expect(history[0].snapshot.originTimeZone).toBe('America/New_York');
    expect(history[0].snapshot.destinationTimeZone).toBe('Europe/Paris');
    expect(history[0].snapshot.gate).toBe('B12');
    expect(history[0].snapshot.roomNumber).toBeFalsy();
  });

  test('a flight snapshot without time zones is 400 and does not write', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planId = await planFor(ada.token);
    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'AA 100',
        type: 'flight',
        planId,
        location: 'JFK',
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T18:00:00.000Z',
      });
    expect(created.status).toBe(201);
    expect(created.body.startTimeZone).toBe('UTC');
    expect(created.body.endTimeZone).toBe('UTC');
    const eventId = created.body._id;
    const createRevisionId = (await historyOf(eventId, ada.token))[0]._id;
    const before = await ActivityRevision.countDocuments({ eventId });

    await Event.updateOne({ _id: eventId }, {
      $set: {
        startTimeZone: '',
        endTimeZone: '',
        originTimeZone: '',
        destinationTimeZone: '',
        timeZone: '',
      },
    });

    const denied = await request(app)
      .put(`/api/activities/${eventId}`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ name: 'AA 200' });
    expect(denied.status).toBe(400);
    expect(denied.body.message).toMatch(/startTimeZone/);
    expect((await Event.findById(eventId)).name).toBe('AA 100');

    const revision = await ActivityRevision.findById(createRevisionId);
    revision.snapshot = {
      ...revision.snapshot,
      startTimeZone: '',
      endTimeZone: '',
      originTimeZone: '',
      destinationTimeZone: '',
      timeZone: '',
    };
    revision.markModified('snapshot');
    await revision.save();

    const restored = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ revisionId: createRevisionId, originTimeZone: 'UTC', destinationTimeZone: 'UTC' });
    expect(restored.status).toBe(400);
    expect(restored.body.message).toMatch(/startTimeZone/);
    expect((await Event.findById(eventId)).name).toBe('AA 100');
    expect((await Event.findById(eventId)).type).toBe('flight');
    expect(await ActivityRevision.countDocuments({ eventId })).toBe(before);
  });

  test('a missing revision is 404 and a revision from another plan does not write', async () => {
    const ada = await registerAndLogin({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password1',
    });
    const planId = await planFor(ada.token);
    const created = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${ada.token}`)
      .send({
        name: 'Lunch',
        type: 'dining',
        planId,
        location: 'Cafe',
        startTime: '2026-06-01T15:00:00.000Z',
        endTime: '2026-06-01T16:00:00.000Z',
      });
    expect(created.status).toBe(201);
    const eventId = created.body._id;

    const missing = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ revisionId: 'does-not-exist' });
    expect(missing.status).toBe(404);
    expect((await Event.findById(eventId)).name).toBe('Lunch');

    const forged = await ActivityRevision.create({
      eventId,
      planId: 'other-plan',
      userId: ada.userId,
      action: 'update',
      snapshot: {
        name: 'Moved',
        type: 'dining',
        planId: 'other-plan',
        ownerId: ada.userId,
        location: 'Elsewhere',
      },
      deleted: false,
    });
    const before = await ActivityRevision.countDocuments({ eventId });
    const wrongPlan = await request(app)
      .post(`/api/activities/${eventId}/restore`)
      .set('Authorization', `Bearer ${ada.token}`)
      .send({ revisionId: forged._id });
    expect(wrongPlan.status).toBe(400);
    expect((await Event.findById(eventId)).name).toBe('Lunch');
    expect((await Event.findById(eventId)).planId).toBe(planId);
    expect(await ActivityRevision.countDocuments({ eventId })).toBe(before);
  });
});
