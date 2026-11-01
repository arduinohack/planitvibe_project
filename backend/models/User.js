const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');  // Generate UUID
const bcrypt = require('bcryptjs');

// Sub-schema for address (nested object)
const addressSchema = new mongoose.Schema({
  street: String,
  city: String,
  state: String,
  country: String,
  postalCode: String
});

// Sub-schema for notificationPreferences (nested object with defaults)
const notificationPreferencesSchema = new mongoose.Schema({
  email: { type: Boolean, default: true },
  sms: { type: Boolean, default: false }
});

// Main User schema
const userSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },  // UUID as string (custom ID)
  firstName: String,
  lastName: String,
  email: { type: String, unique: true },
  phoneNumber: String,
  address: addressSchema,  // Embed sub-schema
  notificationPreferences: notificationPreferencesSchema,  // Embed sub-schema
  role: { type: String, enum: ['member', 'admin'], default: 'member' },
  password: { type: String, required: true },  // For login (hashed)
  resetToken: String,  // Temporary token for reset
  resetTokenExpiry: Date,  // Expires in 1h
  // No schema default. A default of false is applied when an old document is
  // loaded, and a later save would lock that account. Missing means verified.
  // Register sets false for a new account.
  emailVerified: { type: Boolean },
  emailVerifyToken: { type: String, select: false },
  emailVerifyExpires: { type: Date, select: false },
  // Per-user AI settings. The key is ciphertext only and is excluded from queries.
  aiProvider: {
    type: String,
    enum: ['xai', 'openai', 'anthropic', 'gemini', 'none'],
    default: 'none',
  },
  aiApiKeyEncrypted: { type: String, select: false },
  aiCredits: { type: Number, default: 0, min: 0 },
  plusActive: { type: Boolean, default: false },
  tier: {
    type: String,
    enum: ['trial', 'planitvibe', 'plus', 'pro'],
    default: 'trial',
  },
  trialStartedAt: { type: Date },
  trialEndsAt: { type: Date },
  plusPriceId: { type: String },
  plusCurrentPeriodEnd: { type: Date },
  // Start of the current paid subscription. A renewal of that same subscription
  // does not move it. Null until the first paid checkout.
  subscribedAt: { type: Date },
  // Set when that subscription is deleted, canceled, or unpaid. Cleared when
  // a paid tier is active again.
  expiredAt: { type: Date },
  stripeCustomerId: { type: String },
  stripeSubscriptionId: { type: String },
  createdAt: { type: Date, default: Date.now }
});

function hideStoredAiKey(_doc, ret) {
  if (ret) {
    delete ret.aiApiKeyEncrypted;
    delete ret.emailVerifyToken;
    delete ret.emailVerifyExpires;
  }
  return ret;
}

userSchema.set('toJSON', { transform: hideStoredAiKey });
userSchema.set('toObject', { transform: hideStoredAiKey });

// Pre-save hook for password hashing
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);