// One save protocol shared by every write path.
//
// Everything here is pure: it decides whether a request may be planned at all,
// before a single byte is written. It is NOT a transaction. Preset definitions,
// dispatch policies and the Host model pool live in separate stores, so a request
// can still stop half-way and must always report which parts landed.
import { createHash } from 'node:crypto';

/**
 * A save failure that says what kind of problem it is, and which part it belongs
 * to, so the UI can distinguish "you sent something invalid" from "someone else
 * changed this first" without matching on message text.
 */
export class SaveError extends Error {
  constructor(code, message, part) {
    super(message);
    this.name = 'SaveError';
    this.code = code;
    if (part !== undefined) this.part = part;
  }
}

export const fail = (code, message, part) => { throw new SaveError(code, message, part); };
export const errorCode = error => (error instanceof SaveError ? error.code : 'unknown');

/** Fingerprint of a request, used to tell a retry from a different request. */
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A policy row that grants no authority at all (nothing may be dispatched under it). */
export const isInert = row => row.enabled !== true && (row.allowedModels ?? []).length === 0 && !row.defaultModel;

/**
 * A policy row may be written freely only for a preset this plugin owns.
 *
 * Anything else — a native preset, another plugin's preset, or a leftover row whose
 * preset no longer exists — may only be reduced to an inert row. A changed request
 * can therefore never grant dispatch authority the user did not configure here,
 * while the existing "clean up leftovers" and "turn off a legacy row" paths keep
 * working because both only ever reduce authority.
 */
export function assertPolicyWritable(row, { ownedIds, rosterIds }) {
  if (ownedIds.has(row.preset)) return 'owned';
  if (!isInert(row)) fail('forbidden', `预设 ${row.preset} 不在本插件管理范围内；只能停用或清除其派遣策略`);
  return rosterIds.has(row.preset) ? 'external-inert' : 'orphan-inert';
}

/**
 * Compare stored rows against the submitted array. Both sides must already be
 * normalized to the same key order, otherwise unchanged rows look changed.
 * Only changed rows are re-validated, so one stale row that merely lost its
 * authorization can never block an unrelated edit.
 */
export function changedPolicies(previous, next) {
  const before = new Map(previous.map(row => [row.preset, JSON.stringify(row)]));
  return next.filter(row => before.get(row.preset) !== JSON.stringify(row));
}

/**
 * The model pool this request must satisfy, including its own pending widening:
 * a policy that enables a newly confirmed model is validated against the pool the
 * request is about to write, not against the pool it is replacing.
 */
export function prospectivePool(current, requested) {
  if (!requested) return current;
  return { enabled: requested.enabled === true, allowedModels: requested.allowedModels ?? [], revision: requested.revision ?? null, writable: true };
}

export function requireInteger(value, label, part) {
  if (!Number.isSafeInteger(value)) fail('validation', `${label}缺少整数修订号；请重新读取后再保存`, part);
  return value;
}

/**
 * Same operation id with the same payload replays the recorded outcome instead of
 * writing twice; the same id with a different payload is refused, because one of the
 * two requests is not the retry it claims to be.
 *
 * Deliberately in-memory and per-process: it defends against a duplicated or
 * repeated delivery of one save, not against a restart. Anything the UI cannot
 * confirm is re-read from the server before it acts.
 */
export function createOperationLog(limit = 50) {
  const entries = new Map();
  const valid = id => typeof id === 'string' && id.trim().length > 0 && id.length <= 128;
  return {
    /** Recorded outcome for this exact request, or null when it is a new operation. */
    replay(id, print) {
      if (id === undefined || id === null) return null;
      if (!valid(id)) fail('validation', 'operationId 必须是不超过 128 字符的非空字符串');
      const seen = entries.get(id);
      if (!seen) return null;
      if (seen.print !== print) fail('conflict', '该 operationId 已用于另一个不同的请求；请重新读取后再保存');
      return seen.result;
    },
    record(id, print, result) {
      if (!valid(id)) return;
      if (!entries.has(id) && entries.size >= limit) entries.delete(entries.keys().next().value);
      entries.set(id, { print, result });
    },
    get(id) { return valid(id) ? entries.get(id)?.result ?? null : null; },
  };
}
