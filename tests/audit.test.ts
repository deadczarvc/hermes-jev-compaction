import { describe, expect, it } from 'vitest';
import { buildAuditEvent, classifyGate, finalizeMetrics, normalizeObserved, parseAuditLog, serializeAuditEvent, summarizeAuditLog, validateAuditEvent } from '../src/audit.js';
import { redactForEgress } from '../src/secrets.js';
import type { Message } from '../src/types.js';

function P(text: string): Message[] {
  return [{ role: 'user', text: 's', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Read', input: {}, text }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u', text }] }];
}
function A(n: number, t: number) {
  return { schema: 1, kind: 'begin', plugin: 'fast-jev-compaction', plugin_version: '0.3.0-astra.26',
    attempt_id: `00000000-0000-4000-8000-00000000000${n}`, session_id: null, trigger: 'manual', started_at_ms: t,
    before: { chars: 11, tokens: 7, mirrorMismatches: 0, code: 'ok' }, estimator_id: 'dense30-v1', projection_id: 'visible-text-input-result-v1' };
}

describe('audit table', () => {
  it('after uses new estimator not legacy ratio', () => {
    const m = finalizeMetrics(P('12345678'), P('1234'));
    expect({ before: m.tokens_before, after: m.tokens_after, delta: m.token_delta }).toEqual({ before: 7, after: 5, delta: 2 });
  });
  it('final pointer is measured', () => {
    const m = finalizeMetrics(P('12345678'), P('saved'));
    expect({ after_tokens: m.tokens_after, after_chars: m.chars_after }).toEqual({ after_tokens: 4, after_chars: 8 });
  });
  it('unknown usage is not zero', () => {
    expect(normalizeObserved({})).toEqual({ context_before: null, window_before: null, core_tokens_before: null, core_tokens_after: null });
  });
  it('observed zero is not absent', () => {
    expect(normalizeObserved({ core: { tokensBefore: 7, tokensAfter: 0 } })).toEqual({ context_before: null, window_before: null, core_tokens_before: 7, core_tokens_after: 0 });
  });
  it('no candidates is a separate reason', () => {
    expect(classifyGate({ freshCandidates: 0, reduction: 0, gate: 0, hasUsage: true })).toEqual({ candidate_reason: 'no_candidates', capacity: 'sufficient', gate_reason: 'passed' });
  });
  it('capacity even without candidates', () => {
    expect(classifyGate({ freshCandidates: 0, reduction: 0, gate: 0.2, hasUsage: true })).toEqual({ candidate_reason: 'no_candidates', capacity: 'insufficient', gate_reason: 'below_gate' });
  });
  it('capacity unknown without usage', () => {
    expect(classifyGate({ freshCandidates: 0, reduction: 0, gate: 0.25, hasUsage: false })).toEqual({ candidate_reason: 'no_candidates', capacity: 'unknown', gate_reason: 'below_gate_unknown_usage' });
  });
  it('known redaction before slicing', () => {
    expect(redactForEgress('safe FIXTURE_VALUE text', ['FIXTURE_VALUE'])).toBe('safe [REDACTED:known] text');
  });
  it('extra raw content is not written', () => {
    expect(buildAuditEvent({ ...A(1, 1000), error_message: 'FIXTURE_VALUE', body: 'fixture', cwd: 'C:/private' })).toEqual(A(1, 1000));
  });
  it('one begin without final is not success', () => {
    const summary = summarizeAuditLog([A(1, 1000)]);
    expect({ attempts: summary.attempts, incomplete: summary.incomplete, successful: summary.successful }).toEqual({ attempts: 1, incomplete: 1, successful: 0 });
  });
});

describe('audit boundary controls', () => {
  it('strict validation rejects extras and unknown schema', () => {
    expect(validateAuditEvent(A(1, 1000))).toBe(true);
    expect(validateAuditEvent({ ...A(1, 1000), schema: 2 })).toBe(false);
    expect(validateAuditEvent({ ...A(1, 1000), output: 'private' })).toBe(false);
    expect(validateAuditEvent({ ...A(1, 1000), started_at_ms: Infinity })).toBe(false);
  });
  it('known identifier redaction precedes bounds and shape checks', () => {
    expect(buildAuditEvent({ ...A(1, 1000), session_id: 'safe-FIXTURE_VALUE' }, ['FIXTURE_VALUE']).session_id).toBeNull();
    expect(buildAuditEvent({ ...A(1, 1000), session_id: '../private' }).session_id).toBeNull();
  });
  it('parser distinguishes incomplete tail corrupt middle and unknown version', () => {
    const line = serializeAuditEvent(buildAuditEvent(A(1, 1000)));
    expect(parseAuditLog(line + '{').code).toBe('tail_repaired');
    expect(parseAuditLog('{bad}\n' + line).code).toBe('audit_corrupt');
    expect(parseAuditLog(JSON.stringify({ ...A(1, 1000), schema: 2 }) + '\n').code).toBe('unknown_schema');
  });
  it('negative deltas and unobserved post-error state remain honest', () => {
    expect(finalizeMetrics(P('1234'), P('12345678'))).toMatchObject({ token_delta: -2, token_ratio: -0.4 });
    expect(finalizeMetrics(P('12345678'), null)).toMatchObject({ tokens_after: null, chars_after: null, token_delta: null, token_ratio: null });
    expect(finalizeMetrics([], [])).toMatchObject({ tokens_before: 0, token_ratio: null });
  });
  it('auto requests do not count as compactions', () => {
    const event = buildAuditEvent({ ...A(1, 1000), kind: 'auto_request', request_outcome: 'not_available', error_code: 'unknown' });
    expect(summarizeAuditLog([event])).toMatchObject({ attempts: 0, incomplete: 0, successful: 0 });
  });
});
