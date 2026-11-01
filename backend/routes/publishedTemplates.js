const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const User = require('../models/User');
const PublishedTemplate = require('../models/PublishedTemplate');
const TemplateReport = require('../models/TemplateReport');
const { Event } = require('../models/Event');
const authMiddleware = require('../middleware/auth.js');
const { canonicalMembershipRole } = require('../middleware/roleCheck');
const { compareStoredOrder } = require('../utils/activityTimes');
const { preparePlanCreate } = require('../utils/planAccess');
const { isArchivedStatus, ARCHIVED_MESSAGE } = require('../utils/planArchive');
const { resolveTier, tierName } = require('../utils/membershipTiers');
const { logSupport } = require('../utils/logSupport');
const {
  readTemplateName,
  readTemplateStart,
  shiftedTemplatePlan,
} = require('../utils/planTemplate');
const {
  PUBLISH_DAILY_LIMIT,
  readPublishFields,
  creatorNameOf,
  shareDraft,
  publicStops,
  publicCard,
  ownerCard,
  escapeRegExp,
} = require('../utils/publishedTemplate');
const {
  reporterLabel,
  notifyTemplateReport,
} = require('../utils/templateReports');

const publicRouter = express.Router();
const ownerRouter = express.Router();

function callerIdOf(req) {
  return req.user.userId || req.user.id;
}

function planGateBody(gate) {
  if (gate && gate.body && typeof gate.body === 'object') return gate.body;
  return { message: gate && gate.message };
}

async function callerIsOwner(plan, callerId) {
  const membership = await PlanUser.findOne({ planId: plan._id, userId: callerId });
  let role = canonicalMembershipRole(membership && membership.role);
  if (!role && String(plan.ownerId) === String(callerId)) role = 'Owner';
  return role === 'Owner';
}

async function publishGate(callerId) {
  const user = await User.findById(callerId).select('tier plusActive').lean();
  const tier = resolveTier(user);
  if (tier === 'plus' || tier === 'pro') return { status: 200, tier };
  return {
    status: 402,
    body: {
      message: 'Upgrade to Plus to publish a template.',
      nextTier: 'plus',
      nextTierName: tierName('plus'),
    },
  };
}

async function loadOwnedPlan(planId, callerId) {
  const plan = await Plan.findById(planId).lean();
  if (!plan) return { status: 404, body: { message: 'Plan not found' } };
  const owner = await callerIsOwner(plan, callerId);
  if (!owner) {
    return { status: 403, body: { message: 'Only the Owner can publish a template.' } };
  }
  if (isArchivedStatus(plan)) {
    return { status: 403, body: { message: ARCHIVED_MESSAGE } };
  }
  return { status: 200, plan };
}

async function planActivities(planId) {
  const activities = await Event.find({ planId: String(planId) }).lean();
  activities.sort(compareStoredOrder);
  return activities;
}

function utcDayStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function optionalUser(req) {
  const header = req.header('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token || token.split('.').length !== 3) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId || decoded.id;
    if (!userId) return null;
    return User.findById(userId).select('firstName lastName email').lean();
  } catch (err) {
    return null;
  }
}

async function draftFor(plan, callerId, fields) {
  const user = await User.findById(callerId).select('firstName lastName').lean();
  const activities = await planActivities(plan._id);
  return shareDraft(plan, activities, fields, creatorNameOf(user));
}

function applyDraft(doc, plan, fields, draft) {
  doc.creatorName = draft.preview.creatorName;
  doc.title = fields.title;
  doc.description = fields.description;
  doc.city = fields.city;
  doc.tripLength = fields.tripLength;
  doc.vibe = fields.vibe;
  doc.coverImage = fields.coverImage;
  doc.type = plan.type === 'plan' ? 'plan' : 'trip';
  doc.timeZone = plan.timeZone || '';
  doc.startDate = plan.startDate || null;
  doc.endDate = plan.endDate || null;
  doc.activities = draft.storedActivities;
  doc.published = true;
  doc.markModified('activities');
}

