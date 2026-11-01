const TemplateReport = require('../models/TemplateReport');
const PublishedTemplate = require('../models/PublishedTemplate');
const SupportLog = require('../models/SupportLog');
const { sendEmail } = require('./email/sendEmail');
const { logSupport } = require('./logSupport');

const REPORT_INBOX = 'ken@eratespecialists.com';
const PUBLIC_ORIGIN = 'https://planitvibe.com';
const DIGEST_EVENT = 'TemplateReportDigest';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function templateLink(templateId) {
  return `${PUBLIC_ORIGIN}/template.html?id=${encodeURIComponent(String(templateId))}`;
}

function reporterLabel(user) {
  if (!user) return 'Not signed in';
  const name = [user.firstName, user.lastName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  if (name && email) return `${name} <${email}>`;
  return email || name || 'Not signed in';
}

function reportText({ templateId, reason, reporter }) {
  const link = templateLink(templateId);
  return [
    'PlanItVibe template report',
    `Template: ${link}`,
    `Reason: ${reason}`,
    `Reporter: ${reporter}`,
    `Unpublish: POST /api/admin/published-templates/${templateId}/unpublish`,
    'A daily check repeats any report whose template is still public.',
  ].join('\n');
}

async function notifyTemplateReport({ templateId, reason, reporter }) {
  const text = reportText({ templateId, reason, reporter });
  await sendEmail({
    to: REPORT_INBOX,
    subject: 'PlanItVibe template report',
    text,
    html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
  });
}

function dayKey(now) {
  return now.toISOString().slice(0, 10);
}

async function openReportsSince(since) {
  const reports = await TemplateReport.find({ createdAt: { $gte: since } })
    .sort({ createdAt: 1 })
    .lean();
  const open = [];
  for (const report of reports) {
    const doc = await PublishedTemplate.findOne({
      _id: report.templateId,
      published: true,
    }).select('_id title').lean();
    if (!doc) continue;
    open.push({ report, title: doc.title || 'Template' });
  }
  return open;
}

async function sendOpenReportDigest(now = new Date()) {
  const day = dayKey(now);
  const already = await SupportLog.findOne({ event: DIGEST_EVENT, message: day }).select('_id').lean();
  if (already) return { sent: false, day };
  const open = await openReportsSince(new Date(now.getTime() - (24 * 60 * 60 * 1000)));
  if (!open.length) {
    await logSupport({
      level: 'info',
      event: DIGEST_EVENT,
      message: day,
      extra: { open: 0 },
    });
    return { sent: false, day, open: 0 };
  }
  const blocks = open.map(({ report, title }) => reportText({
    templateId: report.templateId,
    reason: report.reason,
    reporter: report.reporter || 'Not signed in',
  }).replace('PlanItVibe template report', title));
  const text = `PlanItVibe template report check for ${day}\n\n${blocks.join('\n\n')}`;
  await sendEmail({
    to: REPORT_INBOX,
    subject: 'PlanItVibe template report check',
    text,
    html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
  });
  await logSupport({
    level: 'info',
    event: DIGEST_EVENT,
    message: day,
    extra: { open: open.length },
  });
  return { sent: true, day, open: open.length };
}

function startTemplateReportDigest() {
  const run = () => {
    sendOpenReportDigest().catch((err) => {
      console.error('Template report digest failed:', err && err.message ? err.message : err);
    });
  };
  const first = setTimeout(run, 30 * 1000);
  const later = setInterval(run, 60 * 60 * 1000);
  if (typeof first.unref === 'function') first.unref();
  if (typeof later.unref === 'function') later.unref();
}

module.exports = {
  REPORT_INBOX,
  reporterLabel,
  templateLink,
  notifyTemplateReport,
  sendOpenReportDigest,
  startTemplateReportDigest,
};
