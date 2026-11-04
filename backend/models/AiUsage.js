const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const aiUsageSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  userId: { type: String, required: true },
  planId: { type: String },
  feature: { type: String, enum: ['paste', 'suggest', 'command', 'placeSearch'], required: true },
  provider: {
    type: String,
    enum: ['xai', 'openai', 'anthropic', 'gemini', 'server', 'google'],
    required: true,
  },
  credits: { type: Number },
  usedUserKey: { type: Boolean, required: true },
  model: { type: String },
  inputTokens: { type: Number, default: null },
  outputTokens: { type: Number, default: null },
  totalTokens: { type: Number, default: null },
  success: { type: Boolean, required: true },
  error: { type: String },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'aiusages',
  versionKey: false,
});

aiUsageSchema.index({ userId: 1, createdAt: -1 });
aiUsageSchema.index({ feature: 1, createdAt: -1 });

module.exports = mongoose.models.AiUsage || mongoose.model('AiUsage', aiUsageSchema);
