const TIER_TRIAL = 'trial';
const TIER_PLANITVIBE = 'planitvibe';
const TIER_PLUS = 'plus';
const TIER_PRO = 'pro';

const TIER_NAME = {
  trial: 'PlanItVibe (Trial)',
  planitvibe: 'PlanItVibe',
  plus: 'PlanItVibe Plus',
  pro: 'PlanItVibe Pro',
};

const TIER_CAP = {
  trial: 2,
  planitvibe: 4,
  plus: 10,
  pro: 30,
};

const TIER_CREDITS = {
  planitvibe: 16,
  plus: 20,
  pro: 50,
};

const TIER_RANK = {
  trial: 0,
  planitvibe: 1,
  plus: 2,
  pro: 3,
};

const NEXT_TIER = {
  trial: 'planitvibe',
  planitvibe: 'plus',
  plus: 'pro',
};

const UPGRADE_MESSAGE = 'Upgrade to own more plans.';

function normalizeTier(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return Object.prototype.hasOwnProperty.call(TIER_NAME, text) ? text : '';
}

function resolveTier(user) {
  const stored = normalizeTier(user && user.tier);
  if (stored === TIER_PLANITVIBE || stored === TIER_PLUS || stored === TIER_PRO) return stored;
  if (user && user.plusActive === true) return TIER_PLUS;
  return TIER_TRIAL;
}

function tierName(tier) {
  return TIER_NAME[tier] || TIER_NAME.trial;
}

function planCapFor(tier) {
  return TIER_CAP[tier] || TIER_CAP.trial;
}

function tierCredits(tier) {
  return TIER_CREDITS[tier] || 0;
}

function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

function nextTier(tier) {
  return NEXT_TIER[tier] || null;
}

function tierForPack(pack) {
  const text = typeof pack === 'string' ? pack.trim() : '';
  if (text === 'planitvibe') return TIER_PLANITVIBE;
  if (text === 'plus') return TIER_PLUS;
  if (text === 'pro') return TIER_PRO;
  return '';
}

function upgradeBody(tier) {
  const next = nextTier(tier);
  const body = { message: UPGRADE_MESSAGE };
  if (!next) return body;
  body.nextTier = next;
  body.nextTierName = tierName(next);
  return body;
}

module.exports = {
  TIER_TRIAL,
  TIER_PLANITVIBE,
  TIER_PLUS,
  TIER_PRO,
  UPGRADE_MESSAGE,
  normalizeTier,
  resolveTier,
  tierName,
  planCapFor,
  tierCredits,
  tierRank,
  nextTier,
  tierForPack,
  upgradeBody,
};
