import { ESTIMATOR_ID, PROJECTION_ID, canonicalResults, measureTranscript, type MeasureResult, type MeasurementCode, type Transcript } from './metrics.js';
import { redactForEgress } from './secrets.js';
import type { RoundObservation } from './types.js';

export const MAX_RECORD_BYTES = 4096;
export type AuditOutcome = 'jev_returned' | 'local_returned' | 'original_returned' | 'summary_returned' |
  'summary_skip_returned' | 'own_returned_after_summary_error' | 'error_raised';
export type AuditErrorCode = 'none' | 'missing_key' | 'invalid_endpoint' | 'request_capacity' | 'ambiguous_id' |
  'unserializable_input' | 'summary_error' | 'network' | 'http_4xx' | 'http_5xx' | 'rate_limited' | 'deadline' | 'contract' | 'unknown';
export type AuditIdentity = Readonly<{
  schema: 1; plugin: 'fast-jev-compaction'; plugin_version: string; attempt_id: string; session_id: string | null;
  trigger: 'manual' | 'auto' | 'plugin' | 'precompute'; started_at_ms: number;
}>;
export type AuditEstimates = Readonly<{
  estimator_id: typeof ESTIMATOR_ID; projection_id: typeof PROJECTION_ID;
  tokens_before: number | null; tokens_after: number | null; chars_before: number | null; chars_after: number | null;
  token_delta: number | null; token_ratio: number | null; mirror_mismatches: number | null; measurement_code: MeasurementCode;
}>;
export type ObservedValues = Readonly<{
  context_before: number | null; window_before: number | null; core_tokens_before: number | null; core_tokens_after: number | null;
}>;
export type ObservedCounters = { readonly [K in keyof ObservedValues]: Readonly<{ value: number | null; source: 'session.usage' | 'next' | null }> };
export type GateClassification = Readonly<{
  candidate_reason: 'no_candidates' | 'has_candidates'; capacity: 'insufficient' | 'sufficient' | 'unknown';
  gate_reason: 'passed' | 'below_gate' | 'below_gate_unknown_usage' | 'error';
}>;
export type AuditBegin = AuditIdentity & Readonly<{ kind: 'begin'; before: MeasureResult; estimator_id: typeof ESTIMATOR_ID; projection_id: typeof PROJECTION_ID }>;
export type AuditFinal = AuditIdentity & GateClassification & Readonly<{
  kind: 'final'; finished_at_ms: number; duration_ms: number; outcome: AuditOutcome; error_code: AuditErrorCode;
  estimates: AuditEstimates; round: RoundObservation; observed: ObservedCounters; host_applied: null;
}>;
export type AuditAutoRequest = AuditIdentity & Readonly<{ kind: 'auto_request'; request_outcome: 'requested' | 'not_available' | 'error'; error_code: AuditErrorCode }>;
export type AuditEvent = AuditBegin | AuditFinal | AuditAutoRequest;
export type AuditStatus = 'written' | 'duplicate' | 'audit_unavailable' | 'audit_io' | 'audit_lock_busy' | 'audit_corrupt' | 'audit_schema' | 'audit_path';
export type AuditAck = Readonly<{ status: AuditStatus; diagnostic?: 'tail_repaired' }>;
/** An injected capability, not the host context or a filesystem handle. */
export type AuditSink = (event: AuditEvent) => Promise<AuditAck>;

