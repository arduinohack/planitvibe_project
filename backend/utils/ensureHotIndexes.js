const logger = require('./logger');
// Load the real Plan model before Event. Event.js registers a Plan
// discriminator only when Plan is not already compiled.
require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const { Event } = require('../models/Event');
const Attachment = require('../models/Attachment');
const AiUsage = require('../models/AiUsage');
const ActivityReaction = require('../models/ActivityReaction');
const TemplateFeedback = require('../models/TemplateFeedback');

// Idempotent. Safe on every startup. Does not change queries.
async function ensureHotIndexes() {
  await PlanUser.collection.createIndex({ userId: 1, planId: 1 });
  await Event.collection.createIndex({ planId: 1, startTime: 1 });
  // Equality on activityId is the prefix of this compound index.
  await Attachment.collection.createIndex({ activityId: 1, createdAt: 1 });
  await AiUsage.collection.createIndex({ userId: 1, createdAt: -1 });
  await ActivityReaction.collection.createIndex(
    { activityId: 1, userId: 1, type: 1 },
    { unique: true },
  );
  await TemplateFeedback.collection.createIndex(
    { templateId: 1, userId: 1 },
    { unique: true },
  );

  const report = {
    ensured: [
      'PlanUser { userId: 1, planId: 1 }',
      'Activity { planId: 1, startTime: 1 }',
      'Attachment { activityId: 1, createdAt: 1 }',
      'AiUsage { userId: 1, createdAt: -1 }',
      'ActivityReaction { activityId: 1, userId: 1, type: 1 } unique',
      'TemplateFeedback { templateId: 1, userId: 1 } unique',
    ],
    skipped: [
      'PlanUser { planId: 1, status: 1 }: PlanUser has no status field',
      'Invitation { email: 1, status: 1 }: inbox queries filter by userId',
    ],
  };
  logger.info('Hot query indexes ready', {
    event: 'hot_indexes',
    context: {
      ensured: report.ensured,
      skipped: report.skipped,
    },
  });
  return report;
}

module.exports = { ensureHotIndexes };
