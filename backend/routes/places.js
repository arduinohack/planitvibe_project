const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const { canonicalMembershipRole } = require('../middleware/roleCheck');
const { getAiClient } = require('../utils/aiProvider');
const { INSUFFICIENT_MESSAGE } = require('../utils/aiCredits');
const { searchPlaces } = require('../utils/placeAutocomplete');

async function callerMaySearchPlaces(callerId) {
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

// GET /api/places/autocomplete?q=
// Owner or Collaborator. Text Search Pro while credits remain, IDs Only at zero.
// Does not write a plan or an activity.
router.get('/autocomplete', authMiddleware, async (req, res) => {
  try {
    const callerId = req.user.userId || req.user.id;
    const allowed = await callerMaySearchPlaces(callerId);
    if (!allowed) {
      return res.status(403).json({
        message: 'Only Owner or Collaborator can search places',
      });
    }
    const raw = req.query && req.query.q;
    const query = Array.isArray(raw) ? raw[0] : raw;
    const aiClient = await getAiClient(req.user);
    const result = await searchPlaces(query, { userId: callerId, aiClient });
    if (result.status !== 200) {
      return res.status(result.status).json({ message: result.msg });
    }
    if (result.idOnly) {
      return res.json({
        places: result.places,
        message: INSUFFICIENT_MESSAGE,
      });
    }
    return res.json(result.places);
  } catch (err) {
    console.error('Place autocomplete error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
