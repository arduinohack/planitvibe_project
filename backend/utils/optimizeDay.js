const { DateTime, IANAZone } = require('luxon');
const { Event } = require('../models/Event');
const { MIN_CONNECTION_MS } = require('./planWarnings');
const { recordActivityRevision } = require('./recordActivityRevision');
const { syncPlanDates } = require('./syncPlanDates');

const OPTIMIZE_ROLE = 'Only Owner or Collaborator can optimize a day';

function planZoneName(plan) {
  const zone = plan && typeof plan.timeZone === 'string' ? plan.timeZone.trim() : '';
  if (zone && IANAZone.isValidZone(zone)) return zone;
  return 'UTC';
}

function instantMs(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function calendarKey(ms, zone) {
  const local = DateTime.fromMillis(ms, { zone });
  if (!local.isValid) return null;
  return local.toISODate();
}

function placeIdOf(activity) {
  return String(activity && activity.googlePlaceId || '').trim();
}

function activityKey(activity) {
  return String(activity && (activity._id || activity.id) || '').trim();
}

// Calendar days from the earliest start through the latest end, in the plan zone.
// Day 1 is that first start date. An activity belongs to the day of its start.
function dayKeys(activities, zone) {
  let origin = null;
  let latest = null;
  for (const activity of activities) {
    const start = instantMs(activity && activity.startTime);
    const end = instantMs(activity && activity.endTime);
    const startKey = start == null ? null : calendarKey(start, zone);
    const endKey = end == null ? null : calendarKey(end, zone);
    if (startKey && (origin == null || startKey < origin)) origin = startKey;
    if (startKey && (latest == null || startKey > latest)) latest = startKey;
    const endOrStart = endKey || startKey;
    if (endOrStart && (latest == null || endOrStart > latest)) latest = endOrStart;
  }
  if (!origin || !latest) return [];
  const days = [];
  let cursor = DateTime.fromISO(origin, { zone: 'utc' });
  const endDate = DateTime.fromISO(latest, { zone: 'utc' });
  while (cursor <= endDate) {
    days.push(cursor.toISODate());
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

function compareRows(left, right) {
  if (left.start !== right.start) return left.start - right.start;
  return left.id.localeCompare(right.id);
}

function rowFrom(activity, planId) {
  const start = instantMs(activity.startTime);
  const end = instantMs(activity.endTime);
  const linked = activity.linked === true || String(activity.planId || '') !== String(planId);
  return {
    id: activityKey(activity),
    start,
    end,
    placeId: placeIdOf(activity),
    linked,
    timed: start != null && end != null && end > start,
  };
}

// Timed activities are walked in start order. A row with no usable end breaks
// the chain so a later activity is not pulled across it.
function segmentsOf(rows) {
  const segments = [];
  let current = [];
  for (const row of rows) {
    if (!row.timed || !row.id) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(row);
  }
  if (current.length) segments.push(current);
  return segments;
}

function shiftSegment(rows, mode) {
  const next = rows.map((row) => ({
    ...row,
    newStart: row.start,
    newEnd: row.end,
  }));
  for (let index = 1; index < next.length; index += 1) {
    const previous = next[index - 1];
    const current = next[index];
    if (current.linked) continue;
    let newStart = current.start;
    if (mode === 'buffer') {
      const gap = current.start - previous.newEnd;
      if (gap < MIN_CONNECTION_MS) newStart = previous.newEnd + MIN_CONNECTION_MS;
    } else {
      const oldGap = current.start - previous.end;
      const placePair = previous.placeId && current.placeId;
      const desiredGap = placePair && oldGap > MIN_CONNECTION_MS
        ? MIN_CONNECTION_MS
        : oldGap;
      newStart = previous.newEnd + desiredGap;
    }
    current.newStart = newStart;
    current.newEnd = newStart + (current.end - current.start);
  }
  return next;
}

function summaryFor(day, mode, count) {
  if (!count) return 'Day already fits.';
  const moves = count === 1 ? '1 activity' : `${count} activities`;
  if (mode === 'tighten') {
    return `Day ${day}: move ${moves} earlier so Place ID gaps are 30 minutes.`;
  }
  return `Day ${day}: move ${moves} later so each gap is at least 30 minutes.`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

async function shownActivities(plan) {
  const planId = String(plan._id);
  const own = await Event.find({ planId }).lean();
  const rows = own.map((row) => ({ ...row, linked: false }));
  const source = typeof plan.sourcePlanId === 'string' ? plan.sourcePlanId.trim() : '';
  const ids = Array.isArray(plan.linkedActivityIds)
    ? plan.linkedActivityIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  if (!source || !ids.length) return rows;
  const linked = await Event.find({ planId: source, _id: { $in: ids } }).lean();
  for (const row of linked) rows.push({ ...row, linked: true });
  return rows;
}

function proposeFromActivities(activities, { day, mode, timeZone, planId }) {
  const zone = timeZone || 'UTC';
  const keys = dayKeys(activities, zone);
  const key = day >= 1 && day <= keys.length ? keys[day - 1] : null;
  const onDay = [];
  if (key) {
    for (const activity of activities) {
      const start = instantMs(activity && activity.startTime);
      if (start == null || calendarKey(start, zone) !== key) continue;
      onDay.push(rowFrom(activity, planId));
    }
  }
  onDay.sort(compareRows);
  const changes = [];
  for (const segment of segmentsOf(onDay)) {
    for (const row of shiftSegment(segment, mode)) {
      if (row.linked || row.newStart === row.start) continue;
      changes.push({
        activityId: row.id,
        oldStart: iso(row.start),
        newStart: iso(row.newStart),
        oldEnd: iso(row.end),
        newEnd: iso(row.newEnd),
      });
    }
  }
  return { summary: summaryFor(day, mode, changes.length), changes };
}

async function proposeDayOptimization(plan, day, mode) {
  const activities = await shownActivities(plan);
  return proposeFromActivities(activities, {
    day,
    mode,
    timeZone: planZoneName(plan),
    planId: String(plan._id),
  });
}

function readChange(change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    return { error: 'Each change needs an activity and its old and new times' };
  }
  const activityId = typeof change.activityId === 'string' ? change.activityId.trim() : '';
  const oldStart = instantMs(change.oldStart);
  const newStart = instantMs(change.newStart);
  const oldEnd = instantMs(change.oldEnd);
  const newEnd = instantMs(change.newEnd);
  if (!activityId || oldStart == null || newStart == null || oldEnd == null || newEnd == null) {
    return { error: 'Each change needs an activity and its old and new times' };
  }
  if (oldEnd <= oldStart || newEnd - newStart !== oldEnd - oldStart) {
    return { error: 'A change must keep the activity length' };
  }
  return {
    activityId,
    oldStart,
    newStart,
    oldEnd,
    newEnd,
    delta: newStart - oldStart,
  };
}

function sameInstant(stored, ms) {
  const current = instantMs(stored);
  return current != null && current === ms;
}

function shiftLegs(legs, delta) {
  return legs.map((leg) => {
    const next = typeof leg.toObject === 'function' ? leg.toObject() : { ...leg };
    const departure = instantMs(next.departure);
    const arrival = instantMs(next.arrival);
    if (departure != null) next.departure = new Date(departure + delta);
    if (arrival != null) next.arrival = new Date(arrival + delta);
    return next;
  });
}

async function applyDayOptimization({ planId, callerId, changes }) {
  if (!Array.isArray(changes)) {
    return { status: 400, body: { message: 'Changes must be a list' } };
  }
  const parsed = [];
  const seen = new Set();
  for (const change of changes) {
    const row = readChange(change);
    if (row.error) return { status: 400, body: { message: row.error } };
    if (seen.has(row.activityId)) {
      return { status: 400, body: { message: 'Each activity can change once' } };
    }
    seen.add(row.activityId);
    if (row.delta !== 0) parsed.push(row);
  }
  if (!parsed.length) return { status: 200, body: { updated: 0 } };

  const docs = await Event.find({
    _id: { $in: parsed.map((row) => row.activityId) },
    planId: String(planId),
  });
  if (docs.length !== parsed.length) {
    return { status: 400, body: { message: 'An activity is not on this plan' } };
  }
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  for (const row of parsed) {
    const doc = byId.get(row.activityId);
    if (!sameInstant(doc.startTime, row.oldStart) || !sameInstant(doc.endTime, row.oldEnd)) {
      return {
        status: 409,
        body: { message: 'Activity times changed. Review the day again.' },
      };
    }
  }
  for (const row of parsed) {
    const doc = byId.get(row.activityId);
    doc.startTime = new Date(row.newStart);
    doc.endTime = new Date(row.newEnd);
    if (Array.isArray(doc.legs) && doc.legs.length) {
      doc.legs = shiftLegs(doc.legs, row.delta);
    }
    const saved = await doc.save();
    await recordActivityRevision(saved, 'update', callerId);
  }
  await syncPlanDates(planId);
  return { status: 200, body: { updated: parsed.length } };
}

module.exports = {
  OPTIMIZE_ROLE,
  proposeDayOptimization,
  proposeFromActivities,
  applyDayOptimization,
};
