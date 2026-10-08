import { describe, expect, it } from 'vitest';
import { canonicalResults, estimateDenseTokens, measureTranscript } from '../src/metrics.js';
import type { Message } from '../src/types.js';

export function P(text: string, mirror = text): Message[] {
  return [
    { role: 'user', text: 's', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Read', input: {}, text: mirror }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u', text }] },
  ];
}
const measured = { chars: 11, tokens: 7, mirrorMismatches: 0, code: 'ok' };

describe('dense30-v1 exact vectors', () => {
  it('empty estimate', () => { expect(estimateDenseTokens('')).toBe(0); });
  it('prose without dense surcharge', () => { expect(estimateDenseTokens('internationalization')).toBe(4); });
  it('ordinary identifier', () => { expect(estimateDenseTokens('estimateTokens')).toBe(3); });
  it('digits remain half-token', () => { expect(estimateDenseTokens('12345678')).toBe(4); });
  it('repeated filler is not dense', () => { expect(estimateDenseTokens('x'.repeat(200))).toBe(34); });
  it('mixed alnum dense', () => { expect(estimateDenseTokens('abcdefgh12')).toBe(4); });
  it('short dense boundary', () => { expect(estimateDenseTokens('00aabbcc')).toBe(3); });
  it('long dense run', () => { expect(estimateDenseTokens('abcdefgh12abcdefgh12')).toBe(7); });
  it('Han watch is not calibration', () => { expect(estimateDenseTokens('\u6c49'.repeat(10))).toBe(9); });
  it('explicit UTF-16 domain', () => { expect(estimateDenseTokens('\u{1f600}')).toBe(2); });
});

describe('visible-text-input-result-v1', () => {
  it('canonical mirror counted once', () => { expect(measureTranscript(P('12345678'))).toEqual(measured); });
  it('outcome only on use', () => { expect(measureTranscript(P('12345678').slice(0, 2))).toEqual(measured); });
  it('outcome only on result', () => {
    const input = P('12345678'); delete input[1]!.toolUses[0]!.text;
    expect(measureTranscript(input)).toEqual(measured);
  });
  it('result takes priority over stale mirror', () => {
    expect(measureTranscript(P('12345678', '1234567812345678'))).toEqual({ ...measured, mirrorMismatches: 1 });
  });
  it('ambiguous result is not measured', () => {
    const input = P('12345678'); input[2]!.toolResults!.push({ tool_use_id: 'u', text: '9' });
    expect(measureTranscript(input)).toEqual({ chars: null, tokens: null, code: 'ambiguous_id' });
  });
  it('empty canonical result beats a nonempty mirror', () => {
    expect(measureTranscript(P('', 'old'))).toEqual({ chars: 3, tokens: 3, mirrorMismatches: 1, code: 'ok' });
  });
  it('different ids with equal outcomes are separate components', () => {
    const input = [...P('12345678'), ...P('12345678').slice(1).map((m) => ({ ...m,
      toolUses: m.toolUses.map((u) => ({ ...u, tool_use_id: 'v' })),
      ...(m.toolResults ? { toolResults: m.toolResults.map((r) => ({ ...r, tool_use_id: 'v' })) } : {}),
    }))];
    expect(measureTranscript(input)).toEqual({ chars: 21, tokens: 13, mirrorMismatches: 0, code: 'ok' });
  });
  it('duplicate uses and cyclic inputs are unavailable without mutation', () => {
    const input = P('12345678'); input[1]!.toolUses.push(input[1]!.toolUses[0]!);
    expect(canonicalResults(input).code).toBe('ambiguous_id');
    const cyclic = P('12345678'); cyclic[1]!.toolUses[0]!.input.self = cyclic[1]!.toolUses[0]!.input;
    expect(measureTranscript(cyclic)).toEqual({ chars: null, tokens: null, code: 'unserializable_input' });
    expect(cyclic[1]!.toolUses[0]!.input.self).toBe(cyclic[1]!.toolUses[0]!.input);
  });
  it('JSON property order and one rounding per component are preserved', () => {
    const input = P(''); input[1]!.toolUses[0]!.input = { b: 1, a: 2 };
    expect(measureTranscript(input).chars).toBe(1 + JSON.stringify({ b: 1, a: 2 }).length);
    expect(estimateDenseTokens('! ! ! ! ! ! ! ! ! !')).toBe(9);
  });
});
