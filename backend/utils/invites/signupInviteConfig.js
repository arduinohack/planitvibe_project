const SignupInviteConfig = require('../../models/SignupInviteConfig');

const CONFIG_ID = 'signup-invite';

function envSignupInviteMode() {
  const env = typeof process.env.SIGNUP_INVITE_MODE === 'string'
    ? process.env.SIGNUP_INVITE_MODE.trim().toLowerCase()
    : '';
  if (env === 'automatic') return 'automatic';
  return 'manual';
}

async function signupInviteMode() {
  const doc = await SignupInviteConfig.findById(CONFIG_ID).select('mode').lean();
  if (doc && (doc.mode === 'automatic' || doc.mode === 'manual')) return doc.mode;
  return envSignupInviteMode();
}

async function setSignupInviteMode(mode) {
  await SignupInviteConfig.updateOne(
    { _id: CONFIG_ID },
    { $set: { mode, updatedAt: new Date() } },
    { upsert: true },
  );
  return mode;
}

module.exports = { signupInviteMode, setSignupInviteMode };
