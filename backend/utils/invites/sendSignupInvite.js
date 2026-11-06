const { sendEmail, selectedFrom, planItVibeFrom } = require('../email/sendEmail');

const SUBJECT = "You're invited to try PlanItVibe";
const DEFAULT_SIGNUP_URL = 'https://planitvibe.com/signup';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function signupInviteFrom() {
  const accounts = process.env.EMAIL_ACCOUNTS;
  if (typeof accounts === 'string' && accounts.trim() !== '') return planItVibeFrom(accounts);
  return selectedFrom();
}

function signupUrlFor(email) {
  const configured = typeof process.env.SIGNUP_URL === 'string' ? process.env.SIGNUP_URL.trim() : '';
  const base = configured || DEFAULT_SIGNUP_URL;
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}email=${encodeURIComponent(email)}`;
}

// Sends one signup invitation. A mail error returns success false and does not throw.
async function sendSignupInvite({ email, signupUrl, from } = {}) {
  const to = typeof email === 'string' ? email.trim() : '';
  if (!to) return { success: false, error: 'Email is required' };

  const link = typeof signupUrl === 'string' && signupUrl.trim() !== ''
    ? signupUrl.trim()
    : signupUrlFor(to);
  const fromHeader = typeof from === 'string' && from.trim() !== ''
    ? from.trim()
    : signupInviteFrom();
  const text = `You're invited to try PlanItVibe.\n\nCreate your account: ${link}`;
  const html = `<p>You're invited to try PlanItVibe.</p><p><a href="${escapeHtml(link)}">Create your account</a></p>`;

  try {
    await sendEmail({
      to,
      from: fromHeader,
      subject: SUBJECT,
      text,
      html,
    });
    return { success: true };
  } catch (err) {
    const error = err && err.message ? err.message : 'Invitation email failed';
    return { success: false, error };
  }
}

module.exports = {
  sendSignupInvite,
  signupInviteFrom,
  signupUrlFor,
};
