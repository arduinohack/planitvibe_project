const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Event } = require('../models/Event');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const Attachment = require('../models/Attachment');
const authMiddleware = require('../middleware/auth');
const { canonicalMembershipRole } = require('../middleware/roleCheck');
const {
  MAX_BYTES,
  MAX_PER_ACTIVITY,
  sniffedMime,
  safeFilename,
  storageKeyFor,
  absolutePath,
  saveBuffer,
  removeStored,
  contentDisposition,
} = require('../utils/attachmentStore');
const { prepareAttachment, prepareEdit } = require('../utils/planAccess');
const { archivedMemberResult } = require('../utils/planArchive');
const fs = require('fs');

const activityAttachmentRouter = express.Router();
const attachmentRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

function readUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve(req.file);
    });
  });
}

function uploadErrorMessage(err) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return 'File must be 10 MB or smaller';
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') return 'Only one file can be attached';
  return 'File is required';
}

async function membershipRole(planId, callerId) {
  const membership = await PlanUser.findOne({ planId, userId: callerId });
  let role = canonicalMembershipRole(membership && membership.role);
  if (!role) {
    const plan = await Plan.findById(planId).select('ownerId');
    if (plan && String(plan.ownerId) === String(callerId)) role = 'Owner';
  }
  return role;
}

function callerIdOf(req) {
  return String((req.user && (req.user.userId || req.user.id)) || '');
}

async function sendIfArchived(res, planId, callerId) {
  const block = await archivedMemberResult(planId, callerId);
  if (!block) return false;
  res.status(block.status).json(block.body);
  return true;
}

function publicAttachment(doc) {
  return {
    id: String(doc._id),
    activityId: doc.activityId,
    planId: doc.planId,
    uploadedBy: doc.uploadedBy,
    filename: doc.filename,
    mimeType: doc.mimeType,
    size: doc.size,
    createdAt: doc.createdAt,
  };
}

async function loadActivity(activityId) {
  const id = String(activityId || '').trim();
  if (!id) return null;
  return Event.findById(id).select('planId').lean();
}

