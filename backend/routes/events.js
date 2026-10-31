const express = require('express');
const router = express.Router();
const { Event } = require('../models/Event');
const ActivityRevision = require('../models/ActivityRevision');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const authMiddleware = require('../middleware/auth');
const { canonicalMembershipRole } = require('../middleware/roleCheck');
const { applyTypeChange, assertTypeRequirements } = require('../utils/activityTypeFields');
const { recordActivityRevision } = require('../utils/recordActivityRevision');
const { syncPlanDates } = require('../utils/syncPlanDates');
const { resolveActivitySchedule, resolveActivityZones, compareStoredOrder } = require('../utils/activityTimes');
const {
  activityOrderError,
  placementStart,
  cascadeStored,
  applyActivityMove,
  sameInstant,
} = require('../utils/activityChain');
const { applyFlightLegs, activityZoneError, zoneNameError } = require('../utils/flightLegs');
const { parseConfirmation } = require('../utils/parseConfirmation');
const { confirmationFieldsFromModel } = require('../utils/xaiConfirmation');
const { getAiClient } = require('../utils/aiProvider');
const { prepareEdit, prepareAi } = require('../utils/planAccess');
const { archivedMemberResult } = require('../utils/planArchive');
const {
  readReactionType,
  reactionSummary,
  setReaction,
  clearReaction,
  removeActivityReactions,
} = require('../utils/activityReactions');
const { emitPlanReaction } = require('../realtime/presence');

function applySchedule(target, schedule) {
  if (schedule.startTime) target.startTime = schedule.startTime;
  else delete target.startTime;
  if (schedule.endTime) target.endTime = schedule.endTime;
  else delete target.endTime;
  if (schedule.durationMinutes == null) delete target.durationMinutes;
  else target.durationMinutes = schedule.durationMinutes;
}

async function membershipRole(planId, callerId) {
  const membership = await PlanUser.findOne({ planId, userId: callerId });
  let role = canonicalMembershipRole(membership && membership.role);
  if (!role) {
    const plan = await Plan.findById(planId).select('ownerId');
    if (plan && plan.ownerId === callerId) role = 'Owner';
  }
  return role;
}

async function callerMayEditActivities(planId, callerId) {
  const role = await membershipRole(planId, callerId);
  return role === 'Owner' || role === 'Collaborator';
}

async function editGate(callerId) {
  const gate = await prepareEdit(callerId);
  if (gate.status === 200) return null;
  return { status: gate.status, body: { message: gate.message } };
}

async function callerMayParseConfirmation(callerId) {
  if (!callerId) return false;
  const id = String(callerId);
  const owned = await Plan.exists({ ownerId: id });
  if (owned) return true;
  const rows = await PlanUser.find({ userId: id }).select('role').lean();
  return rows.some((row) => {
    const role = canonicalMembershipRole(row.role);
    return role === 'Owner' || role === 'Collaborator';
  });
}

async function callerMayReadHistory(planId, callerId) {
  const role = await membershipRole(planId, callerId);
  return role === 'Owner' || role === 'Collaborator' || role === 'Guest';
}

function textId(body, key) {
  const value = body && body[key];
  return typeof value === 'string' ? value.trim() : '';
}

