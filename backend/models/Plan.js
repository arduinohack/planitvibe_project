const mongoose = require('mongoose');
const Schema = mongoose.Schema;  // Added: Extract Schema for types like ObjectId
const { v4: uuidv4 } = require('uuid');

const planSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  type: { type: String, enum: ['trip', 'plan'], required: true },  // NEW: Unified type
  name: { type: String, required: true },
  destination: { type: String, required: function() { return this.type === 'trip'; } },  // Conditional
  startDate: { type: Date, required: false },
  endDate: { type: Date, required: false },
  autoCalculateStartDate: { type: Boolean, default: false },  // NEW: Opt-in for auto from earliest event
  autoCalculateEndDate: { type: Boolean, default: false },  // NEW: Opt-in for auto from latest event
  location: { type: String, required: function() { return this.type === 'plan'; } },  // Venue for events
  budget: { type: Number, default: 0 },
  hiddenFields: { type: [String], default: [] },
  planningState: { type: String, enum: ['initial', 'reviewing', 'complete'], default: 'initial' },
  timeZone: { type: String, required: false },
  ownerId: { type: String, ref: 'User', required: true },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  archiveDescription: { type: String, default: '' },
  archivedAt: { type: Date, required: false },
  archivedBy: { type: String, required: false },
  sourcePlanId: { type: String, default: '' },
  basedOnTemplateId: { type: String, default: '' },
  basedOnTitle: { type: String, default: '' },
  basedOnCreator: { type: String, default: '' },
  linkedActivityIds: { type: [String], default: [] },
  linkStart: { type: Date, required: false },
  linkEnd: { type: Date, required: false },
  participants: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['VibePlanner', 'Wanderer'], required: true }
  }],
  activityIds: [{ type: String, ref: 'Event' }]  // NEW: For eventPlan activities
}, { timestamps: true });

planSchema.index({ name: 'text', destination: 'text' });
planSchema.index({ ownerId: 1 });

module.exports = mongoose.model('Plan', planSchema);