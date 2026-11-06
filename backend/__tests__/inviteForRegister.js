const { v4: uuidv4 } = require('uuid');
const Invitation = require('../models/Invitation');
const AllowedEmail = require('../models/AllowedEmail');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Puts the address on the allow list. Safe to call again for the same address.
async function allowEmail(email) {
  const normalized = normalizeEmail(email);
  await AllowedEmail.updateOne(
    { email: normalized },
    { $setOnInsert: { email: normalized } },
    { upsert: true },
  );
}

// Lets a test register. The invite row is removed after register so later counts stay unchanged.
async function allowRegister(email) {
  await allowEmail(email);
  await Invitation.create({
    _id: uuidv4(),
    planId: 'register-invite',
    email: normalizeEmail(email),
    invitedBy: 'register-seed',
    role: 'Guest',
    status: 'pending',
  });
}

async function clearRegisterInvite(email) {
  await Invitation.deleteMany({
    planId: 'register-invite',
    email: normalizeEmail(email),
  });
}

module.exports = { allowRegister, allowEmail, clearRegisterInvite };