function startMissing(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'startTime')) return true;
  const value = body.startTime;
  if (value == null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

async function rowsInStoredOrder(planId) {
  const rows = await Event.find({ planId }).select('_id eventNum startTime endTime').lean();
  rows.sort(compareStoredOrder);
  return rows;
}

async function eventNumForInsert(planId, insertAfterId, insertBeforeId) {
  const rows = await rowsInStoredOrder(planId);
  if (!insertAfterId && !insertBeforeId) {
    if (!rows.length) return { eventNum: 0 };
    const max = rows.reduce((highest, row) => Math.max(highest, Number(row.eventNum) || 0), 0);
    return { eventNum: max + 1 };
  }
  const targetId = insertAfterId || insertBeforeId;
  const target = rows.find((row) => String(row._id) === String(targetId));
  if (!target) return { error: 'Activity not found', status: 404 };
  const eventNum = insertAfterId
    ? (Number(target.eventNum) || 0) + 1
    : (Number(target.eventNum) || 0);
  return { eventNum, target };
}

async function shiftEventNums(planId, eventNum) {
  await Event.updateMany({ planId, eventNum: { $gte: eventNum } }, { $inc: { eventNum: 1 } });
}

function revisionPayload(revision) {
  return {
    _id: revision._id,
    eventId: revision.eventId,
    planId: revision.planId,
    userId: revision.userId,
    action: revision.action,
    snapshot: revision.snapshot,
    createdAt: revision.createdAt,
    deleted: revision.deleted === true,
  };
}

// GET all events for a plan
router.get('/plan/:planId', authMiddleware, async (req, res) => {
  try {
    const callerId = req.user.userId || req.user.id;
    const archived = await archivedMemberResult(req.params.planId, callerId);
    if (archived) return res.status(archived.status).json(archived.body);
    const events = await Event.find({ planId: req.params.planId, ownerId: req.user.userId });
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Shared with POST /api/activities and AI command apply.
async function createActivity(callerId, body) {
  try {
    const planId = body && body.planId;
    if (!planId) {
      return { status: 400, body: { message: 'planId is required' } };
    }
    const archived = await archivedMemberResult(planId, callerId);
    if (archived) return archived;
    const allowed = await callerMayEditActivities(planId, callerId);
    if (!allowed) {
      return {
        status: 403,
        body: { message: 'Only Owner or Collaborator can change activities' },
      };
    }
    const blocked = await editGate(callerId);
    if (blocked) return blocked;

    const insertAfterId = textId(body, 'insertAfter');
    const insertBeforeId = textId(body, 'insertBefore');
    if (insertAfterId && insertBeforeId) {
      return {
        status: 400,
        body: { message: 'insertAfter and insertBefore cannot both be set' },
      };
    }
    const placement = await eventNumForInsert(planId, insertAfterId, insertBeforeId);
    if (placement.error) {
      return { status: placement.status || 400, body: { message: placement.error } };
    }
    let source = body;
    if (startMissing(body)) {
      const anchor = await placementStart(planId, { insertAfterId, insertBeforeId });
      if (anchor) source = { ...body, startTime: new Date(anchor).toISOString() };
    }
    const legged = applyFlightLegs(source, source && source.type);
    if (legged.error) {
      return { status: 400, body: { message: legged.error } };
    }
    const sentZoneError = activityZoneError(body);
    if (sentZoneError) {
      return { status: 400, body: { message: sentZoneError } };
    }
    source = legged.body;
    const zones = await resolveActivityZones({
      isCreate: true,
      planId,
      body: source,
    });
    const resolvedZoneError = zoneNameError(zones.startTimeZone)
      || zoneNameError(zones.endTimeZone)
      || zoneNameError(zones.timeZone);
    if (resolvedZoneError) {
      return { status: 400, body: { message: resolvedZoneError } };
    }
    const schedule = await resolveActivitySchedule({
      isCreate: true,
      planId,
      body: source,
    });
    if (schedule.error) {
      return { status: 400, body: { message: schedule.error } };
    }
    const payload = { ...source, ownerId: callerId };
    delete payload.insertAfter;
    delete payload.insertBefore;
    applySchedule(payload, schedule);
    if (insertAfterId || insertBeforeId) await shiftEventNums(planId, placement.eventNum);
    payload.eventNum = placement.eventNum;
    payload.startTimeZone = zones.startTimeZone;
    payload.endTimeZone = zones.endTimeZone;
    payload.timeZone = zones.timeZone;
    const newEvent = new Event(payload);
    const savedEvent = await newEvent.save();
    await recordActivityRevision(savedEvent, 'create', callerId);
    if (savedEvent.startTime) {
      await cascadeStored(savedEvent.planId, savedEvent._id, {
        anchorEnd: savedEvent.startTime,
        newEnd: savedEvent.endTime,
      }, callerId);
    }
    await syncPlanDates(savedEvent.planId);
    return { status: 201, body: savedEvent };
  } catch (error) {
    return { status: 400, body: { message: error.message } };
  }
}

// POST new event (handles recursive subEvents)
router.post('/', authMiddleware, async (req, res) => {
  const callerId = req.user.userId || req.user.id;
  const result = await createActivity(callerId, req.body);
  return res.status(result.status).json(result.body);
});

// Declared before /:id so PUT /:id cannot swallow the order update.
router.put('/order', authMiddleware, async (req, res) => {
  try {
    const planId = textId(req.body, 'planId');
    const activityIds = req.body && req.body.activityIds;
    if (!planId) return res.status(400).json({ message: 'planId is required' });
    if (!Array.isArray(activityIds)) {
      return res.status(400).json({ message: 'activityIds is required' });
    }
    const callerId = req.user.userId || req.user.id;
    const archived = await archivedMemberResult(planId, callerId);
    if (archived) return res.status(archived.status).json(archived.body);
    const allowed = await callerMayEditActivities(planId, callerId);
    if (!allowed) {
      return res.status(403).json({ message: 'Only Owner or Collaborator can change activities' });
    }
    const blocked = await editGate(callerId);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const [plan, rows] = await Promise.all([
      Plan.findById(planId).select('sourcePlanId linkedActivityIds').lean(),
      Event.find({ planId }).select('_id').lean(),
    ]);
    const orderError = activityOrderError(plan, rows, activityIds);
    if (orderError) return res.status(400).json({ message: orderError });
    const ownIds = new Set(rows.map((row) => String(row._id)));
    for (let index = 0; index < activityIds.length; index += 1) {
      const key = String(activityIds[index]);
      if (!ownIds.has(key)) continue;
      await Event.updateOne(
        { _id: key, planId },
        { $set: { eventNum: index } },
      );
    }
    res.json({ activityIds });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Fixed path. It reads pasted text and does not create or update an activity.
router.post('/parse-confirmation', authMiddleware, async (req, res) => {
  try {
    const callerId = req.user.userId || req.user.id;
    const allowed = await callerMayParseConfirmation(callerId);
    if (!allowed) {
      return res.status(403).json({
        message: 'Only Owner or Collaborator can parse a confirmation',
      });
    }
    const type = typeof req.body?.type === 'string' ? req.body.type.trim().toLowerCase() : '';
    const confirmationTypes = ['flight', 'train', 'shuttle', 'cruise', 'hotel'];
    if (!confirmationTypes.includes(type)) {
      return res.status(400).json({
        message: 'Type must be flight, train, shuttle, cruise, or hotel',
      });
    }
    if (typeof req.body?.text !== 'string') {
      return res.status(400).json({ message: 'Text is required' });
    }
    const parsed = parseConfirmation(req.body.text, type);
    let client = null;
    try {
      client = await getAiClient(req.user);
    } catch (err) {
      const message = err && err.message ? err.message : 'request failed';
      console.error('Confirmation AI client failed:', message);
    }
    const gate = await prepareAi(callerId, client);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }
    if (client) {
      const modeled = await confirmationFieldsFromModel(req.body.text, type, client, {
        userId: String(callerId || ''),
        feature: 'paste',
      });
      if (modeled && modeled.insufficientCredits) {
        return res.status(402).json({
          ...parsed,
          message: 'Insufficient AI credits',
        });
      }
      if (modeled) return res.json(modeled);
    }
    return res.json(parsed);
  } catch (error) {
    console.error('Parse confirmation error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

async function loadActivityForMember(activityId, callerId) {
  const event = await Event.findById(activityId).select('planId').lean();
  if (!event) return { status: 404, body: { message: 'Activity not found' } };
  const archived = await archivedMemberResult(event.planId, callerId);
  if (archived) return archived;
  const role = await membershipRole(event.planId, callerId);
  if (!role) {
    return { status: 403, body: { message: 'Only plan members can react' } };
  }
  return { status: 200, event, role };
}

// Counts go to every joined browser. myVotes stays on the HTTP body because it is the caller only.
function publishReaction(planId, activityId, callerId, type, summary, voted) {
  emitPlanReaction(planId, {
    planId: String(planId),
    activityId: String(activityId),
    type,
    userId: String(callerId || ''),
    voted: voted === true,
    counts: summary && summary.counts,
  });
}

// Any plan member, including a Guest. One vote per type; a second vote replaces it.
router.post('/:id/react', authMiddleware, async (req, res) => {
  try {
    const callerId = req.user.userId || req.user.id;
    const typeResult = readReactionType(req.body);
    if (typeResult.error) return res.status(400).json({ message: typeResult.error });
    const loaded = await loadActivityForMember(req.params.id, callerId);
    if (loaded.status !== 200) return res.status(loaded.status).json(loaded.body);
    const activityId = String(loaded.event._id);
    const planId = String(loaded.event.planId);
    await setReaction({
      activityId,
      planId,
      userId: callerId,
      type: typeResult.type,
    });
    const summary = await reactionSummary(activityId, callerId);
    publishReaction(planId, activityId, callerId, typeResult.type, summary, true);
    return res.json(summary);
  } catch (error) {
    console.error('Activity react error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id/react', authMiddleware, async (req, res) => {
  try {
    const callerId = req.user.userId || req.user.id;
    const typeResult = readReactionType(req.body);
    if (typeResult.error) return res.status(400).json({ message: typeResult.error });
    const loaded = await loadActivityForMember(req.params.id, callerId);
    if (loaded.status !== 200) return res.status(loaded.status).json(loaded.body);
    const activityId = String(loaded.event._id);
    const planId = String(loaded.event.planId);
    await clearReaction({
      activityId,
      userId: callerId,
      type: typeResult.type,
    });
    const summary = await reactionSummary(activityId, callerId);
    publishReaction(planId, activityId, callerId, typeResult.type, summary, false);
    return res.json(summary);
  } catch (error) {
    console.error('Activity react delete error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/reactions', authMiddleware, async (req, res) => {
  try {
    const callerId = req.user.userId || req.user.id;
    const loaded = await loadActivityForMember(req.params.id, callerId);
    if (loaded.status !== 200) return res.status(loaded.status).json(loaded.body);
    return res.json(await reactionSummary(String(loaded.event._id), callerId));
  } catch (error) {
    console.error('Activity reactions error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Owner or Collaborator marks the activity as a Yes / No / Maybe poll. No new activity.
router.post('/:id/poll', authMiddleware, async (req, res) => {
  try {
    const callerId = req.user.userId || req.user.id;
    const loaded = await loadActivityForMember(req.params.id, callerId);
    if (loaded.status !== 200) return res.status(loaded.status).json(loaded.body);
    if (loaded.role !== 'Owner' && loaded.role !== 'Collaborator') {
      return res.status(403).json({
        message: 'Only Owner or Collaborator can add a poll',
      });
    }
    const blocked = await editGate(callerId);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    await Event.updateOne({ _id: loaded.event._id }, { $set: { poll: true } });
    return res.json({ poll: true });
  } catch (error) {
    console.error('Activity poll error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Declared before /:id so a later GET /:id cannot swallow history.
router.get('/:id/history', authMiddleware, async (req, res) => {
  try {
    const eventId = req.params.id;
    const revisions = await ActivityRevision.find({ eventId }).sort({ createdAt: -1 });
    if (!revisions.length) {
      return res.status(404).json({ message: 'Event not found' });
    }

    const event = await Event.findById(eventId).select('planId');
    const planId = (event && event.planId) || revisions[0].planId;
    const callerId = req.user.userId || req.user.id;
    const archived = await archivedMemberResult(planId, callerId);
    if (archived) return res.status(archived.status).json(archived.body);
    const allowed = await callerMayReadHistory(planId, callerId);
    if (!allowed) {
      return res.status(403).json({ message: 'Only plan members can view activity history' });
    }

    res.json(revisions.map(revisionPayload));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Distinct path so a later POST /:id cannot swallow restore.
router.post('/:id/restore', authMiddleware, async (req, res) => {
  try {
    const eventId = req.params.id;
    const revisionId = req.body && req.body.revisionId;
    if (typeof revisionId !== 'string' || revisionId.trim() === '') {
      return res.status(400).json({ message: 'revisionId is required' });
    }

    const revision = await ActivityRevision.findById(revisionId);
    if (!revision) {
      return res.status(404).json({ message: 'Revision not found' });
    }
    if (String(revision.eventId) !== String(eventId)) {
      return res.status(400).json({ message: 'Revision does not belong to this activity' });
    }

    const event = await Event.findById(eventId);
    const planId = (event && event.planId) || revision.planId;
    const callerId = req.user.userId || req.user.id;
    const archived = await archivedMemberResult(planId, callerId);
    if (archived) return res.status(archived.status).json(archived.body);
    const allowed = await callerMayEditActivities(planId, callerId);
    if (!allowed) {
      return res.status(403).json({ message: 'Only Owner or Collaborator can change activities' });
    }
    const blocked = await editGate(callerId);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    if (event && String(revision.planId) !== String(event.planId)) {
      return res.status(400).json({ message: 'Revision does not belong to this activity' });
    }

    // Snapshot is the only activity source. Other body fields are ignored.
    const snapshot = revision.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return res.status(400).json({ message: 'Revision snapshot is missing' });
    }
    const requirementError = assertTypeRequirements(snapshot.type, snapshot);
    if (requirementError) {
      return res.status(400).json({ message: requirementError.message });
    }

    const fields = applyTypeChange(event ? event.toObject({ virtuals: false }) : {}, snapshot.type, snapshot);
    const snapshotLegs = Array.isArray(snapshot.legs) ? snapshot.legs : [];
    const restoredLegs = applyFlightLegs({ legs: snapshotLegs }, snapshot.type);
    if (restoredLegs.error) {
      return res.status(400).json({ message: restoredLegs.error });
    }
    fields.legs = restoredLegs.legs;
    fields.planId = planId;

    let saved;
    if (event) {
      for (const [key, value] of Object.entries(fields)) {
        if (key === '_id') continue;
        event.set(key, value);
      }
      event.planId = planId;
      saved = await event.save();
    } else {
      const payload = { _id: eventId, planId };
      for (const [key, value] of Object.entries(fields)) {
        if (key === '_id' || key === 'planId') continue;
        if (value !== undefined) payload[key] = value;
      }
      saved = await Event.create(payload);
    }

    // Same activity id, including a reinsert after delete: action update.
    await recordActivityRevision(saved, 'update', callerId);
    await syncPlanDates(planId);
    res.json(saved);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Move one activity. Closes the joined chain it left, then places it on the
// activity now before it and continues that chain until a gap.
router.put('/:id/move', authMiddleware, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    const callerId = req.user.userId || req.user.id;
    const planId = event.planId;
    const archived = await archivedMemberResult(planId, callerId);
    if (archived) return res.status(archived.status).json(archived.body);
    const allowed = await callerMayEditActivities(planId, callerId);
    if (!allowed) {
      return res.status(403).json({ message: 'Only Owner or Collaborator can change activities' });
    }
    const blocked = await editGate(callerId);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const bodyPlanId = textId(req.body, 'planId');
    if (bodyPlanId && bodyPlanId !== String(planId)) {
      return res.status(400).json({ message: 'Activity is not on this plan' });
    }
    const activityIds = req.body && req.body.activityIds;
    if (!Array.isArray(activityIds)) {
      return res.status(400).json({ message: 'activityIds is required' });
    }
    const moved = await applyActivityMove({
      planId,
      movedId: event._id,
      activityIds,
      callerId,
    });
    if (moved.error) {
      return res.status(moved.status || 400).json({ message: moved.error });
    }
    await syncPlanDates(planId);
    res.json({ activityIds: moved.activityIds });
  } catch (error) {
    console.error('Move activity error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Shared with PUT /api/activities/:id and AI command apply.
async function updateActivity(callerId, activityId, body) {
  try {
    const event = await Event.findById(activityId);
    if (!event) return { status: 404, body: { message: 'Event not found' } };
    const originalEnd = event.endTime ? new Date(event.endTime) : null;
    const archived = await archivedMemberResult(event.planId, callerId);
    if (archived) return archived;
    const allowed = await callerMayEditActivities(event.planId, callerId);
    if (!allowed) {
      return {
        status: 403,
        body: { message: 'Only Owner or Collaborator can change activities' },
      };
    }
    const blocked = await editGate(callerId);
    if (blocked) return blocked;

    const source = body || {};
    const nextType = Object.prototype.hasOwnProperty.call(source, 'type') ? source.type : event.type;
    const fields = applyTypeChange(event.toObject(), nextType, source);
    const legged = applyFlightLegs(source, nextType);
    if (legged.error) {
      return { status: 400, body: { message: legged.error } };
    }
    const sentZoneError = activityZoneError(source);
    if (sentZoneError) {
      return { status: 400, body: { message: sentZoneError } };
    }
    if (legged.assignLegs) fields.legs = legged.legs;
    const zones = await resolveActivityZones({
      isCreate: false,
      planId: event.planId,
      body: legged.body,
      existing: event.toObject(),
    });
    const resolvedZoneError = zoneNameError(zones.startTimeZone)
      || zoneNameError(zones.endTimeZone)
      || zoneNameError(zones.timeZone);
    if (resolvedZoneError) {
      return { status: 400, body: { message: resolvedZoneError } };
    }
    fields.startTimeZone = zones.startTimeZone;
    fields.endTimeZone = zones.endTimeZone;
    fields.timeZone = zones.timeZone;
    const requirementError = assertTypeRequirements(fields.type, fields);
    if (requirementError) {
      return { status: 400, body: { message: requirementError.message } };
    }

    const schedule = await resolveActivitySchedule({
      isCreate: false,
      planId: event.planId,
      body: legged.body,
      existingStart: event.startTime,
      existingEnd: event.endTime,
      excludeId: event._id,
    });
    if (schedule.error) {
      return { status: 400, body: { message: schedule.error } };
    }
    applySchedule(fields, schedule);

    for (const [key, value] of Object.entries(fields)) {
      event.set(key, value);
    }
    if (schedule.startTime) event.startTime = schedule.startTime;
    else event.set('startTime', null);
    if (schedule.endTime) event.endTime = schedule.endTime;
    else event.set('endTime', null);
    if (schedule.durationMinutes == null) event.set('durationMinutes', null);
    else event.durationMinutes = schedule.durationMinutes;
    const updatedEvent = await event.save();
    await recordActivityRevision(updatedEvent, 'update', callerId);
    if (originalEnd && !sameInstant(originalEnd, updatedEvent.endTime)) {
      await cascadeStored(updatedEvent.planId, updatedEvent._id, {
        anchorEnd: originalEnd,
        newEnd: updatedEvent.endTime,
      }, callerId);
    }
    await syncPlanDates(updatedEvent.planId);
    return { status: 200, body: updatedEvent };
  } catch (error) {
    return { status: 500, body: { message: 'Server error' } };
  }
}

// PUT update event (handles recursive subEvents)
router.put('/:id', authMiddleware, async (req, res) => {
  const callerId = req.user.userId || req.user.id;
  const result = await updateActivity(callerId, req.params.id, req.body || {});
  return res.status(result.status).json(result.body);
});

// Shared with DELETE /api/activities/:id and AI command apply.
async function deleteActivity(callerId, activityId) {
  try {
    const event = await Event.findById(activityId);
    if (!event) return { status: 404, body: { message: 'Event not found' } };
    const archived = await archivedMemberResult(event.planId, callerId);
    if (archived) return archived;
    const allowed = await callerMayEditActivities(event.planId, callerId);
    if (!allowed) {
      return {
        status: 403,
        body: { message: 'Only Owner or Collaborator can change activities' },
      };
    }
    const blocked = await editGate(callerId);
    if (blocked) return blocked;

    const planId = event.planId;
    await Event.findByIdAndDelete(activityId);
    await removeActivityReactions(activityId);
    await recordActivityRevision(event, 'delete', callerId);
    await syncPlanDates(planId);
    return { status: 200, body: { message: 'Event deleted successfully' } };
  } catch (error) {
    return { status: 500, body: { message: 'Server error' } };
  }
}

// DELETE event
router.delete('/:id', authMiddleware, async (req, res) => {
  const callerId = req.user.userId || req.user.id;
  const result = await deleteActivity(callerId, req.params.id);
  return res.status(result.status).json(result.body);
});

module.exports = router;
module.exports.createActivity = createActivity;
module.exports.updateActivity = updateActivity;
module.exports.deleteActivity = deleteActivity;