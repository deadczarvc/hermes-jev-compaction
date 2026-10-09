import { describe, expect, it } from 'vitest';
import { buildDecisionsRequest } from '../src/decisions';

// Pins the question-wrapping behaviour of the 'noul' branch (ported from
// deadczarvc-labs/jev-factkeep-compaction@9f9adf2). The last two cases are known
// limitations inherited verbatim from upstream: the heuristic only inspects the
// closing character, so a '?!/...' tail keeps a stray mark and an empty
// instruction still gets framed. Kept as regression pins, not as defects.

const S = { apiKey: 'k', baseUrl: 'https://x' } as any;

function instructions(instructions: string, criteria?: { true?: string; false?: string }): string {
  const q = { a: { type: 'noul', instructions, ...(criteria ? { criteria } : {}) } } as any;
  return JSON.parse(buildDecisionsRequest(S, {}, q).body).questions[0].instructions as string;
}

describe('decisions: statement criteria wrapping', () => {
  it('wraps a statement carrying criteria into a question', () => {
    expect(instructions('The build passed', { true: 'ok', false: 'not' }))
      .toBe('Is this statement true: The build passed?\nTrue when: ok.\nFalse when: not.');
  });

  it('leaves a statement without criteria untouched (backward compatible)', () => {
    expect(instructions('The build passed')).toBe('The build passed');
  });

  it('does not double-frame an instruction that already ends with a question mark', () => {
    expect(instructions('Did the build pass?', { true: 'ok', false: 'not' }))
      .toBe('Did the build pass?\nTrue when: ok.\nFalse when: not.');
  });

  it('known limitation: a "?!" tail keeps a stray mark', () => {
    expect(instructions('Did the build pass?!', { true: 'ok', false: 'not' }))
      .toBe('Is this statement true: Did the build pass?!?\nTrue when: ok.\nFalse when: not.');
  });

  it('known limitation: an empty instruction still gets framed', () => {
    expect(instructions('', { true: 'ok', false: 'not' }))
      .toBe('Is this statement true: ?\nTrue when: ok.\nFalse when: not.');
  });
});
