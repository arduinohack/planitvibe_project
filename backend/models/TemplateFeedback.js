const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const templateFeedbackSchema = new mongoose.Schema({
  _id: { type: String, default: () => uuidv4() },
  templateId: { type: String, required: true },
  userId: { type: String, required: true },
  rating: { type: Number, required: true },
  comment: { type: String, default: '' },
}, {
  timestamps: true,
  collection: 'templateFeedback',
});

templateFeedbackSchema.index({ templateId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.models.TemplateFeedback
  || mongoose.model('TemplateFeedback', templateFeedbackSchema);
