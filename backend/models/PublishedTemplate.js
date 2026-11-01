const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const publishedTemplateSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  ownerId: { type: String, required: true },
  creatorName: { type: String, default: '' },
  sourcePlanId: { type: String, required: true },
  published: { type: Boolean, default: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  city: { type: String, default: '' },
  tripLength: { type: Number, required: true },
  vibe: { type: String, default: '' },
  coverImage: { type: String, default: '' },
  type: { type: String, enum: ['trip', 'plan'], required: true },
  timeZone: { type: String, default: '' },
  startDate: { type: Date, required: false },
  endDate: { type: Date, required: false },
  activities: { type: mongoose.Schema.Types.Mixed, default: [] },
  copyCount: { type: Number, default: 0 },
  viewCount: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
  feedbackCount: { type: Number, default: 0 },
}, {
  timestamps: true,
  collection: 'publishedTemplates',
});

publishedTemplateSchema.index({ ownerId: 1, sourcePlanId: 1 }, { unique: true });
publishedTemplateSchema.index({ published: 1, copyCount: -1, createdAt: -1 });

module.exports = mongoose.models.PublishedTemplate
  || mongoose.model('PublishedTemplate', publishedTemplateSchema);
