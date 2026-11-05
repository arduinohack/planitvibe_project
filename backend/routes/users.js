const express = require('express');
const User = require('../models/User');
const TripUser = require('../models/TripUser');
const Invitation = require('../models/Invitation');
const { adminCheck } = require('../middleware/adminCheck');
const {
  AI_PROVIDER_SET,
  ENCRYPTION_MESSAGE,
  encryptionConfigured,
  encryptApiKey,
} = require('../utils/aiProvider');
const ApiKey = require('../models/ApiKey');
const { NAME_LIMIT, generateApiKey } = require('../utils/apiKey');
const { getCreditBalances } = require('../utils/aiCredits');
const AiUsage = require('../models/AiUsage');
const { accessSummary } = require('../utils/planAccess');
const { createCreditCheckout } = require('../utils/stripeCredits');
const {
  TIER_PLANITVIBE,
  TIER_PLUS,
  TIER_PRO,
  planCapFor,
} = require('../utils/membershipTiers');
const router = express.Router();
const settingsRouter = express.Router();

const PROVIDER_MESSAGE = 'Provider must be xai, openai, anthropic, gemini, or none';

function callerId(req) {
  const id = req.user && (req.user.userId || req.user.id);
  return typeof id === 'string' ? id : '';
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function subscriptionTierOf(user) {
  const tier = user && typeof user.tier === 'string' ? user.tier.trim() : '';
  if (tier === TIER_PLANITVIBE || tier === TIER_PLUS || tier === TIER_PRO) return tier;
  return null;
}

// Fields the Subscription and AI Settings page reads. plusActive and the
// older tier fields stay on the same response.
function subscriptionStatusFields(user, balances) {
  const subscriptionTier = subscriptionTierOf(user);
  const status = user && typeof user.subscriptionStatus === 'string'
    ? user.subscriptionStatus.trim()
    : '';
  const renewing = status === 'active' || status === 'trialing';
  const unlimited = subscriptionTier === TIER_PLUS || subscriptionTier === TIER_PRO;
  return {
    subscriptionTier,
    subscriptionStartedAt: subscriptionTier ? isoOrNull(user.subscribedAt) : null,
    subscriptionEndsAt: subscriptionTier ? isoOrNull(user.plusCurrentPeriodEnd) : null,
    autoRenew: Boolean(subscriptionTier) && renewing,
    planLimit: unlimited ? null : planCapFor(subscriptionTier || 'trial'),
    monthlyCreditsRemaining: balances.monthlyCredits,
  };
}

function settingsBody(user) {
  const provider = AI_PROVIDER_SET.has(user && user.aiProvider) ? user.aiProvider : 'none';
  const encrypted = user && user.aiApiKeyEncrypted;
  return {
    aiProvider: provider,
    hasKey: typeof encrypted === 'string' && encrypted.length > 0,
  };
}

// GET /api/users/me/ai-settings
settingsRouter.get('/me/ai-settings', async (req, res) => {
  try {
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ message: 'No token, authorization denied' });
    const user = await User.findById(userId).select('aiProvider +aiApiKeyEncrypted').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json(settingsBody(user));
  } catch (err) {
    const message = err && err.message ? err.message : 'request failed';
    console.error('AI settings read failed:', message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/users/me/ai-settings
// A blank or missing apiKey clears the stored key. Provider "none" also clears it.
settingsRouter.put('/me/ai-settings', async (req, res) => {
  try {
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ message: 'No token, authorization denied' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : null;
    if (!body || typeof body.aiProvider !== 'string') {
      return res.status(400).json({ message: PROVIDER_MESSAGE });
    }
    const provider = body.aiProvider.trim();
    if (!AI_PROVIDER_SET.has(provider)) {
      return res.status(400).json({ message: PROVIDER_MESSAGE });
    }
    if (Object.prototype.hasOwnProperty.call(body, 'apiKey')
      && body.apiKey != null
      && typeof body.apiKey !== 'string') {
      return res.status(400).json({ message: 'API key must be text' });
    }

    const user = await User.findById(userId).select('_id');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const typed = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const clear = provider === 'none' || !typed;
    let encrypted = '';
    if (!clear) {
      if (!encryptionConfigured()) {
        return res.status(500).json({ message: ENCRYPTION_MESSAGE });
      }
      encrypted = encryptApiKey(typed);
    }

    const update = clear
      ? { $set: { aiProvider: provider }, $unset: { aiApiKeyEncrypted: '' } }
      : { $set: { aiProvider: provider, aiApiKeyEncrypted: encrypted } };
    await User.updateOne({ _id: userId }, update);

    return res.json({
      aiProvider: provider,
      hasKey: !clear,
    });
  } catch (err) {
    const message = err && err.message === ENCRYPTION_MESSAGE
      ? ENCRYPTION_MESSAGE
      : 'Server error';
    if (message === 'Server error') console.error('AI settings save failed');
    return res.status(500).json({ message });
  }
});

// GET /api/users/me and GET /api/users/me/ai-credits. Balance plus the membership tier.
async function sendCreditStatus(req, res) {
  try {
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ message: 'No token, authorization denied' });
    const user = await User.findById(userId)
      .select('tier subscriptionStatus subscribedAt plusCurrentPeriodEnd')
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    const [balances, summary] = await Promise.all([
      getCreditBalances(userId),
      accessSummary(userId),
    ]);
    return res.json({
      aiCredits: balances.aiCredits,
      monthlyCredits: balances.monthlyCredits,
      purchasedCredits: balances.purchasedCredits,
      ...summary,
      ...subscriptionStatusFields(user, balances),
    });
  } catch (err) {
    console.error('AI credits read failed');
    return res.status(500).json({ message: 'Server error' });
  }
}

settingsRouter.get('/me', sendCreditStatus);
settingsRouter.get('/me/ai-credits', sendCreditStatus);

function usageListItem(row) {
  const serverSuccess = row.usedUserKey === false && row.success === true;
  return {
    createdAt: isoOrNull(row.createdAt),
    feature: typeof row.feature === 'string' ? row.feature : '',
    creditCost: serverSuccess ? 1 : 0,
    success: row.success === true,
  };
}

// GET /api/users/me/ai-usage. The caller's rows only. Login JWT, not an agent key.
settingsRouter.get('/me/ai-usage', async (req, res) => {
  try {
    if (!requireLoginJwt(req, res)) return;
    const rows = await AiUsage.find({ userId: callerId(req) })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('createdAt feature usedUserKey success')
      .lean();
    return res.json(rows.map(usageListItem));
  } catch (err) {
    console.error('AI usage list failed');
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/users/me/ai-credits/checkout. Any logged-in user. Returns a Stripe URL.
settingsRouter.post('/me/ai-credits/checkout', async (req, res) => {
  try {
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ message: 'No token, authorization denied' });
    const user = await User.findById(userId).select('_id').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    const result = await createCreditCheckout({ userId, pack: body.pack });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('AI credit checkout failed');
    return res.status(500).json({ message: 'Server error' });
  }
});

// Creating, listing, and revoking keys requires the login JWT.
// An agent key must not be able to mint another key.
function requireLoginJwt(req, res) {
  if (req.authType !== 'jwt' || !callerId(req)) {
    res.status(401).json({ message: 'Token is not valid' });
    return false;
  }
  return true;
}

function keyName(body) {
  if (!body || typeof body.name !== 'string') return '';
  return body.name.trim();
}

function publicKey(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    prefix: doc.prefix,
    createdAt: doc.createdAt,
    lastUsedAt: doc.lastUsedAt || null,
  };
}

// POST /api/users/me/api-keys. The raw key is returned only from this response.
settingsRouter.post('/me/api-keys', async (req, res) => {
  try {
    if (!requireLoginJwt(req, res)) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : null;
    const name = keyName(body);
    if (!name) return res.status(400).json({ message: 'Name is required' });
    if (name.length > NAME_LIMIT) {
      return res.status(400).json({ message: 'Name must be 80 characters or less' });
    }
    const minted = generateApiKey();
    const doc = await ApiKey.create({
      userId: callerId(req),
      name,
      keyHash: minted.keyHash,
      prefix: minted.prefix,
    });
    return res.status(201).json({
      id: String(doc._id),
      name: doc.name,
      key: minted.key,
      prefix: doc.prefix,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    console.error('API key create failed');
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users/me/api-keys. Active keys only. Never the raw secret or its hash.
settingsRouter.get('/me/api-keys', async (req, res) => {
  try {
    if (!requireLoginJwt(req, res)) return;
    const rows = await ApiKey.find({ userId: callerId(req), revokedAt: null })
      .sort({ createdAt: -1 })
      .select('name prefix createdAt lastUsedAt')
      .lean();
    return res.json(rows.map((row) => publicKey(row)));
  } catch (err) {
    console.error('API key list failed');
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/users/me/api-keys/:id. Revokes the caller's active key.
settingsRouter.delete('/me/api-keys/:id', async (req, res) => {
  try {
    if (!requireLoginJwt(req, res)) return;
    const id = String(req.params.id || '');
    const updated = await ApiKey.findOneAndUpdate(
      { _id: id, userId: callerId(req), revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { new: true },
    ).select('name prefix revokedAt').lean();
    if (!updated) return res.status(404).json({ message: 'API key not found' });
    return res.json({ id: String(updated._id), revokedAt: updated.revokedAt });
  } catch (err) {
    console.error('API key revoke failed');
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/users/:userId/delete (Admin-only: Deletes user and cascades)
router.post('/:userId/delete', adminCheck, async (req, res) => {
  const { userId } = req.params;

  try {
    // Self-deletion or admin (adjust as needed)
    if (userId !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ msg: 'Admin access required for deleting others' });
    }

    // Cascade: Remove from trip_users (all trips)
    const userRoles = await TripUser.find({ userId }).populate('tripId', 'name ownerId');
    await TripUser.deleteMany({ userId });

    // Remove pending invitations
    await Invitation.deleteMany({ userId });

    // Handle Coordinator trips
    for (const role of userRoles) {
      if (role.role === 'VibeCoordinator') {
        const trip = role.tripId;
        // Find another VibePlanner to transfer to
        const newCoordinator = await TripUser.findOne({ tripId: trip._id, role: 'VibePlanner' }).populate('userId', 'firstName lastName');
        if (newCoordinator) {
          // Transfer: Update ownerId and swap roles
          trip.ownerId = newCoordinator.userId._id;
          await trip.save();

          newCoordinator.role = 'VibeCoordinator';
          await newCoordinator.save();

          // Notify
          const participants = await TripUser.find({ tripId: trip._id }).select('userId');
          const participantIds = participants.map(tu => tu.userId._id);
          await notifyUsers(participantIds, `Ownership transferred to ${newCoordinator.userId.firstName} ${newCoordinator.userId.lastName} due to user deletion.`, 'email');
        } else {
          // No Planners—delete trip
          await Trip.findByIdAndDelete(trip._id);
          // Notify (if any left, but none)
        }
      }
    }

    // Delete user
    await User.findByIdAndDelete(userId);

    res.json({ msg: 'User deleted successfully—trips transferred or deleted' });
  } catch (err) {
    console.error('User deletion error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;
module.exports.settingsRouter = settingsRouter;