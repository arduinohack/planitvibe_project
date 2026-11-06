jest.mock('../utils/notifications', () => ({
  notifyUsers: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/User');
const Invitation = require('../models/Invitation');
const AllowedEmail = require('../models/AllowedEmail');
const { allowRegister, clearRegisterInvite } = require('./inviteForRegister');

jest.setTimeout(30000);

let mongo;

function registerBody(email) {
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email,
    password: 'password1',
  };
}

async function registerAndLogin(email) {
  await allowRegister(email);
  const registerRes = await request(app).post('/api/auth/register').send(registerBody(email));
  await clearRegisterInvite(email);
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'password1' });
  return { registerRes, loginRes };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Invitation.deleteMany({}),
    AllowedEmail.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('allowed email registration', () => {
  test('an allowed email can register and log in', async () => {
    const { registerRes, loginRes } = await registerAndLogin('Ada@Example.com');
    expect(registerRes.status).toBe(201);
    expect(loginRes.status).toBe(200);
    expect(typeof loginRes.body.token).toBe('string');
    expect(loginRes.body.token.length).toBeGreaterThan(0);
    expect(await User.countDocuments({ email: 'Ada@Example.com' })).toBe(1);
  });

  test('a disallowed email cannot register', async () => {
    await Invitation.create({
      _id: 'pending-not-allowed',
      planId: 'plan-1',
      email: 'ada@example.com',
      invitedBy: 'owner-1',
      role: 'Guest',
      status: 'pending',
    });
    const res = await request(app).post('/api/auth/register').send(registerBody('ada@example.com'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This email is not yet invited to join PlanItVibe.');
    expect(await User.countDocuments()).toBe(0);
  });
});

describe('admin allowed emails', () => {
  test('list, add, and remove require an admin and show account createdAt', async () => {
    const adminSession = await registerAndLogin('admin@example.com');
    expect(adminSession.registerRes.status).toBe(201);
    const admin = await User.findOne({ email: 'admin@example.com' });
    await User.updateOne({ _id: admin._id }, { $set: { role: 'admin' } });
    const member = await registerAndLogin('member@example.com');
    expect(member.loginRes.status).toBe(200);

    const noToken = await request(app).get('/api/admin/allowed-emails');
    expect(noToken.status).toBe(401);
    expect(noToken.body.message).toBe('No token, authorization denied');

    const memberGet = await request(app)
      .get('/api/admin/allowed-emails')
      .set('Authorization', `Bearer ${member.loginRes.body.token}`);
    expect(memberGet.status).toBe(403);
    expect(memberGet.body.message).toBe('Admin access required');

    const memberPost = await request(app)
      .post('/api/admin/allowed-emails')
      .set('Authorization', `Bearer ${member.loginRes.body.token}`)
      .send({ email: 'new@example.com' });
    expect(memberPost.status).toBe(403);

    const added = await request(app)
      .post('/api/admin/allowed-emails')
      .set('Authorization', `Bearer ${adminSession.loginRes.body.token}`)
      .send({ email: '  New.Person@Example.com ', note: 'from the desk' });
    expect(added.status).toBe(201);
    expect(added.body.email).toBe('new.person@example.com');
    expect(added.body.note).toBe('from the desk');
    expect(added.body.createdAt).toBeTruthy();

    const duplicate = await request(app)
      .post('/api/admin/allowed-emails')
      .set('Authorization', `Bearer ${adminSession.loginRes.body.token}`)
      .send({ email: 'new.person@example.com' });
    expect(duplicate.status).toBe(409);

    await Invitation.create({
      _id: 'pending-new-person',
      planId: 'plan-1',
      email: 'new.person@example.com',
      invitedBy: 'owner-1',
      role: 'Guest',
      status: 'pending',
    });
    const registered = await request(app)
      .post('/api/auth/register')
      .send(registerBody('New.Person@Example.com'));
    expect(registered.status).toBe(201);
    const account = await User.findOne({ email: 'New.Person@Example.com' });

    const listed = await request(app)
      .get('/api/admin/allowed-emails')
      .set('Authorization', `Bearer ${adminSession.loginRes.body.token}`);
    expect(listed.status).toBe(200);
    const row = listed.body.emails.find((item) => item.email === 'new.person@example.com');
    expect(row.note).toBe('from the desk');
    expect(row.createdAt).toBeTruthy();
    expect(new Date(row.userCreatedAt).toISOString()).toBe(account.createdAt.toISOString());
    const memberRow = listed.body.emails.find((item) => item.email === 'member@example.com');
    expect(memberRow.userCreatedAt).toBeTruthy();

    const memberDelete = await request(app)
      .delete('/api/admin/allowed-emails/new.person@example.com')
      .set('Authorization', `Bearer ${member.loginRes.body.token}`);
    expect(memberDelete.status).toBe(403);

    const removed = await request(app)
      .delete('/api/admin/allowed-emails/new.person%40example.com')
      .set('Authorization', `Bearer ${adminSession.loginRes.body.token}`);
    expect(removed.status).toBe(200);
    expect(removed.body.email).toBe('new.person@example.com');

    const after = await request(app)
      .get('/api/admin/allowed-emails')
      .set('Authorization', `Bearer ${adminSession.loginRes.body.token}`);
    expect(after.body.emails.some((item) => item.email === 'new.person@example.com')).toBe(false);

    const spare = await request(app)
      .post('/api/admin/allowed-emails')
      .set('Authorization', `Bearer ${adminSession.loginRes.body.token}`)
      .send({ email: 'spare@example.com' });
    expect(spare.status).toBe(201);
    const removedSpare = await request(app)
      .delete('/api/admin/allowed-emails/spare@example.com')
      .set('Authorization', `Bearer ${adminSession.loginRes.body.token}`);
    expect(removedSpare.status).toBe(200);
    await Invitation.create({
      _id: 'pending-spare',
      planId: 'plan-1',
      email: 'spare@example.com',
      invitedBy: 'owner-1',
      role: 'Guest',
      status: 'pending',
    });
    const blocked = await request(app)
      .post('/api/auth/register')
      .send(registerBody('spare@example.com'));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('This email is not yet invited to join PlanItVibe.');
    expect(await User.countDocuments({ email: 'spare@example.com' })).toBe(0);
  });
});
