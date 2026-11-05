const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const { allowRegister, clearRegisterInvite } = require('./inviteForRegister');
const User = require('../models/User');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const Invitation = require('../models/Invitation');
const AiUsage = require('../models/AiUsage');
const ApiKey = require('../models/ApiKey');

jest.setTimeout(30000);

const USAGE = '/api/users/me/ai-usage';

let mongo;

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

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function usageRow(userId, fields) {
  return AiUsage.create({
    userId,
    planId: 'plan-secret',
    provider: 'xai',
    model: 'grok-secret',
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    credits: 5,
    error: 'secret error',
    ...fields,
  });
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
    AiUsage.deleteMany({}),
    ApiKey.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('GET /api/users/me/ai-usage', () => {
  test('no token is 401 and an empty account is an empty list', async () => {
    const missing = await request(app).get(USAGE);
    expect(missing.status).toBe(401);

    const ada = await registerAndLogin('ada-usage@example.com');
    const empty = await request(app).get(USAGE).set(bearer(ada.token));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
  });

  test('an agent key cannot read the list', async () => {
    const ada = await registerAndLogin('ada-agent@example.com');
    const minted = await request(app)
      .post('/api/users/me/api-keys')
      .set(bearer(ada.token))
      .send({ name: 'agent' });
    expect(minted.status).toBe(201);
    const listed = await request(app).get(USAGE).set(bearer(minted.body.key));
    expect(listed.status).toBe(401);
    expect(listed.body.message).toBe('Token is not valid');
  });

  test('own rows only, newest first, with the server-success cost', async () => {
    const ada = await registerAndLogin('ada-list@example.com');
    const ben = await registerAndLogin('ben-list@example.com');
    await usageRow(ben.userId, {
      feature: 'paste',
      usedUserKey: false,
      success: true,
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
    });
    await usageRow(ada.userId, {
      feature: 'paste',
      usedUserKey: false,
      success: true,
      createdAt: new Date('2026-07-01T12:00:00.000Z'),
    });
    await usageRow(ada.userId, {
      feature: 'command',
      usedUserKey: true,
      success: true,
      createdAt: new Date('2026-07-03T12:00:00.000Z'),
    });
    await usageRow(ada.userId, {
      feature: 'placeSearch',
      provider: 'google',
      usedUserKey: false,
      success: true,
      credits: 0.5,
      createdAt: new Date('2026-07-04T12:00:00.000Z'),
    });
    await usageRow(ada.userId, {
      feature: 'suggest',
      usedUserKey: false,
      success: false,
      createdAt: new Date('2026-07-02T12:00:00.000Z'),
    });

    const listed = await request(app).get(USAGE).set(bearer(ada.token));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        createdAt: '2026-07-04T12:00:00.000Z',
        feature: 'placeSearch',
        creditCost: 0.5,
        success: true,
      },
      {
        createdAt: '2026-07-03T12:00:00.000Z',
        feature: 'command',
        creditCost: 0,
        success: true,
      },
      {
        createdAt: '2026-07-02T12:00:00.000Z',
        feature: 'suggest',
        creditCost: 0,
        success: false,
      },
      {
        createdAt: '2026-07-01T12:00:00.000Z',
        feature: 'paste',
        creditCost: 1,
        success: true,
      },
    ]);
    const raw = JSON.stringify(listed.body);
    expect(raw).not.toContain('grok-secret');
    expect(raw).not.toContain('secret error');
    expect(raw).not.toContain('inputTokens');
    expect(raw).not.toContain(ben.userId);
  });

  test('the list stops at 50 newest rows', async () => {
    const ada = await registerAndLogin('ada-limit@example.com');
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    await Promise.all(
      Array.from({ length: 51 }, (_, index) => usageRow(ada.userId, {
        feature: index % 2 === 0 ? 'paste' : 'command',
        usedUserKey: false,
        success: true,
        createdAt: new Date(start + index * 60000),
      })),
    );
    const listed = await request(app).get(USAGE).set(bearer(ada.token));
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(50);
    expect(listed.body[0].createdAt).toBe(new Date(start + 50 * 60000).toISOString());
    expect(listed.body[49].createdAt).toBe(new Date(start + 1 * 60000).toISOString());
    expect(listed.body.every((row) => row.creditCost === 1)).toBe(true);
  });
});
