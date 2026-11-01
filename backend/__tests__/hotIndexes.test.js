const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const { Event } = require('../models/Event');
const Attachment = require('../models/Attachment');
const AiUsage = require('../models/AiUsage');
const ActivityReaction = require('../models/ActivityReaction');
const Invitation = require('../models/Invitation');
const { ensureHotIndexes } = require('../utils/ensureHotIndexes');

jest.setTimeout(30000);

let mongo;

function indexKeys(indexes) {
  return indexes.map((entry) => entry.key);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test('hot query indexes are created and the unused ones are skipped', async () => {
  const report = await ensureHotIndexes();
  expect(report.ensured).toEqual([
    'PlanUser { userId: 1, planId: 1 }',
    'Activity { planId: 1, startTime: 1 }',
    'Attachment { activityId: 1, createdAt: 1 }',
    'AiUsage { userId: 1, createdAt: -1 }',
    'ActivityReaction { activityId: 1, userId: 1, type: 1 } unique',
    'TemplateFeedback { templateId: 1, userId: 1 } unique',
  ]);
  expect(report.skipped).toEqual([
    'PlanUser { planId: 1, status: 1 }: PlanUser has no status field',
    'Invitation { email: 1, status: 1 }: inbox queries filter by userId',
  ]);

  expect(indexKeys(await PlanUser.collection.indexes())).toEqual(
    expect.arrayContaining([{ userId: 1, planId: 1 }]),
  );
  expect(indexKeys(await Event.collection.indexes())).toEqual(
    expect.arrayContaining([{ planId: 1, startTime: 1 }]),
  );
  expect(indexKeys(await Attachment.collection.indexes())).toEqual(
    expect.arrayContaining([{ activityId: 1, createdAt: 1 }]),
  );
  expect(indexKeys(await AiUsage.collection.indexes())).toEqual(
    expect.arrayContaining([{ userId: 1, createdAt: -1 }]),
  );
  const reactionIndexes = await ActivityReaction.collection.indexes();
  expect(reactionIndexes).toEqual(expect.arrayContaining([
    expect.objectContaining({
      key: { activityId: 1, userId: 1, type: 1 },
      unique: true,
    }),
  ]));

  const planUserFields = PlanUser.schema.indexes().map((entry) => entry[0]);
  expect(planUserFields).toEqual(expect.arrayContaining([
    { planId: 1, userId: 1 },
    { userId: 1, planId: 1 },
  ]));
  expect(planUserFields.some((key) => Object.prototype.hasOwnProperty.call(key, 'status'))).toBe(false);

  const eventFields = Event.schema.indexes().map((entry) => entry[0]);
  expect(eventFields).toEqual(expect.arrayContaining([{ planId: 1, startTime: 1 }]));

  const inviteFields = Invitation.schema.indexes().map((entry) => entry[0]);
  expect(inviteFields.some((key) => Object.prototype.hasOwnProperty.call(key, 'email'))).toBe(false);
});
