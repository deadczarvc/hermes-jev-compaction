import { describe, expect, it } from 'vitest';
import { compact, fitState, safeSlice, truncate } from '../src/index.js';
import type { JevAsker, Message } from '../src/index.js';

// --- P1-A: the architect's acceptance table (side/p1b/a-utf16.cases.ts, copied verbatim to tests/utf16.test.ts) ---
// A UTF-16 slice may cut a surrogate pair in half; a lone surrogate then goes into the Jev request and the stubs.
// Sources: upstream #110, fork f021 artyomx33 (1883288dca), f009 fagemx.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EMOJI = 'x😀y😀z😀w';

describe('P1-A — no lone surrogates', () => {
  it('safeSlice never splits a pair, for every start and end', () => {
    for (let start = 0; start <= EMOJI.length; start++) {
      for (let end = start; end <= EMOJI.length; end++) {
        const out = safeSlice(EMOJI, start, end);
        expect(LONE.test(out), `safeSlice(${start}, ${end}) = ${JSON.stringify(out)}`).toBe(false);
        expect(EMOJI.includes(out)).toBe(true);
      }
    }
  });

  it('safeSlice keeps plain ASCII slices exactly as String.slice does', () => {
    const s = 'abcdefghij';
    for (let start = 0; start <= s.length; start++) {
      for (let end = start; end <= s.length; end++) expect(safeSlice(s, start, end)).toBe(s.slice(start, end));
    }
  });

  it('truncate never leaves a lone surrogate, for every limit', () => {
    for (let limit = 1; limit <= EMOJI.length + 1; limit++) {
      expect(LONE.test(truncate(EMOJI, limit)), `limit ${limit}`).toBe(false);
    }
  });

  it('the fitted state of an emoji-heavy history has no lone surrogate', () => {
    const text = '😀'.repeat(3000);
    const messages: Message[] = [
      { role: 'user', text: `goal ${text}`, toolUses: [] },
      { role: 'assistant', text, toolUses: [{ tool_use_id: 't1', tool: 'Write', input: { file_path: 'a.md', content: text } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok' }] },
      { role: 'assistant', text, toolUses: [] },
    ];
    const fitted = fitState(messages, [], { maxStateTokens: 4000, preserveRecentMessages: 1, goal: '' });
    expect(LONE.test(JSON.stringify(fitted.state))).toBe(false);
  });

  it('a reduced tool result keeps no lone surrogate in its head', async () => {
    const big = '😀'.repeat(5000);
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a.txt' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: big }] },
      { role: 'assistant', text: 'done', toolUses: [] },
      { role: 'user', text: 'next', toolUses: [] },
    ];
    const dropAll: JevAsker = {
      async ask(_state, questions) {
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.01 }])) };
      },
    };
    const result = await compact(messages, dropAll, { preserveRecentMessages: 1, truncateHeadChars: 201, minReduction: 0 });
    expect(LONE.test(JSON.stringify(result.messages))).toBe(false);
  });
});

// Additional regressions: the architect's block above remains unchanged.
// Ported to hermes-jev-compaction with two host-specific describe sections removed:
// the three Codex fact-sheet/MDL cases (src/codex.ts and codex/ are not ported —
// see MERGE-MATRIX Q1) and the hook offload case (hooks/fast-jev.ts is not ported —
// MERGE-MATRIX Q5 SKIP). All src/index.js UTF-16 cases, safeSlice included, stay live.
import { applyDecisions, briefInput, collectToolCalls, decideCall, factStubText, pieces } from '../src/index.js';

function wellFormed(value: unknown): void {
  if (typeof value === 'string') expect(LONE.test(value), `UTF-16 length ${value.length}`).toBe(false);
  else if (Array.isArray(value)) value.forEach(wellFormed);
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => {
    wellFormed(key);
    wellFormed(item);
  });
}

function history(text: string, input: Record<string, unknown> = {}): Message[] {
  return [
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Write', input, text }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u', text, isError: false }] },
    { role: 'assistant', text: 'done', toolUses: [] },
  ];
}

