jest.mock('../utils/email/sendEmail', () => {
  const actual = jest.requireActual('../utils/email/sendEmail');
  return {
    ...actual,
    sendEmail: jest.fn().mockResolvedValue({ id: 'email_1' }),
  };
});

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
const SignupInviteConfig = require('../models/SignupInviteConfig');
const { sendEmail } = require('../utils/email/sendEmail');
const { allowRegister, clearRegisterInvite } = require('./inviteForRegister');
const {
  sendSignupInvite,
  signupInviteFrom,
} = require('../utils/invites/sendSignupInvite');

jest.setTimeout(30000);

const ENV_KEYS = ['SIGNUP_INVITE_MODE', 'SIGNUP_URL', 'EMAIL_ACCOUNTS', 'EMAIL_FROM'];
const SUBJECT = "You're invited to try PlanItVibe";

let mongo;
let envSnapshot;

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

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function adminToken() {
  const session = await registerAndLogin('admin@example.com');
  expect(session.registerRes.status).toBe(201);
  expect(session.loginRes.status).toBe(200);
  const admin = await User.findOne({ email: 'admin@example.com' });
  await User.updateOne({ _id: admin._id }, { $set: { role: 'admin' } });
  await AllowedEmail.updateMany({}, { $set: { invitedAt: new Date('2026-01-01T00:00:00.000Z') } });
  sendEmail.mockClear();
  return session.loginRes.body.token;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ id: 'email_1' });
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
  await Promise.all([
    User.deleteMany({}),
    Invitation.deleteMany({}),
    AllowedEmail.deleteMany({}),
    SignupInviteConfig.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('sendSignupInvite', () => {
  test('sends the signup link and can be called on its own', async () => {
    const result = await sendSignupInvite({
      email: 'ada@example.com',
      signupUrl: 'https://example.com/start',
      from: 'PlanItVibe <desk@example.com>',
    });

    expect(result).toEqual({ success: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0][0];
    expect(message.to).toBe('ada@example.com');
    expect(message.from).toBe('PlanItVibe <desk@example.com>');
    expect(message.subject).toBe(SUBJECT);
    expect(message.text).toContain(SUBJECT);
    expect(message.text).toContain('https://example.com/start');
    expect(message.html).toContain('https://example.com/start');
  });

  test('returns failure when mail errors and does not throw', async () => {
    sendEmail.mockRejectedValueOnce(new Error('mailbox down'));
    const result = await sendSignupInvite({
      email: 'ada@example.com',
      signupUrl: 'https://example.com/start',
    });
    expect(result).toEqual({ success: false, error: 'mailbox down' });
  });

  test('uses EMAIL_ACCOUNTS and falls back to EMAIL_FROM', () => {
    process.env.EMAIL_ACCOUNTS = 'Accounts <accounts@mail.eratespecialists.com>';
    process.env.EMAIL_FROM = 'mail@mail.eratespecialists.com';
    expect(signupInviteFrom()).toBe('PlanItVibe <accounts@mail.eratespecialists.com>');
    delete process.env.EMAIL_ACCOUNTS;
    expect(signupInviteFrom()).toBe('PlanItVibe <mail@mail.eratespecialists.com>');
  });
});

describe('signup invite mode', () => {
  test('automatic add sets invitedAt and calls sendEmail', async () => {
    const token = await adminToken();
    process.env.SIGNUP_URL = 'https://planitvibe.com/signup';
    process.env.EMAIL_ACCOUNTS = 'accounts@mail.eratespecialists.com';
    const mode = await request(app)
      .put('/api/admin/allowed-emails/mode')
      .set(auth(token))
      .send({ mode: 'automatic' });
    expect(mode.status).toBe(200);
    expect(mode.body.mode).toBe('automatic');

    const added = await request(app)
      .post('/api/admin/allowed-emails')
      .set(auth(token))
      .send({ email: 'New.Person@Example.com', note: 'desk' });
    expect(added.status).toBe(201);
    expect(added.body.email).toBe('new.person@example.com');
    expect(added.body.invitedAt).toBeTruthy();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0][0];
    expect(message.to).toBe('new.person@example.com');
    expect(message.from).toBe('PlanItVibe <accounts@mail.eratespecialists.com>');
    expect(message.subject).toBe(SUBJECT);
    expect(message.text).toContain(
      'https://planitvibe.com/signup?email=new.person%40example.com',
    );

    const row = await AllowedEmail.findOne({ email: 'new.person@example.com' });
    expect(new Date(added.body.invitedAt).toISOString()).toBe(row.invitedAt.toISOString());

    const listed = await request(app)
      .get('/api/admin/allowed-emails')
      .set(auth(token));
    expect(listed.status).toBe(200);
    expect(listed.body.mode).toBe('automatic');
    const listedRow = listed.body.emails.find((item) => item.email === 'new.person@example.com');
    expect(new Date(listedRow.invitedAt).toISOString()).toBe(row.invitedAt.toISOString());
  });

  test('a failed automatic send still adds the address with invitedAt null', async () => {
    const token = await adminToken();
    await request(app)
      .put('/api/admin/allowed-emails/mode')
      .set(auth(token))
      .send({ mode: 'automatic' });
    sendEmail.mockRejectedValueOnce(new Error('mailbox down'));

    const added = await request(app)
      .post('/api/admin/allowed-emails')
      .set(auth(token))
      .send({ email: 'later@example.com' });
    expect(added.status).toBe(201);
    expect(added.body.invitedAt).toBeNull();
    const row = await AllowedEmail.findOne({ email: 'later@example.com' });
    expect(row.invitedAt).toBeNull();
  });

  test('manual add leaves invitedAt null and send-invites sets it', async () => {
    delete process.env.SIGNUP_INVITE_MODE;
    const token = await adminToken();
    const added = await request(app)
      .post('/api/admin/allowed-emails')
      .set(auth(token))
      .send({ email: 'waiting@example.com' });
    expect(added.status).toBe(201);
    expect(added.body.invitedAt).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();

    const before = await request(app)
      .get('/api/admin/allowed-emails')
      .set(auth(token));
    expect(before.body.mode).toBe('manual');
    expect(before.body.unsent).toBe(1);
    const waiting = before.body.emails.find((item) => item.email === 'waiting@example.com');
    expect(waiting.invitedAt).toBeNull();

    const sent = await request(app)
      .post('/api/admin/allowed-emails/send-invites')
      .set(auth(token));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ sent: 1, failed: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('waiting@example.com');

    const row = await AllowedEmail.findOne({ email: 'waiting@example.com' });
    expect(row.invitedAt).toBeInstanceOf(Date);

    sendEmail.mockClear();
    const again = await request(app)
      .post('/api/admin/allowed-emails/send-invites')
      .set(auth(token));
    expect(again.body).toEqual({ sent: 0, failed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('send-invites counts a failure and leaves that invitedAt null', async () => {
    const token = await adminToken();
    await request(app)
      .post('/api/admin/allowed-emails')
      .set(auth(token))
      .send({ email: 'a-fail@example.com' });
    await request(app)
      .post('/api/admin/allowed-emails')
      .set(auth(token))
      .send({ email: 'b-ok@example.com' });
    sendEmail.mockReset();
    sendEmail.mockRejectedValueOnce(new Error('mailbox down'));
    sendEmail.mockResolvedValue({ id: 'email_1' });

    const sent = await request(app)
      .post('/api/admin/allowed-emails/send-invites')
      .set(auth(token));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ sent: 1, failed: 1 });

    const failed = await AllowedEmail.findOne({ email: 'a-fail@example.com' });
    const ok = await AllowedEmail.findOne({ email: 'b-ok@example.com' });
    expect(failed.invitedAt).toBeNull();
    expect(ok.invitedAt).toBeInstanceOf(Date);
  });

  test('a saved mode overrides the environment without a restart', async () => {
    const token = await adminToken();
    process.env.SIGNUP_INVITE_MODE = 'automatic';

    const manual = await request(app)
      .put('/api/admin/allowed-emails/mode')
      .set(auth(token))
      .send({ mode: 'manual' });
    expect(manual.status).toBe(200);

    const held = await request(app)
      .post('/api/admin/allowed-emails')
      .set(auth(token))
      .send({ email: 'held@example.com' });
    expect(held.status).toBe(201);
    expect(held.body.invitedAt).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();

    const automatic = await request(app)
      .put('/api/admin/allowed-emails/mode')
      .set(auth(token))
      .send({ mode: 'automatic' });
    expect(automatic.body.mode).toBe('automatic');

    const added = await request(app)
      .post('/api/admin/allowed-emails')
      .set(auth(token))
      .send({ email: 'now@example.com' });
    expect(added.status).toBe(201);
    expect(added.body.invitedAt).toBeTruthy();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('now@example.com');
  });

  test('resend sets invitedAt again and a mail failure keeps the old time', async () => {
    const token = await adminToken();
    const added = await request(app)
      .post('/api/admin/allowed-emails')
      .set(auth(token))
      .send({ email: 'again@example.com' });
    expect(added.status).toBe(201);

    const missing = await request(app)
      .post('/api/admin/allowed-emails/missing@example.com/invite')
      .set(auth(token));
    expect(missing.status).toBe(404);

    const first = await request(app)
      .post('/api/admin/allowed-emails/again@example.com/invite')
      .set(auth(token));
    expect(first.status).toBe(200);
    expect(first.body.email).toBe('again@example.com');
    const firstAt = new Date(first.body.invitedAt);
    expect(firstAt.toString()).not.toBe('Invalid Date');

    await AllowedEmail.updateOne(
      { email: 'again@example.com' },
      { $set: { invitedAt: new Date('2020-01-01T00:00:00.000Z') } },
    );
    sendEmail.mockRejectedValueOnce(new Error('mailbox down'));
    const failed = await request(app)
      .post('/api/admin/allowed-emails/again@example.com/invite')
      .set(auth(token));
    expect(failed.status).toBe(502);
    expect(failed.body.message).toBe('Invitation email failed');
    const unchanged = await AllowedEmail.findOne({ email: 'again@example.com' });
    expect(unchanged.invitedAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');

    const second = await request(app)
      .post('/api/admin/allowed-emails/again%40example.com/invite')
      .set(auth(token));
    expect(second.status).toBe(200);
    expect(new Date(second.body.invitedAt).getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
  });

  test('mode changes and sending require an admin', async () => {
    const token = await adminToken();
    const member = await registerAndLogin('member@example.com');
    expect(member.loginRes.status).toBe(200);
    const memberAuth = auth(member.loginRes.body.token);

    const noToken = await request(app).post('/api/admin/allowed-emails/send-invites');
    expect(noToken.status).toBe(401);
    expect(noToken.body.message).toBe('No token, authorization denied');

    const memberMode = await request(app)
      .put('/api/admin/allowed-emails/mode')
      .set(memberAuth)
      .send({ mode: 'automatic' });
    expect(memberMode.status).toBe(403);
    expect(memberMode.body.message).toBe('Admin access required');

    const memberSend = await request(app)
      .post('/api/admin/allowed-emails/send-invites')
      .set(memberAuth);
    expect(memberSend.status).toBe(403);

    const bad = await request(app)
      .put('/api/admin/allowed-emails/mode')
      .set(auth(token))
      .send({ mode: 'later' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Mode must be automatic or manual');
    expect(await SignupInviteConfig.countDocuments()).toBe(0);
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
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
