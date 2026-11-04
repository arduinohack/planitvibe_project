const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const { canonicalMembershipRole } = require('../middleware/roleCheck');
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
// Owner or Collaborator. Text Search Pro for Search places.
// Returns googlePlaceId, name, address, and timeZone. Does not write a plan.
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
    const result = await searchPlaces(query);
    if (result.status !== 200) {
      return res.status(result.status).json({ message: result.msg });
    }
    return res.json(result.places);
  } catch (err) {
    console.error('Place autocomplete error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
