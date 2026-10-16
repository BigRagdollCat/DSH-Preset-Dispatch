// Bounded decision metadata and observed usage only; neither helper selects a route or grants authority.
export const SELECTION_REASON_LIMIT = 160;
export const SELECTION_LEVELS = ['low', 'medium', 'high'];
export function parseSelection(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['difficulty', 'reason'].includes(key))
    || !SELECTION_LEVELS.includes(value.difficulty)
    || typeof value.reason !== 'string' || !value.reason.trim()
    || [...value.reason].length > SELECTION_REASON_LIMIT) {
    throw new Error('preset-dispatch: selection requires difficulty low/medium/high and a non-empty reason of at most 160 characters; no extra fields');
  }
  return { difficulty: value.difficulty, reason: value.reason.trim() };
}
export const validSelection = value => {
  try { return value === null || (value !== undefined && parseSelection(value) !== null); } catch { return false; }
};

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0;
/**
 * Sum usage explicitly attached to committed assistant/message events from Session.ownEvents().
 * Dedupe by committed sequence. Attempts without a committed message are counted as unmetered,
 * not estimated from their text/stream. Missing optional counters stay null, never zero-filled;
 * totalTokens is not derived by adding counters whose adapter semantics may differ.
 */
export function summarizeTokenUsage(events) {
  const seen = new Set(), sums = Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0]));
  const complete = Object.fromEntries(TOKEN_FIELDS.map(key => [key, true]));
  let reportedMessages = 0, missingMessages = 0, unmeteredAttempts = 0;
  for (const event of events) {
    if (!event || !['assistant/message', 'assistant/attempt'].includes(event.type)) continue;
    if (!count(event.seq)) {
      if (event.type === 'assistant/attempt') unmeteredAttempts++; else missingMessages++;
      continue;
    }
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    if (event.type === 'assistant/attempt') { unmeteredAttempts++; continue; }
    const usage = event.data?.usage;
    if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)) { missingMessages++; continue; }
    reportedMessages++;
    for (const key of TOKEN_FIELDS) {
      if (!count(usage[key]) || !count(sums[key] + usage[key])) complete[key] = false;
      else sums[key] += usage[key];
    }
  }
  return {
    source: 'committed-assistant-messages',
    status: reportedMessages === 0 ? 'unknown' : (missingMessages || unmeteredAttempts || !complete.inputTokens || !complete.outputTokens ? 'partial' : 'reported'),
    reportedMessages, missingMessages, unmeteredAttempts,
    ...Object.fromEntries(TOKEN_FIELDS.map(key => [key, reportedMessages && complete[key] ? sums[key] : null])),
  };
}
export function validTokenUsage(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['source', 'status', 'reportedMessages', 'missingMessages', 'unmeteredAttempts', ...TOKEN_FIELDS];
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
    && value.source === 'committed-assistant-messages' && ['unknown', 'partial', 'reported'].includes(value.status)
    && ['reportedMessages', 'missingMessages', 'unmeteredAttempts'].every(key => count(value[key]))
    && TOKEN_FIELDS.every(key => value[key] === null || count(value[key]));
}