const OUTCOMES: readonly AuditOutcome[] = ['jev_returned', 'local_returned', 'original_returned', 'summary_returned', 'summary_skip_returned', 'own_returned_after_summary_error', 'error_raised'];
const ERRORS: readonly AuditErrorCode[] = ['none', 'missing_key', 'invalid_endpoint', 'request_capacity', 'ambiguous_id', 'unserializable_input', 'summary_error', 'network', 'http_4xx', 'http_5xx', 'rate_limited', 'deadline', 'contract', 'unknown'];
const CODES: readonly MeasurementCode[] = ['ok', 'ambiguous_id', 'unserializable_input'];
const ID_KEYS = ['schema', 'plugin', 'plugin_version', 'attempt_id', 'session_id', 'trigger', 'started_at_ms'];
const MEASURE_KEYS = ['chars', 'tokens', 'mirrorMismatches', 'code'];
const ESTIMATE_KEYS = ['estimator_id', 'projection_id', 'tokens_before', 'tokens_after', 'chars_before', 'chars_after', 'token_delta', 'token_ratio', 'mirror_mismatches', 'measurement_code'];
const ROUND_KEYS = ['completion', 'terminal_code', 'requests_planned', 'attempts', 'retries', 'parsed', 'scored_calls', 'unscored_calls', 'fresh', 'cache', 'floor', 'reduced', 'pinned', 'request_estimated_max', 'actual_input_tokens', 'actual_output_tokens', 'usage_responses'];
const OBSERVED_KEYS = ['context_before', 'window_before', 'core_tokens_before', 'core_tokens_after'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}
function member(value: unknown, allowed: readonly string[]): boolean { return typeof value === 'string' && allowed.includes(value); }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function nullableCount(value: unknown): boolean { return value === null || count(value); }
function finiteNullable(value: unknown): boolean { return value === null || (typeof value === 'number' && Number.isFinite(value)); }
function measurement(value: unknown): boolean {
  if (!record(value) || !member(value.code, CODES)) return false;
  return value.code === 'ok'
    ? exact(value, MEASURE_KEYS) && count(value.chars) && count(value.tokens) && count(value.mirrorMismatches)
    : exact(value, ['chars', 'tokens', 'code']) && value.chars === null && value.tokens === null;
}

/** Strict storage boundary: unknown keys/versions, raw content and non-finite counters are rejected. */
export function validateAuditEvent(value: unknown): value is AuditEvent {
  if (!record(value) || value.schema !== 1 || value.plugin !== 'fast-jev-compaction' ||
    typeof value.plugin_version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(value.plugin_version) ||
    typeof value.attempt_id !== 'string' || !UUID.test(value.attempt_id) ||
    !(value.session_id === null || (typeof value.session_id === 'string' && SESSION.test(value.session_id))) ||
    !member(value.trigger, ['manual', 'auto', 'plugin', 'precompute']) || !count(value.started_at_ms)) return false;
  if (value.kind === 'begin') return exact(value, [...ID_KEYS, 'kind', 'before', 'estimator_id', 'projection_id']) &&
    value.estimator_id === ESTIMATOR_ID && value.projection_id === PROJECTION_ID && measurement(value.before);
  if (value.kind === 'auto_request') return exact(value, [...ID_KEYS, 'kind', 'request_outcome', 'error_code']) &&
    member(value.request_outcome, ['requested', 'not_available', 'error']) && member(value.error_code, ERRORS);
  if (value.kind !== 'final' || !exact(value, [...ID_KEYS, 'kind', 'finished_at_ms', 'duration_ms', 'outcome', 'error_code', 'candidate_reason', 'capacity', 'gate_reason', 'estimates', 'round', 'observed', 'host_applied']) ||
    !count(value.finished_at_ms) || !count(value.duration_ms) || value.duration_ms !== value.finished_at_ms - value.started_at_ms ||
    value.host_applied !== null || !member(value.outcome, OUTCOMES) || !member(value.error_code, ERRORS) ||
    !member(value.candidate_reason, ['no_candidates', 'has_candidates']) || !member(value.capacity, ['insufficient', 'sufficient', 'unknown']) ||
    !member(value.gate_reason, ['passed', 'below_gate', 'below_gate_unknown_usage', 'error'])) return false;
  const e = value.estimates, r = value.round, o = value.observed;
  if (!record(e) || !exact(e, ESTIMATE_KEYS) || e.estimator_id !== ESTIMATOR_ID || e.projection_id !== PROJECTION_ID ||
    !member(e.measurement_code, CODES) || !['tokens_before', 'tokens_after', 'chars_before', 'chars_after', 'mirror_mismatches'].every((k) => nullableCount(e[k])) ||
    !finiteNullable(e.token_delta) || !finiteNullable(e.token_ratio)) return false;
  if (!record(r) || !exact(r, ROUND_KEYS) || !member(r.completion, ['complete', 'partial', 'failed']) ||
    !member(r.terminal_code, ['none', 'network', 'http_4xx', 'http_5xx', 'rate_limited', 'deadline', 'contract', 'unknown']) ||
    !ROUND_KEYS.slice(2).every((k) => nullableCount(r[k]))) return false;
  return record(o) && exact(o, OBSERVED_KEYS) && OBSERVED_KEYS.every((k) => {
    const counter = o[k];
    return record(counter) && exact(counter, ['value', 'source']) && nullableCount(counter.value) &&
      (counter.value === null ? counter.source === null : counter.source === (k.startsWith('core_') ? 'next' : 'session.usage'));
  });
}
function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value)) return {};
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

