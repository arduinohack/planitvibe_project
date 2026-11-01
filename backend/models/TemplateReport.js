const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const templateReportSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  templateId: { type: String, required: true },
  reason: { type: String, required: true },
  reporter: { type: String, default: 'Not signed in' },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'templateReports',
});

templateReportSchema.index({ templateId: 1, createdAt: -1 });

module.exports = mongoose.models.TemplateReport
  || mongoose.model('TemplateReport', templateReportSchema);
