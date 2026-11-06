const mongoose = require('mongoose');

const allowedEmailSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  note: { type: String, trim: true, default: '' },
  createdAt: { type: Date, default: Date.now },
  invitedAt: { type: Date, default: null },
});

module.exports = mongoose.model('AllowedEmail', allowedEmailSchema);