// GET /api/public/templates?q=&city=&length=&tag=
publicRouter.get('/', async (req, res) => {
  try {
    const filter = { published: true };
    const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const lengthText = typeof req.query.length === 'string' ? req.query.length.trim() : '';
    if (city) filter.city = new RegExp(`^${escapeRegExp(city)}$`, 'i');
    if (lengthText) {
      const length = Number(lengthText);
      if (!Number.isInteger(length) || length < 1) {
        return res.status(400).json({ message: 'Length must be a number of days.' });
      }
      filter.tripLength = length;
    }
    if (tag) {
      const pattern = new RegExp(escapeRegExp(tag), 'i');
      filter.$or = [{ vibe: pattern }, { city: pattern }];
    }
    if (q) {
      const pattern = new RegExp(escapeRegExp(q), 'i');
      const text = [{ title: pattern }, { description: pattern }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: text }];
        delete filter.$or;
      } else {
        filter.$or = text;
      }
    }
    const rows = await PublishedTemplate.find(filter)
      .sort({ copyCount: -1, viewCount: -1, createdAt: -1 })
      .limit(50)
      .select('-activities')
      .lean();
    return res.json({ templates: rows.map(publicCard) });
  } catch (err) {
    console.error('List public templates error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/public/templates/:id
publicRouter.get('/:id', async (req, res) => {
  try {
    const doc = await PublishedTemplate.findOneAndUpdate(
      { _id: String(req.params.id || ''), published: true },
      { $inc: { viewCount: 1 } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ message: 'Template not found' });
    return res.json({
      template: {
        ...publicCard(doc),
        stops: publicStops(doc.activities || [], doc.timeZone),
      },
    });
  } catch (err) {
    console.error('Read public template error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/public/templates/:id/report { reason }
publicRouter.post('/:id/report', async (req, res) => {
  try {
    const templateId = String(req.params.id || '');
    const doc = await PublishedTemplate.findOne({ _id: templateId, published: true })
      .select('_id')
      .lean();
    if (!doc) return res.status(404).json({ message: 'Template not found' });
    const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ message: 'A reason is required.' });
    if (reason.length > 500) return res.status(400).json({ message: 'Reason is too long.' });
    const reporter = reporterLabel(await optionalUser(req));
    await TemplateReport.create({ _id: uuidv4(), templateId, reason, reporter });
    try {
      await notifyTemplateReport({ templateId, reason, reporter });
    } catch (err) {
      console.error('Template report email failed:', err && err.message ? err.message : err);
    }
    return res.status(201).json({ reported: true });
  } catch (err) {
    console.error('Report template error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/public/templates/:id/copy { name, startDate }
publicRouter.post('/:id/copy', authMiddleware, async (req, res) => {
  const templateId = String(req.params.id || '');
  try {
    const doc = await PublishedTemplate.findOne({ _id: templateId, published: true }).lean();
    if (!doc) return res.status(404).json({ message: 'Template not found' });
    const callerId = callerIdOf(req);
    const named = readTemplateName(req.body);
    if (named.error) return res.status(400).json({ message: named.error });
    const start = readTemplateStart(req.body);
    if (start.error) return res.status(400).json({ message: start.error });
    const gate = await preparePlanCreate(callerId);
    if (gate.status !== 200) return res.status(gate.status).json(planGateBody(gate));

    const shifted = shiftedTemplatePlan(doc, start.date);
    const newId = uuidv4();
    const plan = new Plan({
      _id: newId,
      type: doc.type === 'plan' ? 'plan' : 'trip',
      name: named.name,
      destination: doc.type === 'trip' ? (doc.city || 'Trip') : '',
      location: doc.type === 'plan' ? (doc.city || 'Event') : '',
      timeZone: doc.timeZone || '',
      budget: 0,
      hiddenFields: [],
      planningState: 'initial',
      autoCalculateStartDate: false,
      autoCalculateEndDate: false,
      startDate: shifted.startDate,
      endDate: shifted.endDate,
      ownerId: callerId,
      basedOnTemplateId: String(doc._id),
      basedOnTitle: doc.title,
      basedOnCreator: doc.creatorName || '',
    });
    const copies = shifted.activities.map((activity) => ({
      ...activity,
      _id: uuidv4(),
      planId: newId,
      ownerId: String(callerId),
    }));
    try {
      await plan.save();
      await new PlanUser({ planId: newId, userId: callerId, role: 'Owner' }).save();
      if (copies.length) await Event.insertMany(copies);
      await PublishedTemplate.updateOne({ _id: doc._id }, { $inc: { copyCount: 1 } });
    } catch (err) {
      await Event.deleteMany({ planId: newId });
      await PlanUser.deleteMany({ planId: newId });
      await Plan.deleteOne({ _id: newId });
      throw err;
    }
    await logSupport({
      level: 'info',
      event: 'PublishedTemplateCopied',
      actorUserId: callerId,
      planId: newId,
      message: 'Plan copied from a published template',
      extra: { templateId, name: named.name },
    });
    const saved = await Plan.findById(newId);
    return res.status(201).json({ plan: saved });
  } catch (err) {
    console.error('Copy published template error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/published-templates
ownerRouter.get('/', async (req, res) => {
  try {
    const callerId = String(callerIdOf(req));
    const rows = await PublishedTemplate.find({ ownerId: callerId })
      .sort({ updatedAt: -1 })
      .select('-activities')
      .lean();
    return res.json({ templates: rows.map(ownerCard) });
  } catch (err) {
    console.error('List owned published templates error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/published-templates/from/:planId/preview
ownerRouter.post('/from/:planId/preview', async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const callerId = callerIdOf(req);
    const loaded = await loadOwnedPlan(planId, callerId);
    if (loaded.status !== 200) return res.status(loaded.status).json(loaded.body);
    const gate = await publishGate(callerId);
    if (gate.status !== 200) return res.status(gate.status).json(gate.body);
    const fields = readPublishFields(req.body);
    if (fields.error) return res.status(400).json({ message: fields.error });
    const draft = await draftFor(loaded.plan, callerId, fields);
    return res.json({
      preview: draft.preview,
      removed: draft.removed,
      blocked: draft.blocked,
    });
  } catch (err) {
    console.error('Preview published template error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/published-templates/from/:planId
ownerRouter.post('/from/:planId', async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const callerId = callerIdOf(req);
    const loaded = await loadOwnedPlan(planId, callerId);
    if (loaded.status !== 200) return res.status(loaded.status).json(loaded.body);
    const gate = await publishGate(callerId);
    if (gate.status !== 200) return res.status(gate.status).json(gate.body);
    const fields = readPublishFields(req.body);
    if (fields.error) return res.status(400).json({ message: fields.error });
    const draft = await draftFor(loaded.plan, callerId, fields);
    if (draft.blocked) return res.status(400).json({ message: draft.blocked });

    const ownerId = String(callerId);
    let doc = await PublishedTemplate.findOne({ ownerId, sourcePlanId: planId });
    let created = false;
    if (!doc) {
      const start = utcDayStart(new Date());
      const madeToday = await PublishedTemplate.countDocuments({
        ownerId,
        createdAt: { $gte: start },
      });
      if (madeToday >= PUBLISH_DAILY_LIMIT) {
        return res.status(429).json({
          message: `You can publish ${PUBLISH_DAILY_LIMIT} templates a day.`,
        });
      }
      doc = new PublishedTemplate({
        _id: uuidv4(),
        ownerId,
        sourcePlanId: planId,
      });
      created = true;
    }
    applyDraft(doc, loaded.plan, fields, draft);
    await doc.save();
    await logSupport({
      level: 'info',
      event: 'TemplatePublished',
      actorUserId: callerId,
      planId,
      message: 'Plan published as a template',
      extra: { templateId: doc._id, title: fields.title },
    });
    return res.status(created ? 201 : 200).json({ template: ownerCard(doc) });
  } catch (err) {
    console.error('Publish template error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PATCH /api/published-templates/:id
ownerRouter.patch('/:id', async (req, res) => {
  const templateId = String(req.params.id || '');
  try {
    const callerId = callerIdOf(req);
    const gate = await publishGate(callerId);
    if (gate.status !== 200) return res.status(gate.status).json(gate.body);
    const doc = await PublishedTemplate.findOne({
      _id: templateId,
      ownerId: String(callerId),
    });
    if (!doc) return res.status(404).json({ message: 'Template not found' });
    const fields = readPublishFields(req.body);
    if (fields.error) return res.status(400).json({ message: fields.error });
    const refresh = req.body && req.body.refresh === true;
    let plan = null;
    if (refresh) {
      const loaded = await loadOwnedPlan(doc.sourcePlanId, callerId);
      if (loaded.status !== 200) return res.status(loaded.status).json(loaded.body);
      plan = loaded.plan;
    }
    const draft = refresh
      ? await draftFor(plan, callerId, fields)
      : shareDraft(
        { timeZone: doc.timeZone, type: doc.type },
        doc.activities || [],
        fields,
        doc.creatorName,
      );
    if (draft.blocked) return res.status(400).json({ message: draft.blocked });
    if (refresh) {
      applyDraft(doc, plan, fields, draft);
    } else {
      doc.title = fields.title;
      doc.description = fields.description;
      doc.city = fields.city;
      doc.tripLength = fields.tripLength;
      doc.vibe = fields.vibe;
      doc.coverImage = fields.coverImage;
    }
    await doc.save();
    return res.json({ template: ownerCard(doc) });
  } catch (err) {
    console.error('Edit published template error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/published-templates/:id/unpublish
ownerRouter.post('/:id/unpublish', async (req, res) => {
  try {
    const callerId = String(callerIdOf(req));
    const doc = await PublishedTemplate.findOne({
      _id: String(req.params.id || ''),
      ownerId: callerId,
    });
    if (!doc) return res.status(404).json({ message: 'Template not found' });
    doc.published = false;
    await doc.save();
    return res.json({ template: ownerCard(doc) });
  } catch (err) {
    console.error('Unpublish template error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = { publicRouter, ownerRouter };
