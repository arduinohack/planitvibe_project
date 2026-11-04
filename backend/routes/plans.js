const express = require('express');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const User = require('../models/User');
const Invitation = require('../models/Invitation');
const ActivityRevision = require('../models/ActivityRevision');
const SupportLog = require('../models/SupportLog');
const { Event } = require('../models/Event');
const { removePlanReactions } = require('../utils/activityReactions');
const { compareStoredOrder } = require('../utils/activityTimes');
const authMiddleware = require('../middleware/auth.js');  // Add this line for token verification
const { checkPermission } = require('../utils/permissions');
const { roleCheck, canonicalMembershipRole } = require('../middleware/roleCheck');
const { DateTime, IANAZone } = require('luxon');  // For time zone/DST in Day Numbers
const { v4: uuidv4 } = require('uuid');
const { notifyUsers } = require('../utils/notifications');
const { logSupport } = require('../utils/logSupport');
const multer = require('multer');
const {
  parseCsv,
  readColumnMap,
  headerIndex,
  cell,
  planZone,
  parseActivityTime,
  importDateStamp,
  escapeRegExp,
  uploadKind,
} = require('../utils/csvPlanImport');
const { readExportQuery, buildPlanExport } = require('../utils/planExport');
const { fetchPlaceMapPng } = require('../utils/placeMap');
const { suggestPlaces } = require('../utils/placeSuggest');
const { proposePlanCommand, applyPlanCommand, commandHistory } = require('../utils/aiCommand');
const {
  OPTIMIZE_ROLE,
  proposeDayOptimization,
  applyDayOptimization,
} = require('../utils/optimizeDay');
const { getAiClient } = require('../utils/aiProvider');
const { attachItineraryWarnings } = require('../utils/itineraryWarnings');
const { buildPlanWarnings } = require('../utils/planWarnings');
const { findActivityWithPlace } = require('../utils/activityPlace');
const { spansByPlanId } = require('../utils/activityDateSpan');
const {
  preparePlanCreate,
  preparePlanRecall,
  preparePlanDelete,
  prepareExport,
  prepareEdit,
  prepareAi,
  excessPlanIds,
} = require('../utils/planAccess');
const {
  archivedPlanGuard,
  notArchivedFilter,
  readArchiveDescription,
  isArchivedStatus,
} = require('../utils/planArchive');
const Template = require('../models/Template');
const {
  readTemplateName,
  readTemplateDescription,
  activitySnapshot,
  templateFieldsFromPlan,
} = require('../utils/planTemplate');
const router = express.Router();
router.use('/:planId', archivedPlanGuard);
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const logger = require('../utils/logger');  // Added: Borrow exported logger from ../util/logger.js

function planGateBody(gate) {
  if (gate && gate.body && typeof gate.body === 'object') return gate.body;
  return { message: gate && gate.message };
}


// POST /api/plans (Protected: Creates plan and assigns Owner role)
router.post('/', authMiddleware, async (req, res) => {
  const { type, name, destination, startDate, endDate, timeZone, budget } = req.body;

  logger.info('In Post /api/plans - Creates plan and assigns Owner role to requestor');
  // Validate required fields
  if (!type || !name) {
    return res.status(400).json({ msg: 'Missing required fields: type, name' });
  }

  try {
    const callerId = req.user.userId || req.user.id;
    const gate = await preparePlanCreate(callerId);
    if (gate.status !== 200) {
      return res.status(gate.status).json(planGateBody(gate));
    }

    // Generate UUID for plan ID
    const planId = uuidv4();

    logger.info('userId: ', req.user.userId);
    
    // Create the plan document
    const plan = new Plan({
      _id: planId,
      type,
      name,
      destination: req.body.destination,
      startDate: req.body.startDate ? new Date(req.body.startDate) : null,  // FIXED: Allow null
      endDate: req.body.endDate ? new Date(req.body.endDate) : null,  // FIXED: Allow null
      location: req.body.location,
      timeZone: req.body.timeZone,
      budget: req.body.budget || 0,
      autoCalculateStartDate: req.body.autoCalculateStartDate || true,
      autoCalculateEndDate: req.body.autoCalculateEndDate || true,
      ownerId: req.user.userId
    });
    await plan.save();  // Now saves with null dates    // Assign Owner role

    const planUser = new PlanUser({
      planId,
      userId: req.user.userId,
      role: 'Owner'
    });
    await planUser.save();

    // Notify the creator
    await notifyUsers([req.user.userId], `Your plan "${name}" has been created! ID: ${planId}`);

    await logSupport({
      level: 'info',
      event: 'PlanCreated',
      actorUserId: req.user.userId || req.user.id,
      planId,
      message: 'Plan created',
      extra: { type, name },
    });

    // Success response
    res.status(201).json({ 
      msg: 'Plan created successfully!', 
      plan 
    });
  } catch (err) {
    console.error('Plan creation error:', err);
    res.status(500).json({ msg: 'Server error during plan creation' });
  }
});

