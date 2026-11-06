const mongoose = require('mongoose');

// One document. An admin save overrides SIGNUP_INVITE_MODE until it is changed again.
const signupInviteConfigSchema = new mongoose.Schema({
  _id: { type: String, default: 'signup-invite' },
  mode: { type: String, enum: ['automatic', 'manual'], required: true },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('SignupInviteConfig', signupInviteConfigSchema);