// POST /api/activities/:id/attachments
// Owner or Collaborator. multipart field name is file.
activityAttachmentRouter.post('/:id/attachments', authMiddleware, async (req, res) => {
  let storedKey = '';
  try {
    const activity = await loadActivity(req.params.id);
    if (!activity) return res.status(404).json({ message: 'Activity not found' });
    const callerId = callerIdOf(req);
    if (await sendIfArchived(res, activity.planId, callerId)) return;
    const role = await membershipRole(activity.planId, callerId);
    if (role !== 'Owner' && role !== 'Collaborator') {
      return res.status(403).json({
        message: 'Only Owner or Collaborator can add attachments',
      });
    }
    const gate = await prepareAttachment(callerId, activity.planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }

    let file;
    try {
      file = await readUpload(req, res);
    } catch (err) {
      if (res.headersSent) return;
      return res.status(400).json({ message: uploadErrorMessage(err) });
    }
    if (res.headersSent) return;
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length < 1) {
      return res.status(400).json({ message: 'File is required' });
    }

    const mimeType = sniffedMime(file.buffer);
    if (!mimeType) {
      return res.status(400).json({ message: 'Only images and PDF files can be attached' });
    }
    if (file.buffer.length > MAX_BYTES) {
      return res.status(400).json({ message: 'File must be 10 MB or smaller' });
    }

    const activityId = String(activity._id);
    const existing = await Attachment.countDocuments({ activityId });
    if (existing >= MAX_PER_ACTIVITY) {
      return res.status(400).json({ message: 'An activity can have at most 5 attachments' });
    }

    const id = uuidv4();
    const storageKey = storageKeyFor(id);
    storedKey = storageKey;
    await saveBuffer(storageKey, file.buffer);
    const doc = await Attachment.create({
      _id: id,
      activityId,
      planId: String(activity.planId),
      uploadedBy: callerId,
      filename: safeFilename(file.originalname, mimeType),
      mimeType,
      size: file.buffer.length,
      storageKey,
    });

    const kept = await Attachment.find({ activityId })
      .sort({ createdAt: 1, _id: 1 })
      .select('_id')
      .lean();
    if (kept.length > MAX_PER_ACTIVITY && !kept.slice(0, MAX_PER_ACTIVITY).some((row) => row._id === id)) {
      await Attachment.deleteOne({ _id: id });
      await removeStored(storageKey);
      storedKey = '';
      return res.status(400).json({ message: 'An activity can have at most 5 attachments' });
    }

    storedKey = '';
    return res.status(201).json(publicAttachment(doc));
  } catch (err) {
    if (storedKey) {
      try { await removeStored(storedKey); } catch (_) { /* leave the request error */ }
    }
    const message = err && err.message ? err.message : 'request failed';
    console.error('Attachment upload failed:', message);
    if (res.headersSent) return;
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/activities/:id/attachments
// Any plan member.
activityAttachmentRouter.get('/:id/attachments', authMiddleware, async (req, res) => {
  try {
    const activity = await loadActivity(req.params.id);
    if (!activity) return res.status(404).json({ message: 'Activity not found' });
    const callerId = callerIdOf(req);
    if (await sendIfArchived(res, activity.planId, callerId)) return;
    const role = await membershipRole(activity.planId, callerId);
    if (role !== 'Owner' && role !== 'Collaborator' && role !== 'Guest') {
      return res.status(403).json({ message: 'Only plan members can view attachments' });
    }
    const rows = await Attachment.find({ activityId: String(activity._id) })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    return res.json(rows.map(publicAttachment));
  } catch (err) {
    const message = err && err.message ? err.message : 'request failed';
    console.error('Attachment list failed:', message);
    return res.status(500).json({ message: 'Server error' });
  }
});

async function loadAttachment(id) {
  const text = String(id || '').trim();
  if (!text) return null;
  return Attachment.findById(text).select('+storageKey').lean();
}

// GET /api/attachments/:id/file
// Any plan member. Streams the stored file.
attachmentRouter.get('/:id/file', authMiddleware, async (req, res) => {
  try {
    const attachment = await loadAttachment(req.params.id);
    if (!attachment) return res.status(404).json({ message: 'Attachment not found' });
    const callerId = callerIdOf(req);
    if (await sendIfArchived(res, attachment.planId, callerId)) return;
    const role = await membershipRole(attachment.planId, callerId);
    if (role !== 'Owner' && role !== 'Collaborator' && role !== 'Guest') {
      return res.status(403).json({ message: 'Only plan members can view attachments' });
    }
    const full = absolutePath(attachment.storageKey);
    if (!full) return res.status(404).json({ message: 'File not found' });
    let stat;
    try {
      stat = await fs.promises.stat(full);
    } catch (_) {
      return res.status(404).json({ message: 'File not found' });
    }
    if (!stat.isFile()) return res.status(404).json({ message: 'File not found' });
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', contentDisposition(attachment.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = fs.createReadStream(full);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ message: 'File not found' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    const message = err && err.message ? err.message : 'request failed';
    console.error('Attachment download failed:', message);
    if (res.headersSent) return;
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/attachments/:id
// The uploader or the plan Owner.
attachmentRouter.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const attachment = await loadAttachment(req.params.id);
    if (!attachment) return res.status(404).json({ message: 'Attachment not found' });
    const callerId = callerIdOf(req);
    if (await sendIfArchived(res, attachment.planId, callerId)) return;
    const role = await membershipRole(attachment.planId, callerId);
    const uploader = String(attachment.uploadedBy) === callerId;
    if (role !== 'Owner' && !uploader) {
      return res.status(403).json({
        message: 'Only the uploader or the Owner can delete an attachment',
      });
    }
    const gate = await prepareEdit(callerId, attachment.planId);
    if (gate.status !== 200) {
      return res.status(gate.status).json({ message: gate.message });
    }
    await Attachment.deleteOne({ _id: attachment._id });
    try {
      await removeStored(attachment.storageKey);
    } catch (err) {
      const message = err && err.message ? err.message : 'request failed';
      console.error('Attachment file delete failed:', message);
    }
    return res.json({ id: String(attachment._id), deleted: true });
  } catch (err) {
    const message = err && err.message ? err.message : 'request failed';
    console.error('Attachment delete failed:', message);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = { activityAttachmentRouter, attachmentRouter };
