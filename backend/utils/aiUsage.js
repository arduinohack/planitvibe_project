const AiUsage = require('../models/AiUsage');

const FEATURES = new Set(['paste', 'suggest', 'command', 'placeSearch']);
const PROVIDERS = new Set(['xai', 'openai', 'anthropic', 'gemini', 'server', 'google']);
const USER_PROVIDERS = new Set(['xai', 'openai', 'anthropic', 'gemini']);

function tokenCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function firstCount(usage, names) {
  if (!usage || typeof usage !== 'object') return null;
  for (const name of names) {
    if (usage[name] != null) return tokenCount(usage[name]);
  }
  return null;
}

function readModelUsage(data, fallbackModel) {
  const usage = data && typeof data === 'object' ? data.usage : null;
  const reported = data && typeof data.model === 'string' ? data.model.trim() : '';
  const fallback = typeof fallbackModel === 'string' ? fallbackModel.trim() : '';
  return {
    model: reported || fallback || undefined,
    inputTokens: firstCount(usage, ['input_tokens', 'prompt_tokens', 'inputTokens']),
    outputTokens: firstCount(usage, ['output_tokens', 'completion_tokens', 'outputTokens']),
    totalTokens: firstCount(usage, ['total_tokens', 'totalTokens']),
  };
}

function usageIdentity(aiClient) {
  if (aiClient && aiClient.source === 'user' && USER_PROVIDERS.has(aiClient.provider)) {
    return { provider: aiClient.provider, usedUserKey: true };
  }
  return { provider: 'server', usedUserKey: false };
}

function clipError(value, secret) {
  let text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) text = 'request failed';
  if (typeof secret === 'string' && secret && text.includes(secret)) {
    text = text.split(secret).join('[redacted]');
  }
  if (text.length > 200) text = text.slice(0, 200);
  return text;
}

// Insert never throws. Paste, suggest, command, and place search ignore a logging failure.
async function recordAiUsage(entry) {
  try {
    if (!entry || typeof entry !== 'object') return;
    const userId = typeof entry.userId === 'string' ? entry.userId.trim() : '';
    const feature = entry.feature;
    const provider = entry.provider;
    if (!userId || !FEATURES.has(feature) || !PROVIDERS.has(provider)) return;
    const measured = {
      inputTokens: tokenCount(entry.inputTokens),
      outputTokens: tokenCount(entry.outputTokens),
      totalTokens: tokenCount(entry.totalTokens),
    };
    const doc = {
      userId,
      feature,
      provider,
      usedUserKey: Boolean(entry.usedUserKey),
      success: Boolean(entry.success),
      inputTokens: measured.inputTokens,
      outputTokens: measured.outputTokens,
      totalTokens: measured.totalTokens,
    };
    const planId = typeof entry.planId === 'string' ? entry.planId.trim() : '';
    if (planId) doc.planId = planId;
    if (typeof entry.model === 'string' && entry.model.trim()) doc.model = entry.model.trim();
    if (typeof entry.credits === 'number' && Number.isFinite(entry.credits) && entry.credits > 0) {
      doc.credits = entry.credits;
    }
    if (!entry.success) doc.error = clipError(entry.error);
    await AiUsage.create(doc);
  } catch (_) {
    // The original paste or suggest response stays as it was.
  }
}

async function logModelAttempt(usage, outcome) {
  try {
    if (!usage || typeof usage.userId !== 'string' || !usage.userId.trim()) return;
    const outcomeSafe = outcome && typeof outcome === 'object' ? outcome : {};
    const identity = usageIdentity(outcomeSafe.aiClient);
    const measured = readModelUsage(outcomeSafe.data, outcomeSafe.fallbackModel);
    await recordAiUsage({
      userId: usage.userId,
      planId: usage.planId,
      feature: usage.feature,
      provider: identity.provider,
      usedUserKey: identity.usedUserKey,
      model: measured.model,
      inputTokens: measured.inputTokens,
      outputTokens: measured.outputTokens,
      totalTokens: measured.totalTokens,
      success: Boolean(outcomeSafe.success),
      error: outcomeSafe.success ? undefined : clipError(outcomeSafe.error, outcomeSafe.secret),
    });
  } catch (_) {
    // The original paste or suggest response stays as it was.
  }
}

module.exports = {
  recordAiUsage,
  logModelAttempt,
  readModelUsage,
};