// GET /api/plans (Protected: Lists user's plans as owner or participant)
// get plans that user is an owner(VibeCoordinator), VibePlanner or Wanderer
router.get('/', authMiddleware, async (req, res) => {
  logger.info('Lists user\'s plans as owner or participant', {
    userId: req.user.userId,
    event: 'GetAPIPlans',
    context: { context: 'n/a' }
  });

  try {
    const userId = req.user.userId || req.user.id;
    const memberships = await PlanUser.find({ userId }).select('planId role');
    const planIds = memberships.map((membership) => membership.planId);
    const includeArchived = req.query.includeArchived === '1'
      || req.query.includeArchived === 'true';
    const memberOf = {
      $or: [
        { _id: { $in: planIds } },
        { ownerId: userId },
      ],
    };
    let query = { $and: [memberOf, notArchivedFilter()] };
    if (includeArchived) {
      const recallIds = memberships
        .filter((membership) => {
          const role = canonicalMembershipRole(membership.role);
          return role === 'Owner' || role === 'Collaborator';
        })
        .map((membership) => membership.planId);
      query = {
        $or: [
          query,
          { status: 'archived', ownerId: userId },
          { status: 'archived', _id: { $in: recallIds } },
        ],
      };
    }
    const plans = await Plan.find(query).populate('participants');
    const ids = plans.map((plan) => plan._id);
    const activities = ids.length
      ? await Event.find({ planId: { $in: ids } }).select('planId startTime endTime').lean()
      : [];
    const spans = spansByPlanId(activities);
    const payload = plans.map((plan) => {
      const obj = typeof plan.toJSON === 'function' ? plan.toJSON() : plan;
      const span = spans.get(String(plan._id)) || { earliestStart: null, latestEnd: null };
      obj.earliestStart = span.earliestStart;
      obj.latestEnd = span.latestEnd;
      return obj;
    });
    const excess = await excessPlanIds(payload.map((plan) => plan.ownerId));
    for (const plan of payload) {
      plan.trialReadOnly = excess.has(String(plan._id));
    }
    res.status(200).json({ plans: payload });
  } catch (error) {
    console.error('Fetch plans error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/plans/:planId. A member may read the plan, including sourcePlanId.
router.get('/:planId', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }
    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (!role) {
      return res.status(403).json({ message: 'Not authorized to read plan' });
    }
    const payload = typeof plan.toJSON === 'function' ? plan.toJSON() : plan;
    const excess = await excessPlanIds([payload.ownerId]);
    payload.trialReadOnly = excess.has(String(payload._id));
    return res.json({ plan: payload });
  } catch (err) {
    console.error('Get plan error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});
/*    try {
    // Find plans where user is owner
    const ownedPlans = await Plan.find({ ownerId: req.user.userId }).select('type name destination startDate endDate autoCalculateStartDate autoCalculateEndDate location budget planningState timeZone ownerId');

    // Find plans where user is participant (via plan_users)
    const participantPlans = await PlanUser.find({ userId: req.user.userId }).populate('planId', 'name destination startDate endDate planningState timeZone');
    const participantPlanObjs = participantPlans.filter(pt => pt.planId).map(pt => pt.planId);  // Filter undefined

    // Combine and dedupe
    const allPlans = [...ownedPlans, ...participantPlanObjs];
    const uniquePlans = Array.from(new Set(allPlans.map(t => t._id.toString()))).map(id => 
      allPlans.find(t => t._id.toString() === id)
    );

    res.json({ 
      msg: 'User plans fetched!', 
      plans: uniquePlans.sort((a, b) => new Date(a.startDate) - new Date(b.startDate))  // Sort by startDate
    });
  } catch (err) {
    console.error('List plans error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});
*/

// GET /api/plans/:planId/users (Protected: Lists plan participants with roles)
// Need to read users and role if the requesting user is owner or VibePlanner only
router.get('/:planId/users', authMiddleware, async (req, res) => {
  const { planId } = req.params;
  logger.info('In Get /api/plans/{planID}/users - lists a plans users');

  try {
    // Check caller is participant
    const callerPlanUser = await PlanUser.findOne({ planId, userId: req.user.userId });
    if (!callerPlanUser) {
      return res.status(403).json({ msg: 'Access denied: Not a plan participant' });
    }

    // Fetch all plan users, populate with full user details
    const planUsers = await PlanUser.find({ planId }).populate('userId', 'firstName lastName email');

    // Format response
    const formatted = planUsers.map(tu => ({
      userId: tu.userId._id,
      name: `${tu.userId.firstName} ${tu.userId.lastName}`,
      email: tu.userId.email,
      role: tu.role
    }));

    // Group by role
    const grouped = {
      Owner: formatted.filter(u => canonicalMembershipRole(u.role) === 'Owner'),
      Collaborator: formatted.filter(u => canonicalMembershipRole(u.role) === 'Collaborator'),
      Guest: formatted.filter(u => canonicalMembershipRole(u.role) === 'Guest')
    };

    res.json({ 
      msg: 'Plan users fetched!', 
      users: formatted,  // Flat list
      grouped  // Role-grouped for UI
    });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

function memberDisplayName(user) {
  if (!user) return '';
  return `${user.firstName || ''} ${user.lastName || ''}`.trim();
}

function normalizeMemberEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function escapeMemberEmailRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function memberEmailMatch(email) {
  return { email: { $regex: `^${escapeMemberEmailRegex(email)}$`, $options: 'i' } };
}

function pendingInviteFilter(planId, email, userId) {
  const matchers = [memberEmailMatch(email)];
  if (userId) matchers.push({ userId: String(userId) });
  return { planId, status: 'pending', $or: matchers };
}

function memberInstant(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function pendingInstant(invite) {
  return memberInstant(invite.invitedAt) || memberInstant(invite.createdAt);
}

// GET /api/plans/:planId/members
// Owner, Collaborator, or Guest. Accepted people, pending invitations, and
// declined invitations. Pending invitedAt is the latest invite. Accepted
// lastActivityAt is the newest activity revision that person made on this plan.
router.get('/:planId/members', roleCheck(['Owner', 'Collaborator', 'Guest']), async (req, res) => {
  const { planId } = req.params;
  logger.info('In Get /api/plans/{planId}/members - lists accepted, pending, and declined people');

  try {
    const [planUsers, invites] = await Promise.all([
      PlanUser.find({ planId }).select('userId role createdAt').lean(),
      Invitation.find({ planId, status: { $in: ['pending', 'accepted', 'rejected'] } })
        .select('userId email role status createdAt updatedAt invitedAt')
        .lean(),
    ]);

    const userIds = new Set();
    for (const row of planUsers) {
      if (row.userId) userIds.add(String(row.userId));
    }
    for (const invite of invites) {
      if (invite.userId) userIds.add(String(invite.userId));
    }

    const users = userIds.size
      ? await User.find({ _id: { $in: [...userIds] } }).select('firstName lastName email').lean()
      : [];
    const userById = new Map(users.map((user) => [String(user._id), user]));

    const acceptedIds = planUsers
      .map((row) => (row.userId ? String(row.userId) : ''))
      .filter(Boolean);
    const lastActivityByUser = new Map();
    if (acceptedIds.length) {
      const revisions = await ActivityRevision.find({
        planId,
        userId: { $in: acceptedIds },
      }).select('userId createdAt').lean();
      for (const revision of revisions) {
        const id = String(revision.userId || '');
        const instant = memberInstant(revision.createdAt);
        if (!id || !instant) continue;
        const previous = lastActivityByUser.get(id);
        if (!previous || instant > previous) lastActivityByUser.set(id, instant);
      }
    }

    const members = [];
    const seenIds = new Set();
    const seenEmails = new Set();
    function remember(id, email) {
      if (id) seenIds.add(id);
      const normalized = normalizeMemberEmail(email);
      if (normalized) seenEmails.add(normalized);
    }
    function alreadyListed(id, email) {
      if (id && seenIds.has(id)) return true;
      const normalized = normalizeMemberEmail(email);
      return Boolean(normalized && seenEmails.has(normalized));
    }

    for (const row of planUsers) {
      const id = String(row.userId || '');
      const user = userById.get(id);
      const email = (user && user.email) || '';
      const lastActivityAt = lastActivityByUser.get(id);
      const item = {
        name: memberDisplayName(user),
        email,
        role: row.role,
        status: 'accepted',
      };
      if (lastActivityAt) item.lastActivityAt = lastActivityAt;
      members.push(item);
      remember(id, email);
    }

    const pendingInvites = invites
      .filter((invite) => invite.status === 'pending')
      .sort((a, b) => {
        const aTime = pendingInstant(a);
        const bTime = pendingInstant(b);
        if (aTime === bTime) return 0;
        return aTime < bTime ? 1 : -1;
      });
    for (const invite of pendingInvites) {
      const id = invite.userId ? String(invite.userId) : '';
      const user = id ? userById.get(id) : null;
      const email = (user && user.email) || invite.email || '';
      if (alreadyListed(id, email)) continue;
      const invitedAt = pendingInstant(invite);
      const item = {
        name: memberDisplayName(user),
        email,
        role: invite.role,
        status: invite.status,
      };
      if (invitedAt) item.invitedAt = invitedAt;
      members.push(item);
      remember(id, email);
    }

    for (const invite of invites) {
      if (invite.status !== 'rejected') continue;
      const id = invite.userId ? String(invite.userId) : '';
      const user = id ? userById.get(id) : null;
      const email = (user && user.email) || invite.email || '';
      if (alreadyListed(id, email)) continue;
      const invitedAt = memberInstant(invite.updatedAt) || memberInstant(invite.createdAt);
      const item = {
        name: memberDisplayName(user),
        email,
        role: invite.role,
        status: invite.status,
      };
      if (invitedAt) item.invitedAt = invitedAt;
      members.push(item);
      remember(id, email);
    }

    res.json({ members });
  } catch (err) {
    console.error('List members error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// DELETE /api/plans/:planId/members with { email }
// Owner may remove Collaborator or Guest. Collaborator may remove Guest.
// Guest is 403. Owner cannot be removed (400).
router.delete('/:planId/members', roleCheck(['Owner', 'Collaborator', 'Guest']), async (req, res) => {
  const { planId } = req.params;
  const email = normalizeMemberEmail(req.body && req.body.email);
  logger.info('In Delete /api/plans/{planId}/members - remove a member or pending invite');

  if (!email) {
    return res.status(400).json({ msg: 'Missing email' });
  }

  const callerRole = canonicalMembershipRole(req.planUser && req.planUser.role);
  if (callerRole === 'Guest') {
    return res.status(403).json({ msg: 'Access denied: insufficient plan role' });
  }

  try {
    const user = await User.findOne(memberEmailMatch(email)).select('firstName lastName email').lean();
    const userId = user ? String(user._id) : '';
    const [plan, membership, pending] = await Promise.all([
      Plan.findById(planId).select('name ownerId').lean(),
      userId ? PlanUser.findOne({ planId, userId }).lean() : null,
      Invitation.find(pendingInviteFilter(planId, email, userId)).select('role userId email').lean(),
    ]);

    const membershipRole = canonicalMembershipRole(membership && membership.role);
    const pendingRole = canonicalMembershipRole(pending[0] && pending[0].role);
    const isOwner = membershipRole === 'Owner'
      || pendingRole === 'Owner'
      || (userId && plan && String(plan.ownerId) === userId);

    if (isOwner) {
      return res.status(400).json({ msg: 'Cannot remove Owner' });
    }

    if (!membership && pending.length === 0) {
      return res.status(404).json({ msg: 'Member not found' });
    }

    const targetRole = membershipRole || pendingRole;
    if (callerRole === 'Collaborator' && targetRole !== 'Guest') {
      return res.status(403).json({ msg: 'Collaborators can only remove Guests' });
    }

    if (membership) {
      await PlanUser.deleteOne({ planId, userId: membership.userId });
    }
    if (pending.length) {
      await Invitation.deleteMany(pendingInviteFilter(planId, email, userId));
    }

    const planName = (plan && plan.name) || 'a plan';
    await notifyUsers(
      [userId || email],
      `You've been removed from "${planName}".`,
      'email',
    );

    res.status(200).json({ msg: 'Member removed' });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/plans/:planId/place-map?placeId=
// Member-only PNG of a Google Map around a Place ID stored on this plan.
router.get('/:planId/place-map', async (req, res) => {
  const planId = String((req.params && req.params.planId) || '').trim();
  const placeId = String((req.query && req.query.placeId) || '').trim();
  logger.info('In Get /api/plans/{planId}/place-map - Google Map around a stored Place ID', {
    userId: req.user.userId,
    event: 'GetAPIPlanPlaceMap',
    context: { planId, placeId },
  });

  if (!placeId) {
    return res.status(400).json({ msg: 'Missing placeId' });
  }

  try {
    const plan = await Plan.findOne({ _id: planId }).select('_id').lean();
    if (!plan) {
      return res.status(404).json({ msg: 'Plan not found' });
    }

    const userId = String((req.user && (req.user.userId || req.user.id)) || '').trim();
    const membership = await PlanUser.findOne({ planId, userId }).select('_id').lean();
    if (!membership) {
      return res.status(404).json({ msg: 'Membership not found' });
    }

    const onPlan = await findActivityWithPlace(planId, placeId);
    if (!onPlan) {
      return res.status(404).json({ msg: 'Place not on an activity' });
    }

    const result = await fetchPlaceMapPng(placeId);
    if (result.status !== 200) {
      const status = result.status === 404 ? 502 : result.status;
      return res.status(status).json({ msg: result.msg });
    }
    res.set('Content-Type', result.contentType || 'image/png');
    return res.status(200).send(result.png);
  } catch (err) {
    console.error('Place map error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/plans/:planId/remove-user (Protected: Removes user by ID)
// Owners can remove VibePlanners or Wanderers. VibePlanners can remove Wanderers.
router.post('/:planId/remove-user', authMiddleware, async (req, res) => {
  const { planId } = req.params;
  const { userId: targetUserId } = req.body;
  
  logger.info('In Post /api/plans/{planID}/remove-user - removes a user from a plan');

  if (!targetUserId) {
    return res.status(400).json({ msg: 'Missing userId to remove' });
  }

  try {
    const callerPlanUser = await PlanUser.findOne({ planId, userId: req.user.userId });
    if (!callerPlanUser) {
      return res.status(403).json({ msg: 'Access denied: Not a plan participant' });
    }

    if (targetUserId === req.user.userId) {
      return res.status(400).json({ msg: 'Cannot remove yourself' });
    }

    const targetPlanUser = await PlanUser.findOne({ planId, userId: targetUserId });
    if (!targetPlanUser) {
      return res.status(404).json({ msg: 'Target user not found on plan' });
    }

    const callerRole = canonicalMembershipRole(callerPlanUser.role);
    const targetRole = canonicalMembershipRole(targetPlanUser.role);
    if (callerRole !== 'Owner' && targetRole !== 'Guest') {
      return res.status(403).json({ msg: 'Collaborators can only remove Guests' });
    }

    if (targetRole === 'Owner') {
      return res.status(400).json({ msg: 'Cannot remove Owner—use reassign instead' });
    }

    await PlanUser.deleteOne({ planId, userId: targetUserId });

    const removedUser = await User.findById(targetUserId).select('firstName lastName');
    const plan = await Plan.findById(planId).select('name');

    await notifyUsers([targetUserId], `You've been removed from "${plan.name}" by ${callerPlanUser.userId}.`, 'email');
    await notifyUsers([req.user.userId], `Removed ${removedUser.firstName} ${removedUser.lastName} from "${plan.name}".`, 'email');

    res.json({ msg: 'User removed successfully!' });
  } catch (err) {
    console.error('Remove user error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

async function reassignTargetId(body) {
  const rawId = body && typeof body.targetUserId === 'string' ? body.targetUserId.trim() : '';
  if (rawId) return rawId;
  const email = normalizeMemberEmail(body && body.email);
  if (!email) return '';
  const user = await User.findOne(memberEmailMatch(email)).select('_id').lean();
  return user ? String(user._id) : '';
}

function personName(user, email) {
  const first = user && typeof user.firstName === 'string' ? user.firstName.trim() : '';
  const last = user && typeof user.lastName === 'string' ? user.lastName.trim() : '';
  const named = `${first} ${last}`.trim();
  if (named) return named;
  return email || 'the new owner';
}

// POST /api/plans/:planId/reassign-coordinator
// Owner assigns an accepted Collaborator. Body is { email } or { targetUserId }.
// A Guest or a pending invite is 400. A non-owner is 403. No token is 401.
router.post('/:planId/reassign-coordinator', authMiddleware, async (req, res) => {
  const { planId } = req.params;
  logger.info('In Post /api/plans/{planID}/reassign-coordinator - transfers plan ownership to an accepted Collaborator');

  try {
    const callerId = String((req.user && (req.user.userId || req.user.id)) || '');
    const callerPlanUser = await PlanUser.findOne({ planId, userId: callerId });
    if (!callerPlanUser || canonicalMembershipRole(callerPlanUser.role) !== 'Owner') {
      return res.status(403).json({ msg: 'Only Owner can reassign' });
    }

    const targetId = await reassignTargetId(req.body);
    if (!targetId || targetId === callerId) {
      return res.status(400).json({ msg: 'Target must be an accepted Collaborator' });
    }

    const targetPlanUser = await PlanUser.findOne({ planId, userId: targetId });
    if (!targetPlanUser || canonicalMembershipRole(targetPlanUser.role) !== 'Collaborator') {
      return res.status(400).json({ msg: 'Target must be an accepted Collaborator' });
    }

    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ msg: 'Plan not found' });
    }

    targetPlanUser.role = 'Owner';
    await targetPlanUser.save();
    await PlanUser.updateMany(
      {
        planId,
        userId: { $ne: targetId },
        role: { $in: ['Owner', 'VibeCoordinator', 'coordinator'] },
      },
      { $set: { role: 'Collaborator' } },
    );
    plan.ownerId = targetId;
    await plan.save();

    const targetUser = await User.findById(targetId).select('firstName lastName email').lean();
    const targetEmail = (targetUser && targetUser.email) || normalizeMemberEmail(req.body && req.body.email);
    const reassignMsg = `Ownership transferred to ${personName(targetUser, targetEmail)}.`;
    await notifyUsers([callerId, targetId], reassignMsg, 'email');

    res.json({ msg: 'Ownership reassigned!', ownerId: targetId });
  } catch (err) {
    console.error('Reassign error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

function selectedActivityIds(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'activityIds') || !Array.isArray(body.activityIds)) {
    return { invalid: true, message: 'activityIds is required' };
  }
  const ids = [];
  const seen = new Set();
  for (const item of body.activityIds) {
    if (typeof item !== 'string') {
      return { invalid: true, message: 'An activity is not on this plan' };
    }
    const id = item.trim();
    if (!id) return { invalid: true, message: 'An activity is not on this plan' };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids };
}

async function activityMissingFromPlan(planId, ids) {
  if (!ids.length) return false;
  const found = await Event.find({ _id: { $in: ids }, planId }).select('_id').lean();
  return found.length !== ids.length;
}

function relevantZone(event, plan) {
  return event.type === 'flight'
    ? (event.destinationTimeZone || plan.timeZone)
    : plan.timeZone;
}

function startMillis(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function compareByStart(a, b) {
  const aStart = startMillis(a.startTime);
  const bStart = startMillis(b.startTime);
  if (aStart == null && bStart == null) return String(a._id).localeCompare(String(b._id));
  if (aStart == null) return 1;
  if (bStart == null) return -1;
  if (aStart !== bStart) return aStart - bStart;
  return String(a._id).localeCompare(String(b._id));
}

// POST /api/plans/:planId/link { activityIds }
// A member, including Guest, creates a personal plan that points at the
// selected activities. Those activities stay on this plan.
router.post('/:planId/link', authMiddleware, async (req, res) => {
  const { planId } = req.params;
  try {
    const source = await Plan.findById(planId);
    if (!source) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(source, callerId);
    if (role !== 'Owner' && role !== 'Collaborator' && role !== 'Guest') {
      return res.status(403).json({ message: 'Only a plan member can link a personal plan' });
    }

    const selected = selectedActivityIds(req.body);
    if (selected.invalid) {
      return res.status(400).json({ message: selected.message });
    }
    if (await activityMissingFromPlan(planId, selected.ids)) {
      return res.status(400).json({ message: 'An activity is not on this plan' });
    }

    const gate = await preparePlanCreate(callerId);
    if (gate.status !== 200) {
      return res.status(gate.status).json(planGateBody(gate));
    }

    const personalId = uuidv4();
    const sourceName = typeof source.name === 'string' ? source.name.trim() : '';
    const personal = new Plan({
      _id: personalId,
      type: source.type,
      name: sourceName ? `My ${sourceName}` : 'My plan',
      destination: source.destination,
      location: source.location,
      timeZone: source.timeZone,
      budget: 0,
      autoCalculateStartDate: false,
      autoCalculateEndDate: false,
      ownerId: callerId,
      sourcePlanId: String(source._id),
      linkedActivityIds: selected.ids,
    });
    personal.sourcePlanId = String(source._id);
    await personal.save();
    await new PlanUser({
      planId: personalId,
      userId: callerId,
      role: 'Owner',
    }).save();

    const saved = await Plan.findById(personalId).lean();
    return res.status(201).json({ plan: saved });
  } catch (err) {
    console.error('Link plan error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/plans/:planId/link { activityIds }
// The owner of a personal plan replaces the selected source activities.
// Unchecked activities stay on the source plan.
router.put('/:planId/link', authMiddleware, async (req, res) => {
  const { planId } = req.params;
  try {
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner') {
      return res.status(403).json({ message: 'Only the Owner can change linked activities' });
    }

    const sourcePlanId = typeof plan.sourcePlanId === 'string' ? plan.sourcePlanId.trim() : '';
    if (!sourcePlanId) {
      return res.status(400).json({ message: 'This plan is not linked to another plan' });
    }

    const selected = selectedActivityIds(req.body);
    if (selected.invalid) {
      return res.status(400).json({ message: selected.message });
    }
    if (await activityMissingFromPlan(sourcePlanId, selected.ids)) {
      return res.status(400).json({ message: 'An activity is not on this plan' });
    }

    plan.linkedActivityIds = selected.ids;
    plan.sourcePlanId = sourcePlanId;
    await plan.save();
    return res.json({ plan });
  } catch (err) {
    console.error('Update linked activities error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/plans/:planId/warnings
// Any plan member. Advisory overlaps and a 30-minute Place ID gap. Nothing is saved.
router.get('/:planId/warnings', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }
    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (!role) {
      return res.status(403).json({ message: 'Not authorized to read plan' });
    }
    const activities = await Event.find({ planId: String(plan._id) }).lean();
    return res.json({ warnings: buildPlanWarnings(activities) });
  } catch (err) {
    console.error('Plan warnings error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/plans/:planId/itinerary (Protected: Fetches sorted events with Day Numbers)
// owners, assigned planners and assigned wanderers can get the plan itinierary
router.get('/:planId/itinerary', authMiddleware, async (req, res) => {
  const { planId } = req.params;

  logger.info('In Get /api/plans/{planID}/itinerary - fetches sorted events with Day Numbers');

  try {

    const canRead = await checkPermission(req.user.userId, planId, 'read');
    if (!canRead) return res.status(403).json({ message: 'Not authorized to read plan' });

    // Fetch plan for timeZone
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ msg: 'Plan not found' });
    }

    // Stored itinerary order. Equal eventNum values fall back to start time.
    let events = await Event.find({ $or: [{ planId: planId }, { eventPlanId: planId }] });
    events.sort(compareStoredOrder);
    events = events.map(event => ({
      ...event.toObject(),
      relevantTimeZone: relevantZone(event, plan),
    }));

    const sourcePlanId = typeof plan.sourcePlanId === 'string' ? plan.sourcePlanId.trim() : '';
    if (sourcePlanId) {
      const linkedIds = Array.isArray(plan.linkedActivityIds)
        ? plan.linkedActivityIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
      const linked = linkedIds.length
        ? await Event.find({ planId: sourcePlanId, _id: { $in: linkedIds } })
        : [];
      const own = events.map((event) => ({ ...event, linked: false }));
      const fromSource = linked.map((event) => ({
        ...event.toObject(),
        relevantTimeZone: relevantZone(event, plan),
        linked: true,
      }));
      events = [...own, ...fromSource];
      events.sort(compareByStart);
    }

    // Compute Day Numbers (loop, compare to previous). First event is day 1.
    let dayNumber = 1;
    let previousEnd = null;
    events.forEach(event => {
      if (previousEnd) {
        const start = DateTime.fromJSDate(event.startTime, { zone: event.relevantTimeZone });
        const prev = DateTime.fromJSDate(previousEnd, { zone: event.relevantTimeZone });
        if (start.startOf('day') > prev.startOf('day')) dayNumber++;
      }
      event.dayNumber = dayNumber;
      previousEnd = event.endTime;
    });

    // Response-only flags. Overlaps use UTC times. Travel checks are consecutive
    // in that time order and never fail this request.
    await attachItineraryWarnings(events);

    // Group by dayNumber
    const grouped = events.reduce((acc, event) => {
      const day = event.dayNumber;
      acc[day] = acc[day] || [];
      acc[day].push(event);
      return acc;
    }, {});

    res.json({ 
      msg: 'Itinerary fetched!', 
      events,  // Flat list with dayNumber
      grouped  // {1: [events], 2: [events], ...}
    });
  } catch (err) {
    console.error('Itinerary error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

async function nextImportName(sourceName, timeZone) {
  const stamp = importDateStamp(timeZone);
  const pattern = new RegExp(`^${escapeRegExp(sourceName)} ${stamp} (\\d+)$`);
  const existing = await Plan.find({ name: pattern }).select('name').lean();
  let max = 0;
  for (const plan of existing) {
    const match = pattern.exec(plan.name);
    if (!match) continue;
    const n = Number(match[1]);
    if (n > max) max = n;
  }
  return `${sourceName} ${stamp} ${max + 1}`;
}

function bodyText(body, key) {
  const value = body && body[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readCsvUpload(req, res) {
  return new Promise((resolve, reject) => {
    csvUpload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve(req.file);
    });
  });
}

// POST /api/plans/:planId/import
// Owner or Collaborator uploads a CSV. Creates a new plan and one activity per named row.
router.post('/:planId/import', authMiddleware, async (req, res) => {
  const { planId } = req.params;
  try {
    const source = await Plan.findById(planId);
    if (!source) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const callerId = req.user.userId || req.user.id;
    const membership = await PlanUser.findOne({ planId, userId: callerId });
    let role = canonicalMembershipRole(membership && membership.role);
    if (!role && String(source.ownerId) === String(callerId)) role = 'Owner';
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({ message: 'Only Owner or Collaborator can import a plan' });
    }

    let file;
    try {
      file = await readCsvUpload(req, res);
    } catch (err) {
      if (res.headersSent) return;
      return res.status(400).json({ message: 'Only a CSV file can be imported' });
    }
    if (res.headersSent) return;

    const kind = uploadKind(file);
    if (kind === 'spreadsheet' || kind === 'notcsv') {
      return res.status(400).json({ message: 'Only a CSV file can be imported' });
    }
    if (kind !== 'csv') {
      return res.status(400).json({ message: 'CSV file and a column map are required' });
    }

    const columnMap = readColumnMap(req.body && req.body.map);
    if (!columnMap) {
      return res.status(400).json({ message: 'CSV file and a column map are required' });
    }

    const rows = parseCsv(file.buffer.toString('utf8'));
    const headers = rows[0] || [];
    const nameIndex = headerIndex(headers, columnMap.name);
    if (nameIndex < 0) {
      return res.status(400).json({ message: 'The name column is not in the CSV' });
    }
    const typeIndex = headerIndex(headers, columnMap.type);
    const startIndex = headerIndex(headers, columnMap.startTime);
    const endIndex = headerIndex(headers, columnMap.endTime);
    const locationIndex = headerIndex(headers, columnMap.location);
    const zone = planZone(source.timeZone);
    const planName = bodyText(req.body, 'planName');
    const defaultType = bodyText(req.body, 'defaultType');
    const typeMapped = typeIndex >= 0;
    if (!typeMapped && !defaultType) {
      return res.status(400).json({ message: 'A default type is required when type is not mapped' });
    }

    const activities = [];
    let skipped = 0;
    for (const dataRow of rows.slice(1)) {
      const name = cell(dataRow, nameIndex);
      if (!name) {
        skipped += 1;
        continue;
      }
      const activity = {
        _id: uuidv4(),
        name,
        type: typeMapped ? (cell(dataRow, typeIndex) || 'activity') : defaultType,
        location: cell(dataRow, locationIndex),
        planId: '',
        ownerId: callerId,
        status: 'draft',
      };
      const startTime = parseActivityTime(cell(dataRow, startIndex), zone);
      const endTime = parseActivityTime(cell(dataRow, endIndex), zone);
      if (startTime) activity.startTime = startTime;
      if (endTime) activity.endTime = endTime;
      activities.push(activity);
    }

    const gate = await preparePlanCreate(callerId);
    if (gate.status !== 200) {
      return res.status(gate.status).json(planGateBody(gate));
    }

    const newPlanId = uuidv4();
    const created = new Plan({
      _id: newPlanId,
      type: source.type,
      name: planName || await nextImportName(source.name, source.timeZone),
      destination: source.destination,
      startDate: source.startDate || null,
      endDate: source.endDate || null,
      location: source.location,
      timeZone: source.timeZone,
      ownerId: callerId,
    });
    await created.save();
    await new PlanUser({
      planId: newPlanId,
      userId: callerId,
      role: 'Owner',
    }).save();

    if (activities.length) {
      for (const activity of activities) activity.planId = newPlanId;
      await Event.insertMany(activities);
    }

    return res.status(201).json({
      planId: newPlanId,
      name: created.name,
      inserted: activities.length,
      skipped,
    });
  } catch (err) {
    if (res.headersSent) return;
    console.error('Plan import error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/plans/:planId/export
// Owner or Collaborator downloads the plan's activities. No plan is created.
router.get('/:planId/export', authMiddleware, async (req, res) => {
  const { planId } = req.params;
  try {
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({ message: 'Only Owner or Collaborator can export a plan' });
    }

    const gate = await prepareExport(callerId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }

    const requested = readExportQuery(req.query);
    if (requested.error) {
      return res.status(400).json({ message: requested.error });
    }

    const activities = await Event.find({ planId }).lean();
    activities.sort(compareStoredOrder);
    const file = buildPlanExport({
      planName: plan.name,
      planTimeZone: plan.timeZone,
      activities,
      fields: requested.fields,
      format: requested.format,
    });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', file.disposition);
    return res.status(200).send(file.body);
  } catch (err) {
    console.error('Plan export error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

async function callerPlanRole(plan, callerId) {
  const membership = await PlanUser.findOne({ planId: plan._id, userId: callerId });
  let role = canonicalMembershipRole(membership && membership.role);
  if (!role && String(plan.ownerId) === String(callerId)) role = 'Owner';
  return role;
}

function sharedPerson(row, user) {
  return {
    userId: String(row.userId),
    email: (user && user.email) || '',
    firstName: (user && user.firstName) || '',
    lastName: (user && user.lastName) || '',
    role: row.role,
  };
}

function sharedInvite(row, user) {
  return {
    _id: String(row._id),
    email: (user && user.email) || row.email || '',
    role: row.role,
    status: 'pending',
  };
}

function textField(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { present: false };
  const value = body[key];
  if (value == null) return { present: true, value: '' };
  if (typeof value !== 'string') return { present: true, invalid: true };
  return { present: true, value: value.trim() };
}

// Intl accepts EST and numeric offsets. A plan stores an IANA name, same rule as an activity zone.
function isPlanIanaName(zone) {
  if (!zone || !IANAZone.isValidZone(zone)) return false;
  if (zone === 'UTC') return true;
  if (!zone.includes('/')) return false;
  if (/^[+-]\d/.test(zone)) return false;
  return true;
}

function boolField(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { present: false };
  if (typeof body[key] !== 'boolean') return { present: true, invalid: true };
  return { present: true, value: body[key] };
}

function dateField(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { present: false };
  const value = body[key];
  if (value == null || value === '') return { present: true, value: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { present: true, invalid: true };
  return { present: true, value: date };
}

const HIDDEN_FIELD_NAMES = new Set([
  'destination',
  'budget',
  'cost',
  'bookingReference',
  'details',
]);

function hiddenFieldsField(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'hiddenFields')) {
    return { present: false };
  }
  const value = body.hiddenFields;
  if (!Array.isArray(value)) return { present: true, invalid: true };
  const names = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') return { present: true, invalid: true };
    const name = item.trim();
    if (!HIDDEN_FIELD_NAMES.has(name) || seen.has(name)) {
      return { present: true, invalid: true };
    }
    seen.add(name);
    names.push(name);
  }
  return { present: true, value: names };
}

function budgetIsBlank(value) {
  if (value == null) return true;
  return typeof value === 'string' && value.trim() === '';
}

function budgetField(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'budget')) return { present: false };
  const value = body.budget;
  if (budgetIsBlank(value)) return { present: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { present: true, invalid: true };
  }
  return { present: true, value };
}

// POST /api/plans/:planId/suggest
// Owner or Collaborator. Reads Places and does not write the plan or its activities.
// The request log records this call.
router.post('/:planId/suggest', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({
        message: 'Only Owner or Collaborator can suggest places',
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    let aiClient = null;
    try {
      aiClient = await getAiClient(req.user);
    } catch (err) {
      const message = err && err.message ? err.message : 'request failed';
      console.error('Place suggest AI client failed:', message);
    }
    const gate = await prepareAi(callerId, aiClient, planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }
    const result = await suggestPlaces({
      query: body.query,
      activityType: body.activityType,
      location: body.location,
      destination: plan.destination,
      aiClient,
      usage: {
        userId: String(callerId || ''),
        planId,
        feature: 'suggest',
        aiClient,
      },
    });
    if (result.status === 402) {
      return res.status(402).json({
        message: result.msg,
        places: Array.isArray(result.places) ? result.places : [],
      });
    }
    if (result.status !== 200) {
      return res.status(result.status).json({ message: result.msg });
    }
    return res.json(result.places);
  } catch (err) {
    console.error('Place suggest error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

function optimizeRequest(body) {
  const source = requestObject(body);
  const day = source.day;
  const mode = source.mode;
  if (!Number.isInteger(day) || day < 1) {
    return { error: 'Day must be a positive number' };
  }
  if (mode !== 'tighten' && mode !== 'buffer') {
    return { error: 'Mode must be tighten or buffer' };
  }
  return { day, mode };
}

// POST /api/plans/:planId/optimize-day
// Owner or Collaborator. Returns time shifts and does not write them.
router.post('/:planId/optimize-day', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({ message: OPTIMIZE_ROLE });
    }
    const gate = await prepareEdit(callerId, planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }
    const requested = optimizeRequest(req.body);
    if (requested.error) {
      return res.status(400).json({ message: requested.error });
    }
    const proposal = await proposeDayOptimization(plan, requested.day, requested.mode);
    return res.json(proposal);
  } catch (err) {
    console.error('Optimize day error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/plans/:planId/optimize-day/apply
// Owner or Collaborator. Writes the confirmed start and end times.
router.post('/:planId/optimize-day/apply', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({ message: OPTIMIZE_ROLE });
    }
    const gate = await prepareEdit(callerId, planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }
    const result = await applyDayOptimization({
      planId,
      callerId: String(callerId || ''),
      changes: requestObject(req.body).changes,
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Optimize day apply error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

const AI_EDIT_ROLE = 'Only Owner or Collaborator can use AI edit';

function requestObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

// POST /api/plans/:planId/ai-command
// Owner or Collaborator. Returns a proposal and does not write an activity.
router.post('/:planId/ai-command', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({ message: AI_EDIT_ROLE });
    }

    const body = requestObject(req.body);
    const instruction = body.instruction;
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ message: 'Instruction is required' });
    }
    if (instruction.trim().length > 2000) {
      return res.status(400).json({ message: 'Instruction is too long' });
    }
    const history = commandHistory(body.history);
    if (history == null) {
      return res.status(400).json({ message: 'History must be a list' });
    }

    let aiClient = null;
    try {
      aiClient = await getAiClient(req.user);
    } catch (err) {
      const message = err && err.message ? err.message : 'request failed';
      console.error('AI command client failed:', message);
    }
    const gate = await prepareAi(callerId, aiClient, planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }
    const result = await proposePlanCommand({
      plan,
      instruction: instruction.trim(),
      history,
      aiClient,
      userId: String(callerId || ''),
    });
    if (result.status !== 200) {
      return res.status(result.status).json({ message: result.message });
    }
    return res.json({ summary: result.summary, proposal: result.proposal });
  } catch (err) {
    const message = err && err.message ? err.message : 'request failed';
    console.error('AI command error:', message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/plans/:planId/ai-command/apply
// Owner or Collaborator. Writes the confirmed proposal through activity create, update, or delete.
router.post('/:planId/ai-command/apply', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({ message: AI_EDIT_ROLE });
    }

    const gate = await prepareEdit(callerId, planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }

    const result = await applyPlanCommand({
      planId,
      callerId: String(callerId || ''),
      proposal: requestObject(req.body),
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    const message = err && err.message ? err.message : 'request failed';
    console.error('AI command apply error:', message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/plans/:planId
// Owner or Collaborator may edit name, destination, budget, dates, and time zone.
// Type and ownerId stay as stored. A Guest is 403.
router.put('/:planId', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({ message: 'Only Owner or Collaborator can edit a plan' });
    }

    const gate = await prepareEdit(callerId, planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = textField(body, 'name');
    if (name.invalid) return res.status(400).json({ message: 'Name must be text' });
    if (name.present && !name.value) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const destination = textField(body, 'destination');
    if (destination.invalid) {
      return res.status(400).json({ message: 'Destination must be text' });
    }
    if (destination.present && plan.type === 'trip' && !destination.value) {
      return res.status(400).json({ message: 'Destination is required' });
    }

    const budget = budgetField(body);
    if (budget.invalid) {
      return res.status(400).json({ message: 'Budget must be a number' });
    }

    const startDate = dateField(body, 'startDate');
    const endDate = dateField(body, 'endDate');
    if (startDate.invalid || endDate.invalid) {
      return res.status(400).json({ message: 'Enter a valid date' });
    }

    const timeZone = textField(body, 'timeZone');
    if (timeZone.invalid) {
      return res.status(400).json({ message: 'Time zone must be text' });
    }
    if (timeZone.present && !isPlanIanaName(timeZone.value)) {
      return res.status(400).json({ message: 'Time zone must be an IANA name' });
    }

    const autoStart = boolField(body, 'autoCalculateStartDate');
    const autoEnd = boolField(body, 'autoCalculateEndDate');
    if (autoStart.invalid) {
      return res.status(400).json({ message: 'Auto-calculate start must be true or false' });
    }
    if (autoEnd.invalid) {
      return res.status(400).json({ message: 'Auto-calculate end must be true or false' });
    }

    const hiddenFields = hiddenFieldsField(body);
    if (hiddenFields.invalid) {
      return res.status(400).json({ message: 'Hidden fields are not valid' });
    }

    if (name.present) plan.name = name.value;
    if (destination.present) plan.destination = destination.value;
    if (budget.present) plan.budget = budget.value;
    if (startDate.present) plan.startDate = startDate.value;
    if (endDate.present) plan.endDate = endDate.value;
    if (timeZone.present) plan.timeZone = timeZone.value;
    if (autoStart.present) plan.autoCalculateStartDate = autoStart.value;
    if (autoEnd.present) plan.autoCalculateEndDate = autoEnd.value;
    if (hiddenFields.present) plan.hiddenFields = hiddenFields.value;

    await plan.save();
    return res.json({ plan });
  } catch (err) {
    console.error('Edit plan error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

const ACTIVITY_COPY_SKIP = new Set([
  '_id',
  'id',
  '__v',
  'createdAt',
  'updatedAt',
  'planId',
  'ownerId',
]);

function copyPlanName(source, body) {
  const supplied = body && body.name;
  if (supplied != null && typeof supplied !== 'string') {
    return { error: 'Name must be text.' };
  }
  if (typeof supplied === 'string' && supplied.trim()) return { name: supplied.trim() };
  const original = typeof source.name === 'string' ? source.name.trim() : '';
  return { name: original ? `Copy of ${original}` : 'Copy of plan' };
}

function copiedActivity(source, planId, ownerId) {
  const doc = { _id: uuidv4(), planId, ownerId: String(ownerId) };
  for (const [key, value] of Object.entries(source)) {
    if (ACTIVITY_COPY_SKIP.has(key)) continue;
    doc[key] = value;
  }
  return doc;
}

// POST /api/plans/:planId/copy { name? }
// Owner only. The source must be active. The new plan counts toward the cap.
router.post('/:planId/copy', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const source = await Plan.findById(planId).lean();
    if (!source) return res.status(404).json({ message: 'Plan not found' });
    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(source, callerId);
    if (role !== 'Owner') {
      return res.status(403).json({ message: 'Only the Owner can copy a plan.' });
    }
    if (isArchivedStatus(source)) {
      return res.status(403).json({ message: 'This plan is archived.' });
    }
    const named = copyPlanName(source, req.body);
    if (named.error) return res.status(400).json({ message: named.error });

    const gate = await preparePlanCreate(callerId);
    if (gate.status !== 200) {
      return res.status(gate.status).json(planGateBody(gate));
    }

    const newId = uuidv4();
    const plan = new Plan({
      _id: newId,
      type: source.type,
      name: named.name,
      destination: source.destination,
      startDate: source.startDate || null,
      endDate: source.endDate || null,
      autoCalculateStartDate: source.autoCalculateStartDate === true,
      autoCalculateEndDate: source.autoCalculateEndDate === true,
      location: source.location,
      budget: source.budget,
      hiddenFields: Array.isArray(source.hiddenFields) ? source.hiddenFields : [],
      planningState: source.planningState,
      timeZone: source.timeZone,
      ownerId: callerId,
    });
    const activities = await Event.find({ planId }).lean();
    const copies = activities.map((activity) => copiedActivity(activity, newId, callerId));
    try {
      await plan.save();
      await new PlanUser({ planId: newId, userId: callerId, role: 'Owner' }).save();
      if (copies.length) await Event.insertMany(copies);
    } catch (err) {
      await Event.deleteMany({ planId: newId });
      await PlanUser.deleteMany({ planId: newId });
      await Plan.deleteOne({ _id: newId });
      throw err;
    }

    await logSupport({
      level: 'info',
      event: 'PlanCopied',
      actorUserId: callerId,
      planId: newId,
      message: 'Plan copied',
      extra: { sourcePlanId: planId, name: named.name },
    });

    const saved = await Plan.findById(newId);
    return res.status(201).json({ plan: saved });
  } catch (err) {
    console.error('Copy plan error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/plans/:planId/save-as-template { name, description? }
// Owner only. The source must be active. The template is not a plan.
router.post('/:planId/save-as-template', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const source = await Plan.findById(planId).lean();
    if (!source) return res.status(404).json({ message: 'Plan not found' });
    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(source, callerId);
    if (role !== 'Owner') {
      return res.status(403).json({ message: 'Only the Owner can save a plan as a template.' });
    }
    if (isArchivedStatus(source)) {
      return res.status(403).json({ message: 'This plan is archived.' });
    }
    const named = readTemplateName(req.body);
    if (named.error) return res.status(400).json({ message: named.error });
    const described = readTemplateDescription(req.body);
    if (described.error) return res.status(400).json({ message: described.error });

    const activities = await Event.find({ planId }).lean();
    activities.sort(compareStoredOrder);
    const template = new Template({
      _id: uuidv4(),
      ownerId: String(callerId),
      name: named.name,
      description: described.text,
      sourcePlanId: planId,
      ...templateFieldsFromPlan(source),
      activities: activities.map(activitySnapshot),
    });
    await template.save();

    await logSupport({
      level: 'info',
      event: 'TemplateSaved',
      actorUserId: callerId,
      planId,
      message: 'Plan saved as template',
      extra: { templateId: template._id, name: named.name },
    });

    return res.status(201).json({ template });
  } catch (err) {
    console.error('Save template error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/plans/:planId/archive { description }
// Owner only. The plan leaves the owned-plan count and stays closed to members.
router.post('/:planId/archive', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner') {
      return res.status(403).json({ message: 'Only the Owner can archive a plan.' });
    }
    const description = readArchiveDescription(req.body);
    if (description.error) return res.status(400).json({ message: description.error });
    plan.status = 'archived';
    plan.archiveDescription = description.text;
    plan.archivedAt = new Date();
    plan.archivedBy = String(callerId);
    await plan.save();
    return res.json({ plan });
  } catch (err) {
    console.error('Archive plan error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/plans/:planId/recall
// The Owner or an accepted Co-Planner. The plan counts toward the owner's cap again.
router.post('/:planId/recall', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({ message: 'Only the Owner or a Co-Planner can recall a plan.' });
    }
    if (!isArchivedStatus(plan)) {
      return res.status(400).json({ message: 'This plan is not archived.' });
    }
    const gate = await preparePlanRecall(plan.ownerId);
    if (gate.status !== 200) {
      return res.status(gate.status).json(planGateBody(gate));
    }
    await Plan.updateOne(
      { _id: planId },
      {
        $set: { status: 'active', archiveDescription: '' },
        $unset: { archivedAt: 1, archivedBy: 1 },
      },
    );
    const saved = await Plan.findById(planId);
    return res.json({ plan: saved });
  } catch (err) {
    console.error('Recall plan error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/plans/:planId
// The Owner may delete a plan that is not shared. Another member or a pending invite is 409.
router.delete('/:planId', authMiddleware, async (req, res) => {
  const planId = String(req.params.planId || '');
  try {
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const callerId = req.user.userId || req.user.id;
    const role = await callerPlanRole(plan, callerId);
    if (role !== 'Owner') {
      return res.status(403).json({ message: 'Only the Owner can delete a plan' });
    }

    const gate = await preparePlanDelete(callerId, planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }

    const [others, pending] = await Promise.all([
      PlanUser.find({ planId, userId: { $ne: callerId } }).lean(),
      Invitation.find({ planId, status: 'pending' }).lean(),
    ]);
    if (others.length || pending.length) {
      const userIds = [...new Set(
        [...others, ...pending].map((row) => row.userId).filter(Boolean),
      )];
      const users = userIds.length
        ? await User.find({ _id: { $in: userIds } }).select('email firstName lastName').lean()
        : [];
      const byId = new Map(users.map((user) => [String(user._id), user]));
      return res.status(409).json({
        message: 'Plan is still shared with someone else',
        people: others.map((row) => sharedPerson(row, byId.get(String(row.userId)))),
        invites: pending.map((row) => sharedInvite(row, byId.get(String(row.userId)))),
      });
    }

    await Event.deleteMany({ planId });
    await removePlanReactions(planId);
    await ActivityRevision.deleteMany({ planId });
    await Invitation.deleteMany({ planId });
    await SupportLog.deleteMany({ planId });
    await PlanUser.deleteMany({ planId });
    await Plan.deleteOne({ _id: planId });

    return res.json({ message: 'Plan deleted' });
  } catch (err) {
    console.error('Delete plan error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;