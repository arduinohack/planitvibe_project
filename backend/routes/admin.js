const express = require('express');
const User = require('../models/User');
const AllowedEmail = require('../models/AllowedEmail');
const { signupInviteMode, setSignupInviteMode } = require('../utils/invites/signupInviteConfig');
const { sendSignupInvite, signupInviteFrom, signupUrlFor } = require('../utils/invites/sendSignupInvite');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const Invitation = require('../models/Invitation');
const { Event } = require('../models/Event');
const ActivityRevision = require('../models/ActivityRevision');
const SupportLog = require('../models/SupportLog');
const { logSupport } = require('../utils/logSupport');
const { recordActivityRevision } = require('../utils/recordActivityRevision');
const {
  removeActivityReactions,
  removePlanReactions,
} = require('../utils/activityReactions');
const { syncPlanDates } = require('../utils/syncPlanDates');
const { add: addAiCredits } = require('../utils/aiCredits');
const PublishedTemplate = require('../models/PublishedTemplate');
const { ownerCard } = require('../utils/publishedTemplate');

const router = express.Router();

function parseBound(value) {
  if (value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/users', async (req, res) => {
  try {
    const q = String(req.query.q == null ? '' : req.query.q).trim();
    if (q.length < 2) {
      return res.json({ users: [] });
    }
    const rows = await User.find({
      email: { $regex: escapeRegex(q), $options: 'i' },
    })
      .select('email firstName lastName role')
      .sort({ email: 1 })
      .limit(20)
      .lean();
    const users = rows.map((user) => ({
      _id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    }));
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Read-only account. PlanUser.role is the stored membership. ownerId with no row is Owner.
router.get('/users/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId || '');
    const user = await User.findById(userId)
      .select('email firstName lastName phoneNumber role')
      .lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const memberships = await PlanUser.find({ userId }).select('planId role').lean();
    const roleByPlan = new Map(memberships.map((row) => [String(row.planId), row.role || '']));
    const planIds = memberships.map((row) => row.planId).filter(Boolean);
    const plans = await Plan.find({
      $and: [
        {
          $or: [
            { _id: { $in: planIds } },
            { ownerId: userId },
          ],
        },
        { status: { $ne: 'archived' } },
      ],
    })
      .select('name type startDate endDate ownerId')
      .lean();

    const listed = plans
      .map((plan) => {
        const id = String(plan._id);
        const stored = roleByPlan.has(id) ? roleByPlan.get(id) : '';
        const role = stored || (String(plan.ownerId) === userId ? 'Owner' : '');
        return {
          _id: id,
          name: plan.name || '',
          type: plan.type || '',
          startDate: plan.startDate ? new Date(plan.startDate).toISOString() : null,
          endDate: plan.endDate ? new Date(plan.endDate).toISOString() : null,
          role,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id));

    res.json({
      _id: String(user._id),
      email: user.email || '',
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      phoneNumber: user.phoneNumber || '',
      role: user.role || '',
      plans: listed,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

// Read-only plan. PlanUser.role is the stored membership. ownerId with no row is Owner.
router.get('/plans/:planId', async (req, res) => {
  try {
    const planId = String(req.params.planId || '');
    const plan = await Plan.findById(planId)
      .select('name type destination startDate endDate timeZone ownerId')
      .lean();
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const memberships = await PlanUser.find({ planId }).select('userId role').lean();
    const memberIds = [];
    const roleByUser = new Map();
    for (const row of memberships) {
      const id = String(row.userId || '');
      if (!id || roleByUser.has(id)) continue;
      roleByUser.set(id, row.role || '');
      memberIds.push(id);
    }
    const ownerId = String(plan.ownerId || '');
    if (ownerId && !roleByUser.has(ownerId)) {
      roleByUser.set(ownerId, 'Owner');
      memberIds.push(ownerId);
    }

    const [users, activities] = await Promise.all([
      memberIds.length
        ? User.find({ _id: { $in: memberIds } }).select('email firstName lastName').lean()
        : [],
      Event.find({ planId }).select('name type startTime').lean(),
    ]);
    const userById = new Map(users.map((user) => [String(user._id), user]));
    const members = memberIds
      .map((id) => {
        const user = userById.get(id);
        return {
          email: (user && user.email) || '',
          firstName: (user && user.firstName) || '',
          lastName: (user && user.lastName) || '',
          role: roleByUser.get(id) || '',
        };
      })
      .sort((a, b) => a.email.localeCompare(b.email) || a.role.localeCompare(b.role));

    const listedActivities = activities
      .map((activity) => ({
        _id: String(activity._id),
        name: activity.name || '',
        type: activity.type || '',
        startTime: isoOrNull(activity.startTime),
      }))
      .sort((a, b) => {
        if (a.startTime === b.startTime) return a._id.localeCompare(b._id);
        if (!a.startTime) return 1;
        if (!b.startTime) return -1;
        return a.startTime < b.startTime ? -1 : 1;
      });

    res.json({
      _id: String(plan._id),
      name: plan.name || '',
      type: plan.type || '',
      destination: plan.destination || '',
      startDate: isoOrNull(plan.startDate),
      endDate: isoOrNull(plan.endDate),
      timeZone: plan.timeZone || '',
      members,
      activities: listedActivities,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Another member or a pending invitation blocks the delete. Nothing is written.
router.delete('/plans/:planId', async (req, res) => {
  try {
    const planId = String(req.params.planId || '');
    const plan = await Plan.findById(planId).select('_id ownerId');
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const ownerId = String(plan.ownerId || '');
    const memberQuery = { planId };
    if (ownerId) memberQuery.userId = { $ne: ownerId };
    const [otherMember, pendingInvite] = await Promise.all([
      PlanUser.exists(memberQuery),
      Invitation.exists({ planId, status: 'pending' }),
    ]);
    if (otherMember || pendingInvite) {
      return res.status(409).json({
        message: 'Plan is still shared with someone else',
      });
    }

    await Event.deleteMany({ planId });
    await removePlanReactions(planId);
    await ActivityRevision.deleteMany({ planId });
    await Invitation.deleteMany({ planId });
    await SupportLog.deleteMany({ planId });
    await PlanUser.deleteMany({ planId });
    await Plan.deleteOne({ _id: planId });

    res.json({ message: 'Plan deleted' });
  } catch (err) {
    console.error(`Admin delete plan failed: ${err.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/activities/:activityId', async (req, res) => {
  try {
    const activityId = String(req.params.activityId || '');
    const activity = await Event.findById(activityId)
      .select('name type planId startTime endTime location details')
      .lean();
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    const revisions = await ActivityRevision.find({ eventId: activityId })
      .select('action createdAt userId')
      .sort({ createdAt: -1 })
      .lean();
    const userIds = [...new Set(revisions.map((row) => row.userId).filter(Boolean))];
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('email').lean()
      : [];
    const emailById = new Map(users.map((user) => [String(user._id), user.email || '']));
    res.json({
      _id: String(activity._id),
      name: activity.name || '',
      type: activity.type || '',
      planId: activity.planId || '',
      startTime: isoOrNull(activity.startTime),
      endTime: isoOrNull(activity.endTime),
      location: activity.location || '',
      details: activity.details || '',
      revisions: revisions.map((revision) => ({
        action: revision.action || '',
        createdAt: isoOrNull(revision.createdAt),
        userId: revision.userId || '',
        email: emailById.get(String(revision.userId || '')) || '',
      })),
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Same delete revision as DELETE /api/activities/:id.
router.delete('/activities/:activityId', async (req, res) => {
  try {
    const activityId = String(req.params.activityId || '');
    const activity = await Event.findById(activityId);
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    const callerId = String((req.user && (req.user.userId || req.user.id)) || '');
    const planId = activity.planId;
    await Event.findByIdAndDelete(activityId);
    await removeActivityReactions(activityId);
    await recordActivityRevision(activity, 'delete', callerId);
    await syncPlanDates(planId);
    res.json({ message: 'Activity deleted' });
  } catch (err) {
    console.error(`Admin delete activity failed: ${err.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const query = {};
    if (req.query.event) query.event = req.query.event;
    if (req.query.level) query.level = req.query.level;
    if (req.query.userId) query.actorUserId = req.query.userId;
    if (req.query.planId) query.planId = req.query.planId;

    const createdAt = {};
    const from = parseBound(req.query.from);
    const to = parseBound(req.query.to);
    if (from === undefined || to === undefined) {
      return res.status(400).json({ message: 'from and to must be ISO dates' });
    }
    if (from) createdAt.$gte = from;
    if (to) createdAt.$lte = to;
    if (from || to) query.createdAt = createdAt;

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 100) limit = 100;

    let skip = parseInt(req.query.skip, 10);
    if (!Number.isFinite(skip) || skip < 0) skip = 0;

    const direction = String(req.query.dir || '').toLowerCase() === 'asc' ? 1 : -1;
    const docs = await SupportLog.find(query)
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit);
    const logs = docs.map((doc) => doc.toObject());
    const userIds = [...new Set(logs.map((row) => row.actorUserId).filter(Boolean))];
    const planIds = [...new Set(logs.map((row) => row.planId).filter(Boolean))];
    const [users, plans] = await Promise.all([
      userIds.length
        ? User.find({ _id: { $in: userIds } }).select('email').lean()
        : [],
      planIds.length
        ? Plan.find({ _id: { $in: planIds } }).select('name').lean()
        : [],
    ]);
    const emailById = new Map(users.map((user) => [String(user._id), user.email || '']));
    const nameById = new Map(plans.map((plan) => [String(plan._id), plan.name || '']));
    for (const row of logs) {
      const storedEmail = typeof row.actorEmail === 'string' ? row.actorEmail.trim() : '';
      const lookedUp = emailById.get(String(row.actorUserId || '')) || '';
      row.actorEmail = storedEmail || lookedUp;
      row.planName = nameById.get(String(row.planId || '')) || '';
    }

    res.json({ logs });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/users/:userId/ai-credits. Adds a positive amount.
router.post('/users/:userId/ai-credits', async (req, res) => {
  try {
    const userId = String(req.params.userId || '');
    const amount = req.body && req.body.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Amount must be a positive number' });
    }
    const user = await User.findById(userId).select('_id').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    const aiCredits = await addAiCredits(userId, amount);
    if (aiCredits == null) return res.status(404).json({ message: 'User not found' });
    return res.json({ aiCredits });
  } catch (err) {
    console.error('AI credit grant failed');
    return res.status(500).json({ message: 'Server error' });
  }
});

// Shared plans block the delete. Another member is not promoted.
router.delete('/users/:userId', async (req, res) => {
  try {
    const targetId = req.params.userId;
    const callerId = String((req.user && (req.user.userId || req.user.id)) || '');
    const target = await User.findById(targetId).select('_id');
    if (!target) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (callerId === String(targetId)) {
      return res.status(409).json({ message: 'You cannot delete your own account' });
    }

    const owned = await Plan.find({ ownerId: targetId }).select('_id name');
    const ownedIds = owned.map((plan) => plan._id);
    const blocking = [];
    if (ownedIds.length) {
      const [otherMembers, pendingOthers] = await Promise.all([
        PlanUser.find({ planId: { $in: ownedIds }, userId: { $ne: targetId } }).select('planId'),
        Invitation.find({
          planId: { $in: ownedIds },
          status: 'pending',
          userId: { $ne: targetId },
        }).select('planId'),
      ]);
      const blockedIds = new Set([
        ...otherMembers.map((row) => String(row.planId)),
        ...pendingOthers.map((row) => String(row.planId)),
      ]);
      for (const plan of owned) {
        if (blockedIds.has(String(plan._id))) {
          blocking.push({ _id: plan._id, name: plan.name });
        }
      }
    }
    if (blocking.length) {
      return res.status(409).json({
        message: 'User owns a plan still shared with someone else',
        plans: blocking,
      });
    }

    await Invitation.deleteMany({ $or: [{ userId: targetId }, { invitedBy: targetId }] });
    await PlanUser.deleteMany({ userId: targetId });

    const stillOwned = await Plan.find({ ownerId: targetId }).select('_id');
    const removable = [];
    for (const plan of stillOwned) {
      const planId = plan._id;
      const remainingMember = await PlanUser.exists({ planId });
      const pendingOther = await Invitation.exists({
        planId,
        status: 'pending',
        userId: { $ne: targetId },
      });
      if (!remainingMember && !pendingOther) removable.push(planId);
    }
    if (removable.length) {
      await Event.deleteMany({ planId: { $in: removable } });
      await removePlanReactions(removable);
      await ActivityRevision.deleteMany({ planId: { $in: removable } });
      await Invitation.deleteMany({ planId: { $in: removable } });
      await SupportLog.deleteMany({ planId: { $in: removable } });
      await Plan.deleteMany({ _id: { $in: removable } });
    }

    await logSupport({
      level: 'info',
      event: 'UserDeleted',
      actorUserId: callerId,
      message: 'User deleted',
      extra: { deletedUserId: targetId },
    });
    await User.findByIdAndDelete(targetId);

    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error(`Admin delete user failed: ${err.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

// Reviewer path for a reported public template. Copies are left in place.
router.post('/published-templates/:id/unpublish', async (req, res) => {
  try {
    const templateId = String(req.params.id || '');
    const doc = await PublishedTemplate.findById(templateId);
    if (!doc) return res.status(404).json({ message: 'Template not found' });
    doc.published = false;
    await doc.save();
    const callerId = String((req.user && (req.user.userId || req.user.id)) || '');
    await logSupport({
      level: 'info',
      event: 'TemplateUnpublishedByAdmin',
      actorUserId: callerId,
      message: 'Published template unpublished by a reviewer',
      extra: { templateId },
    });
    return res.json({ template: ownerCard(doc) });
  } catch (err) {
    console.error(`Admin unpublish template failed: ${err.message}`);
    return res.status(500).json({ message: 'Server error' });
  }
});

function normalizeAllowedEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isAllowedEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function allowedEmailNote(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  return value.trim();
}

function emailFromParam(rawParam) {
  let raw = rawParam || '';
  try {
    raw = decodeURIComponent(raw);
  } catch (err) {
    raw = rawParam || '';
  }
  return normalizeAllowedEmail(raw);
}

async function markInviteSent(row) {
  try {
    const result = await sendSignupInvite({
      email: row.email,
      signupUrl: signupUrlFor(row.email),
      from: signupInviteFrom(),
    });
    if (!result.success) {
      console.error(`Signup invite failed for ${row.email}: ${result.error}`);
      return false;
    }
    row.invitedAt = new Date();
    await row.save();
    return true;
  } catch (err) {
    console.error(`Signup invite failed for ${row.email}: ${err.message}`);
    return false;
  }
}

// GET /api/admin/allowed-emails. userCreatedAt is set when that address has an account.
router.get('/allowed-emails', async (req, res) => {
  try {
    const rows = await AllowedEmail.find({})
      .select('email note createdAt invitedAt')
      .sort({ createdAt: -1, email: 1 })
      .lean();
    const addresses = rows.map((row) => row.email).filter(Boolean);
    const users = addresses.length
      ? await User.find({
        $expr: { $in: [{ $toLower: '$email' }, addresses] },
      }).select('email createdAt').lean()
      : [];
    const createdByEmail = new Map();
    for (const user of users) {
      const key = normalizeAllowedEmail(user.email);
      if (!key || createdByEmail.has(key) || !user.createdAt) continue;
      createdByEmail.set(key, user.createdAt);
    }
    const emails = rows.map((row) => {
      const item = {
        email: row.email,
        note: typeof row.note === 'string' ? row.note : '',
        createdAt: row.createdAt,
        invitedAt: row.invitedAt || null,
      };
      const userCreatedAt = createdByEmail.get(row.email);
      if (userCreatedAt) item.userCreatedAt = userCreatedAt;
      return item;
    });
    const mode = await signupInviteMode();
    const unsent = rows.filter((row) => !row.invitedAt).length;
    return res.json({ emails, mode, unsent });
  } catch (err) {
    console.error(`Admin allowed emails list failed: ${err.message}`);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/admin/allowed-emails/mode. Body { mode: automatic | manual }.
router.put('/allowed-emails/mode', async (req, res) => {
  try {
    const mode = String((req.body && req.body.mode) || '').trim().toLowerCase();
    if (mode !== 'automatic' && mode !== 'manual') {
      return res.status(400).json({ message: 'Mode must be automatic or manual' });
    }
    await setSignupInviteMode(mode);
    return res.json({ mode });
  } catch (err) {
    console.error(`Admin signup invite mode failed: ${err.message}`);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/allowed-emails. Body { email, note? }.
router.post('/allowed-emails', async (req, res) => {
  const email = normalizeAllowedEmail(req.body && req.body.email);
  const note = allowedEmailNote(req.body && req.body.note);
  if (!email) return res.status(400).json({ message: 'Email is required' });
  if (!isAllowedEmailAddress(email)) {
    return res.status(400).json({ message: 'Email is not valid' });
  }
  if (note == null) return res.status(400).json({ message: 'Note must be text' });

  let doc;
  try {
    doc = await AllowedEmail.create({ email, note });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'Email is already allowed' });
    }
    console.error(`Admin allow email failed: ${err.message}`);
    return res.status(500).json({ message: 'Server error' });
  }

  let invitedAt = null;
  try {
    if (await signupInviteMode() === 'automatic') {
      const sent = await markInviteSent(doc);
      if (sent) invitedAt = doc.invitedAt;
    }
  } catch (err) {
    console.error(`Signup invite failed for ${doc.email}: ${err.message}`);
  }

  return res.status(201).json({
    email: doc.email,
    note: doc.note || '',
    createdAt: doc.createdAt,
    invitedAt,
  });
});

// POST /api/admin/allowed-emails/send-invites. Sends every row whose invitedAt is null.
router.post('/allowed-emails/send-invites', async (req, res) => {
  try {
    const rows = await AllowedEmail.find({ invitedAt: null }).sort({ email: 1 });
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      const ok = await markInviteSent(row);
      if (ok) sent += 1;
      else failed += 1;
    }
    return res.json({ sent, failed });
  } catch (err) {
    console.error(`Admin send signup invites failed: ${err.message}`);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/allowed-emails/:email/invite. Sends again and records the new time.
router.post('/allowed-emails/:email/invite', async (req, res) => {
  try {
    const email = emailFromParam(req.params.email);
    if (!email) return res.status(400).json({ message: 'Email is required' });
    const doc = await AllowedEmail.findOne({ email });
    if (!doc) return res.status(404).json({ message: 'Email is not on the list' });
    const sent = await markInviteSent(doc);
    if (!sent) return res.status(502).json({ message: 'Invitation email failed' });
    return res.json({ email: doc.email, invitedAt: doc.invitedAt });
  } catch (err) {
    console.error(`Admin resend signup invite failed: ${err.message}`);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/admin/allowed-emails/:email
router.delete('/allowed-emails/:email', async (req, res) => {
  try {
    const email = emailFromParam(req.params.email);
    if (!email) return res.status(400).json({ message: 'Email is required' });
    const removed = await AllowedEmail.findOneAndDelete({ email });
    if (!removed) return res.status(404).json({ message: 'Email is not on the list' });
    return res.json({ email: removed.email });
  } catch (err) {
    console.error(`Admin remove allowed email failed: ${err.message}`);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