/** Scalars/counters only. Drop unrecognized keys before redaction or serialization; never accept messages or Error. */
export function buildAuditEvent(input: Readonly<Record<string, unknown>>, known: readonly string[] = []): AuditEvent {
  const value = pick(input, ID_KEYS);
  value.kind = input.kind;
  for (const key of ['plugin_version', 'attempt_id', 'session_id']) {
    const raw = value[key];
    if (typeof raw === 'string') value[key] = redactForEgress(raw, known);
  }
  if (typeof value.session_id !== 'string' || !SESSION.test(value.session_id)) value.session_id = null;
  if (input.kind === 'begin') {
    Object.assign(value, pick(input, ['estimator_id', 'projection_id']));
    const before = record(input.before) ? input.before : {};
    value.before = pick(before, before.code === 'ok' ? MEASURE_KEYS : ['chars', 'tokens', 'code']);
  } else if (input.kind === 'auto_request') Object.assign(value, pick(input, ['request_outcome', 'error_code']));
  else if (input.kind === 'final') {
    Object.assign(value, pick(input, ['finished_at_ms', 'duration_ms', 'outcome', 'error_code', 'candidate_reason', 'capacity', 'gate_reason', 'host_applied']));
    value.estimates = pick(input.estimates, ESTIMATE_KEYS); value.round = pick(input.round, ROUND_KEYS);
    const observed = record(input.observed) ? input.observed : {};
    value.observed = Object.fromEntries(OBSERVED_KEYS.map((k) => [k, pick(observed[k], ['value', 'source'])]));
  }
  if (!validateAuditEvent(value)) throw new Error('audit_schema');
  return value;
}
/** UTF-8 size without importing Node into the sandbox. */
export function auditByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
export function serializeAuditEvent(event: AuditEvent): string {
  if (!validateAuditEvent(event)) throw new Error('audit_schema');
  const line = JSON.stringify(event) + '\n';
  if (auditByteLength(line) > MAX_RECORD_BYTES) throw new Error('audit_schema');
  return line;
}
export function parseAuditLog(text: string): Readonly<{ events: AuditEvent[]; code: 'ok' | 'tail_repaired' | 'audit_corrupt' | 'unknown_schema' }> {
  const events: AuditEvent[] = [], seen = new Map<string, string>();
  const complete = text.endsWith('\n') || text === '';
  const lines = text.split('\n'); lines.pop();
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return { events: [], code: 'audit_corrupt' }; }
    if (record(value) && value.schema !== 1) return { events: [], code: 'unknown_schema' };
    if (!validateAuditEvent(value) || auditByteLength(line + '\n') > MAX_RECORD_BYTES) return { events: [], code: 'audit_corrupt' };
    const key = `${value.attempt_id}:${value.kind}`, canonical = JSON.stringify(value);
    if (seen.has(key) && seen.get(key) !== canonical) return { events: [], code: 'audit_corrupt' };
    if (!seen.has(key)) { seen.set(key, canonical); events.push(value); }
  }
  return { events, code: complete ? 'ok' : 'tail_repaired' };
}
export function summarizeAuditLog(values: readonly unknown[]): Readonly<{ attempts: number; incomplete: number; successful: number }> {
  const groups = new Map<string, { begin: boolean; final?: AuditFinal }>();
  for (const event of values) if (validateAuditEvent(event) && event.kind !== 'auto_request') {
    const group = groups.get(event.attempt_id) ?? { begin: false };
    if (event.kind === 'begin') group.begin = true; else group.final = event;
    groups.set(event.attempt_id, group);
  }
  let incomplete = 0, successful = 0;
  for (const group of groups.values()) {
    if (!group.begin || !group.final) incomplete++;
    else if (group.final.outcome !== 'error_raised' && group.final.outcome !== 'summary_skip_returned') successful++;
  }
  return { attempts: groups.size, incomplete, successful };
}
export function classifyGate(input: Readonly<{ freshCandidates: number; reduction: number; gate: number; hasUsage: boolean; error?: boolean }>): GateClassification {
  const passed = input.reduction >= input.gate;
  return { candidate_reason: input.freshCandidates > 0 ? 'has_candidates' : 'no_candidates',
    capacity: input.error || !input.hasUsage ? 'unknown' : passed ? 'sufficient' : 'insufficient',
    gate_reason: input.error ? 'error' : passed ? 'passed' : input.hasUsage ? 'below_gate' : 'below_gate_unknown_usage' };
}
export function finalizeMetrics(before: Transcript, after: Transcript | null): AuditEstimates {
  return finalizeMeasurements(measureTranscript(before), after === null ? null : measureTranscript(after));
}
export function finalizeMeasurements(before: MeasureResult, after: MeasureResult | null): AuditEstimates {
  const b = before.tokens, a = after?.tokens ?? null;
  const delta = b === null || a === null ? null : b - a;
  return { estimator_id: ESTIMATOR_ID, projection_id: PROJECTION_ID, tokens_before: b, tokens_after: a,
    chars_before: before.chars, chars_after: after?.chars ?? null, token_delta: delta,
    token_ratio: delta !== null && b !== null && b > 0 ? delta / b : null,
    mirror_mismatches: before.code === 'ok' && (!after || after.code === 'ok') ? before.mirrorMismatches + (after?.mirrorMismatches ?? 0) : null,
    measurement_code: before.code !== 'ok' ? before.code : after?.code ?? 'ok' };
}
export function normalizeObserved(input: Readonly<{ usage?: { tokens?: number; window?: number }; core?: { tokensBefore?: number; tokensAfter?: number } }>): ObservedValues {
  const value = (n: unknown): number | null => count(n) ? n : null;
  return { context_before: value(input.usage?.tokens), window_before: value(input.usage?.window), core_tokens_before: value(input.core?.tokensBefore), core_tokens_after: value(input.core?.tokensAfter) };
}
export function observedCounters(values: ObservedValues): ObservedCounters {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, source: value === null ? null : key.startsWith('core_') ? 'next' : 'session.usage' }])) as ObservedCounters;
}
export function canonicalContentChanged(before: Transcript, after: Transcript): boolean {
  const b = canonicalResults(before), a = canonicalResults(after);
  return b.code === 'ok' && a.code === 'ok' && JSON.stringify(b.components) !== JSON.stringify(a.components);
}
export function parseAuditAck(stdout: string, exitCode: number): AuditAck {
  try {
    if (stdout.length > 256) return { status: 'audit_io' };
    const ack: unknown = JSON.parse(stdout);
    if (!record(ack) || !member(ack.status, ['written', 'duplicate', 'audit_unavailable', 'audit_io', 'audit_lock_busy', 'audit_corrupt', 'audit_schema', 'audit_path']) ||
      Object.keys(ack).some((k) => k !== 'status' && k !== 'diagnostic') ||
      (ack.diagnostic !== undefined && ack.diagnostic !== 'tail_repaired') ||
      (exitCode !== 0 && (ack.status === 'written' || ack.status === 'duplicate'))) return { status: 'audit_io' };
    return ack as AuditAck;
  } catch { return { status: 'audit_io' }; }
}
/** Explicit configuration is a trust decision; no PATH lookup, UNC, traversal or shell program is accepted. */
export function auditArgv(node: unknown, launcher: unknown, root: unknown): readonly string[] | null {
  const local = (p: unknown): p is string => typeof p === 'string' && p.length < 4096 && !/[\x00-\x1f]/.test(p) &&
    (/^[A-Za-z]:[\\/]/.test(p) || /^\/(?!\/)/.test(p)) && !p.split(/[\\/]/).some((segment) => segment === '..' || segment === '.');
  if (!local(node) || !local(root) || !/(?:^|[\\/])node(?:\.exe)?$/i.test(node)) return null;
  const script = `${root.replace(/[\\/]+$/, '')}/scripts/audit-writer.mjs`;
  if (/^[A-Za-z]:/.test(root) || /^[A-Za-z]:/.test(node)) {
    if (!local(launcher) || !/\.exe$/i.test(launcher)) return null;
    return [launcher, node, script, '--append'];
  }
  return [node, script, '--append'];
}