describe('P1-A — additional boundaries and live paths', () => {
  it('matches String.slice for negative, fractional and special ASCII indices', () => {
    const text = 'abcdefghij';
    const indices = [-Infinity, -99, -10, -2.8, -1, -0, 0, 0.8, 1, 1.8, 9, 10, 99, NaN, Infinity];
    for (const start of indices) {
      expect(safeSlice(text, start)).toBe(text.slice(start));
      for (const end of indices) expect(safeSlice(text, start, end)).toBe(text.slice(start, end));
    }
  });

  it('moves only boundaries within a genuine pair inward', () => {
    const text = 'a😀b';
    expect(safeSlice(text, 0, 2)).toBe('a');
    expect(safeSlice(text, 2)).toBe('b');
    expect(safeSlice(text, -2)).toBe('b');
    expect(safeSlice(text, 1, 3)).toBe('😀');
    expect(safeSlice(text, 2, 2)).toBe('');
    expect(safeSlice(text, 0.8, 2.9)).toBe('a');
    expect(safeSlice(text, -Infinity, Infinity)).toBe(text);
    expect(safeSlice('\uD800x\uDC00', 0)).toBe('\uD800x\uDC00'); // Not a sanitizer of malformed input.
    for (let start = -12; start <= 12; start++) {
      wellFormed(safeSlice(EMOJI, start));
      for (let end = -12; end <= 12; end++) wellFormed(safeSlice(EMOJI, start, end));
    }
  });

  it('the negative control detects lone surrogates before JSON.stringify', () => {
    const broken = EMOJI.slice(0, 2);
    expect(LONE.test(broken)).toBe(true);
    expect(LONE.test(JSON.stringify(broken))).toBe(false); // JSON escapes the malformed code unit.
    expect(LONE.test('😀')).toBe(false);
  });

  it('pieces preserves the full string and every pair at separator-free seams', () => {
    for (let prefix = 0; prefix <= 201; prefix++) {
      const text = `${'x'.repeat(prefix)}${'😀'.repeat(301)}${'y'.repeat(205)}`;
      const chunks = pieces(text);
      wellFormed(chunks);
      expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
      expect(chunks.join('')).toBe(text);
    }
  });

  it('briefInput recursively cuts strings and counts the actual omitted code units', () => {
    const text = `${'x'.repeat(199)}😀${'y'.repeat(700)}`;
    const out = briefInput({ nested: [text, { content: text }], n: 7 }, 200);
    wellFormed(out);
    const expected = `${'x'.repeat(199)}…[${text.length - 199} chars]`;
    expect(out).toEqual({ nested: [expected, { content: expected }], n: 7 });
    expect(briefInput(text, NaN)).toBe(text);
    expect(briefInput(text, text.length)).toBe(text);
    expect(briefInput(text, text.length + 1)).toBe(text);
  });

  it('abridge keeps intact head and tail with an accurate omitted count in raw state', () => {
    const text = `${'x'.repeat(399)}😀${'😀'.repeat(3000)}😀${'y'.repeat(149)}`;
    const fitted = fitState([{ role: 'user', text, toolUses: [] }], [], { maxStateTokens: 2000, preserveRecentMessages: 1, goal: 'goal' });
    expect(fitted.stage).toBe('texts abridged');
    wellFormed(fitted.state);
    expect(fitted.state.history[0]!.text).toBe(`${'x'.repeat(399)}\n[… ${text.length - 399 - 149} chars omitted …]\n${'y'.repeat(149)}`);
  });

  it('legacy drop_result is safe and keeps tool_use and tool_result text equal', () => {
    const text = '😀'.repeat(5000);
    const messages = history(text);
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 1, keepResult: 0 }, { keepThreshold: 0.5 })];
    const out = applyDecisions(messages, decisions, calls, 201, false);
    wellFormed(out);
    const expected = `${'😀'.repeat(100)}\n[fast-jev-compaction truncated ${text.length - 200} chars of this tool result; re-run the tool if needed]`;
    expect(out[1]!.toolUses[0]!.text).toBe(expected);
    expect(out[2]!.toolResults![0]!.text).toBe(expected);
  });

  it('factStubText loses no pairs between the head, fact middle and tail', () => {
    const text = `${'😀'.repeat(5000)}z`;
    let middle = '';
    const out = factStubText(text, false, 201, 0, 'u', { small: 0, share: 0, readKeep: 0, denseKeep: 0, denseShare: 1 }, (part) => {
      middle = part;
      wellFormed(part);
      return [];
    });
    wellFormed(out);
    const head = '😀'.repeat(100);
    const tail = `${'😀'.repeat(59)}z`;
    expect(head + middle + tail).toBe(text);
    expect(out).toContain(`omitted ${text.length - head.length - tail.length} chars`);
    expect(out.startsWith(`${head}\n`)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
  });

  it('compact sends well-formed raw state and returns intact stubs without mutating input', async () => {
    const text = `${'x'.repeat(199)}${'😀'.repeat(5000)}z`;
    const messages = history(text, { file_path: 'a.md', content: text });
    const original = JSON.stringify(messages);
    let requests = 0;
    const asker: JevAsker = {
      async ask(state, questions) {
        requests++;
        wellFormed(state);
        wellFormed(JSON.parse(JSON.stringify(state)));
        return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.01 }])) };
      },
    };
    const out = await compact(messages, asker, { preserveRecentMessages: 1, maxStateTokens: 4000, truncateHeadChars: 201, minReduction: 0 });
    expect(requests).toBeGreaterThan(0);
    wellFormed(out.messages);
    expect(JSON.stringify(messages)).toBe(original);
  });
});
