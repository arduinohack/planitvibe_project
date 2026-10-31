const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const {
  createPresenceStore,
  memberMayJoin,
  memberDisplayName,
} = require('../utils/presence');

function presenceRoom(planId) {
  return `plan:${planId}`;
}

function readHandshakeToken(socket) {
  const auth = socket && socket.handshake && socket.handshake.auth;
  const header = socket && socket.handshake && socket.handshake.headers
    && socket.handshake.headers.authorization;
  const raw = (auth && auth.token) || header || '';
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) return trimmed.slice(7).trim();
  return trimmed;
}

function looksLikeJwt(token) {
  return typeof token === 'string' && token.split('.').length === 3;
}

async function verifyClientToken(token) {
  if (!looksLikeJwt(token)) {
    throw new Error('unauthorized');
  }
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw new Error('unauthorized');
  }
  const userId = decoded && (decoded.userId || decoded.id);
  if (!userId) throw new Error('unauthorized');
  if (global.redisClient) {
    try {
      const flag = await global.redisClient.get(token);
      if (flag === 'blacklisted') throw new Error('unauthorized');
    } catch (err) {
      if (err && err.message === 'unauthorized') throw err;
    }
  }
  return { userId: String(userId) };
}

function asObject(payload) {
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      return null;
    }
    return null;
  }
  if (payload && typeof payload === 'object') return payload;
  return null;
}

function readPlanId(payload) {
  const body = asObject(payload);
  if (!body || typeof body.planId !== 'string') return '';
  return body.planId.trim();
}

function readActivityId(payload) {
  const body = asObject(payload);
  if (!body || typeof body.activityId !== 'string') return '';
  return body.activityId.trim();
}

function splitAck(payload, ack) {
  if (typeof payload === 'function') return { payload: null, ack: payload };
  return { payload, ack };
}

function replyTo(ack, body) {
  if (typeof ack === 'function') ack(body);
}

async function defaultCanJoin(userId, planId) {
  const Plan = require('../models/Plan');
  const PlanUser = require('../models/PlanUser');
  const { canonicalMembershipRole } = require('../middleware/roleCheck');
  const plan = await Plan.findById(planId).select('ownerId').lean();
  if (!plan) return { ok: false };
  const membership = await PlanUser.findOne({
    planId: String(plan._id),
    userId: String(userId),
  }).select('role').lean();
  let role = canonicalMembershipRole(membership && membership.role);
  if (!role && String(plan.ownerId) === String(userId)) role = 'Owner';
  if (!memberMayJoin(role)) return { ok: false };
  return { ok: true, planId: String(plan._id) };
}

async function defaultLoadName(userId) {
  const User = require('../models/User');
  const user = await User.findById(userId).select('firstName lastName email').lean();
  return memberDisplayName(user);
}

function normalizeJoin(result, requestedId) {
  if (result === true) return { ok: true, planId: requestedId };
  if (!result || result.ok !== true) return { ok: false };
  const planId = result.planId != null ? String(result.planId) : requestedId;
  if (!planId) return { ok: false };
  return { ok: true, planId };
}

function presenceCors(allows) {
  return {
    origin(origin, callback) {
      if (typeof allows !== 'function' || !allows(origin)) {
        callback(null, false);
        return;
      }
      callback(null, origin || true);
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  };
}

function registerPresence(io, options = {}) {
  const store = options.store || createPresenceStore();
  const authenticate = options.authenticate || verifyClientToken;
  const canJoin = options.canJoin || defaultCanJoin;
  const loadName = options.loadName || defaultLoadName;

  io.use(async (socket, next) => {
    try {
      const user = await authenticate(readHandshakeToken(socket));
      if (!user || !user.userId) return next(new Error('unauthorized'));
      socket.data.userId = String(user.userId);
      return next();
    } catch (err) {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('join', async (payload, ack) => {
      const parts = splitAck(payload, ack);
      const planId = readPlanId(parts.payload);
      if (!planId) {
        replyTo(parts.ack, { ok: false });
        return;
      }
      let decision;
      try {
        decision = normalizeJoin(await canJoin(socket.data.userId, planId), planId);
      } catch (err) {
        replyTo(parts.ack, { ok: false });
        return;
      }
      if (!decision.ok || !socket.connected) {
        replyTo(parts.ack, { ok: false });
        return;
      }
      let name = 'Member';
      try {
        const loaded = await loadName(socket.data.userId);
        if (typeof loaded === 'string' && loaded.trim()) name = loaded.trim();
      } catch (err) {
        name = 'Member';
      }
      if (!socket.connected) {
        replyTo(parts.ack, { ok: false });
        return;
      }
      const moved = store.setJoined(socket.id, {
        userId: socket.data.userId,
        name,
        planId: decision.planId,
      });
      if (moved.previousPlanId) {
        socket.leave(presenceRoom(moved.previousPlanId));
        io.to(presenceRoom(moved.previousPlanId)).emit('presence', moved.leftPresence);
      }
      socket.join(presenceRoom(decision.planId));
      io.to(presenceRoom(decision.planId)).emit('presence', moved.presence);
      replyTo(parts.ack, { ok: true });
    });

    socket.on('editing', (payload, ack) => {
      const parts = splitAck(payload, ack);
      const planId = readPlanId(parts.payload);
      const presence = store.setEditing(socket.id, {
        planId,
        activityId: readActivityId(parts.payload),
      });
      if (!presence) {
        replyTo(parts.ack, { ok: false });
        return;
      }
      io.to(presenceRoom(planId)).emit('presence', presence);
      replyTo(parts.ack, { ok: true });
    });

    socket.on('idle', (payload, ack) => {
      const parts = splitAck(payload, ack);
      const planId = readPlanId(parts.payload);
      const presence = store.setIdle(socket.id, { planId });
      if (!presence) {
        replyTo(parts.ack, { ok: false });
        return;
      }
      io.to(presenceRoom(planId)).emit('presence', presence);
      replyTo(parts.ack, { ok: true });
    });

    // Socket.IO ping timeout lands here. Drop that socket and refresh the room.
    socket.on('disconnect', () => {
      const removed = store.remove(socket.id);
      if (!removed) return;
      io.to(presenceRoom(removed.planId)).emit('presence', removed.presence);
    });
  });
}

let reactionIo = null;

function setReactionIo(io) {
  reactionIo = io || null;
}

// HTTP has no sender socket. io.to reaches every browser that joined the plan room.
// A missing or throwing server must not fail the vote that was already saved.
function emitPlanReaction(planId, payload) {
  const io = reactionIo;
  const id = planId == null ? '' : String(planId).trim();
  if (!io || !id) return;
  try {
    const target = io.to(presenceRoom(id));
    if (!target || typeof target.emit !== 'function') return;
    const body = payload && typeof payload === 'object' ? payload : {};
    target.emit('reaction', body);
  } catch (err) {
    // Best effort. The HTTP response still returns the saved counts.
  }
}

function attachPresence(httpServer, options = {}) {
  const allows = options.allowsBrowserOrigin || require('../app').allowsBrowserOrigin;
  const io = new Server(httpServer, { cors: presenceCors(allows) });
  registerPresence(io, options);
  setReactionIo(io);
  return io;
}

module.exports = {
  attachPresence,
  registerPresence,
  presenceCors,
  verifyClientToken,
  readHandshakeToken,
  presenceRoom,
  setReactionIo,
  emitPlanReaction,
};
