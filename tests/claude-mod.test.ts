import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  batchCalls,
  collectToolCalls,
  compactOrFallback,
  compactWithFetch,
  decideCall,
  fitState,
  type ToolCall,
} from '../plugin/hooks/fast-jev.ts';

type Message = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: Array<{
    tool_use_id: string;
    tool: string;
    input: Record<string, unknown>;
    text?: string;
  }>;
  toolResults?: Array<{
    tool_use_id: string;
    text: string;
    isError: boolean;
  }>;
  handle?: string;
};

function message(
  role: Message['role'],
  text: string,
  extra: Partial<Message> = {},
): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', {
    toolResults: [{ tool_use_id: id, text, isError }],
    handle: `r-${id}`,
  });
}

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

function jevFetch(
  answer: (name: string) => number,
  seen: Array<{ state: unknown; questions: string[] }> = [],
) {
  return async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as {
      state: unknown;
      questions: Record<string, unknown>;
    };
    seen.push({ state: body.state, questions: Object.keys(body.questions) });
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

const fit = {
  maxStateTokens: 25_000,
  charsPerToken: 3.5,
  preserveRecentMessages: 0,
  goal: 'fix the test',
};

describe('tool call collection', () => {
  it('pairs each tool call with its result and pins recent ones', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
  });

  it('ignores calls without a result', () => {
    const calls = collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0);
    expect(calls).toHaveLength(0);
  });
});

describe('state fitting', () => {
  it('sends the whole history with tool results replaced by a note', () => {
    const messages = transcript();
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), fit);
    expect(stage).toBe('full');
    const json = JSON.stringify(state);
    expect(json).not.toContain('export const a = 1;');
    expect(json).toContain('Never edit anything under src/generated');
    expect(json).toContain('go ahead');
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(state.history[1]?.tool_calls?.[0]).toMatchObject({
      id: 't1',
      tool: 'Read',
      result: `ok, ${fileA.length} chars (omitted)`,
    });
    expect(state.history[4]?.tool_calls?.[0]?.result).toMatch(/^error, /);
  });

  it('truncates tool inputs before touching message text', () => {
    const messages = [
      message('user', 'start'),
      call('w', 'Write', { file_path: 'x.ts', content: 'x'.repeat(5000) }, 'ok'),
      result('w', 'ok'),
      message('assistant', 'written'),
    ];
    const { state, stage, tokens } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      maxStateTokens: 300,
    });
    expect(stage).toBe('inputs<=200');
    expect(tokens).toBeLessThanOrEqual(300);
    expect(state.history[0]?.text).toBe('start');
    expect(state.history[1]?.tool_calls?.[0]?.input.length).toBeLessThanOrEqual(200);
  });

  it('abridges long texts oldest-first and collapses old messages last', () => {
    const long = (n: number) => `${n} ` + 'lorem ipsum '.repeat(300);
    const messages = [
      message('user', long(0)),
      message('assistant', long(1)),
      message('user', long(2)),
      message('assistant', long(3)),
      message('user', 'latest'),
    ];
    const abridged = fitState(messages, [], { ...fit, maxStateTokens: 1800, preserveRecentMessages: 1 });
    expect(abridged.stage).toBe('texts abridged');
    expect(abridged.tokens).toBeLessThanOrEqual(1800);
    expect(abridged.state.history[1]?.text).toContain('chars omitted');
    expect(abridged.state.history[0]?.text).toBe(long(0));
    expect(abridged.state.history[4]?.text).toBe('latest');

    const collapsed = fitState(messages, [], { ...fit, maxStateTokens: 420, preserveRecentMessages: 1 });
    expect(collapsed.stage).toBe('old messages collapsed');
    expect(collapsed.tokens).toBeLessThanOrEqual(420);
    expect(collapsed.state.history[1]?.text).toMatch(/^\[… \d+ chars omitted …\]$/);
    expect(collapsed.state.history[0]?.text).toContain('lorem');
    expect(collapsed.state.history[4]?.text).toBe('latest');
  });

  it('throws when the history cannot be fitted', () => {
    const messages = [message('user', 'a'.repeat(2000)), message('assistant', 'b')];
    expect(() => fitState(messages, [], { ...fit, maxStateTokens: 50 })).toThrow(/too large/);
  });
});

describe('question batching', () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i + 1}`,
    tool_use_id: `tool-${i + 1}`,
    tool: 'Read',
    input: {},
    callIndex: i * 2 + 1,
    resultIndex: i * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));

  it('puts everything in one request when it fits', () => {
    expect(batchCalls(calls, 1000, { maxRequestTokens: 30_000, charsPerToken: 3.5 })).toHaveLength(1);
  });

  it('splits questions across requests when the state leaves little room', () => {
    const batches = batchCalls(calls, 29_600, { maxRequestTokens: 30_000, charsPerToken: 3.5 });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });

  it('throws when a single question does not fit', () => {
    expect(() => batchCalls(calls, 29_990, { maxRequestTokens: 30_000, charsPerToken: 3.5 })).toThrow(
      /no room/,
    );
  });
});

describe('decisions', () => {
  const config = { keepThreshold: 0.5 };
  const unpinned = { id: 't1', tool: 'Read', pinned: false };

  it('keeps, drops the result, or drops the call based on the keep probabilities', () => {
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, config).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, config).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, config).action).toBe('drop_call');
    expect(decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, config)).toMatchObject({
      action: 'keep',
      reason: 'pinned',
    });
  });

  it('removes dropped calls and truncates dropped results', () => {
    const messages = transcript();
    messages[4]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[5]!.toolResults![0]!.text = 'x'.repeat(2000);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, config),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, config),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, config),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);

    expect(kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id)).toEqual([
      'Never edit anything under src/generated. Fix the failing test.',
      'a.ts looks fine; checking b.ts',
      'tool-2',
      'tool-2',
      'tool-3',
      'tool-3',
      'The failure is in b.test.ts; fixing now.',
      'go ahead',
    ]);
    expect(kept[2]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[2]?.handle).toBeUndefined();
    expect(kept[3]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[3]?.handle).toBeUndefined();
    expect(kept[4]?.handle).toBe('h-tool-3');
    expect(kept[5]?.toolResults?.[0]?.text).toContain('expected 2 to be 3');

    const shortMessages = transcript();
    shortMessages[4]!.toolUses[0]!.text = 'y'.repeat(100);
    shortMessages[5]!.toolResults![0]!.text = 'y'.repeat(100);
    const shortKept = applyDecisions(shortMessages, decisions, calls, 300);
    expect(shortKept.find((message) => message.handle === 'h-tool-2')).toBe(
      shortMessages[4],
    );
    expect(shortKept.find((message) => message.handle === 'r-tool-2')).toBe(
      shortMessages[5],
    );
  });
});

describe('end to end', () => {
  it('resends the full state with every batch and merges the answers', async () => {
    const seen: Array<{ state: unknown; questions: string[] }> = [];
    const messages = transcript();
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
      ...fit,
      goal: '',
      preserveRecentMessages: 1,
    }).tokens;
    const output = await compactWithFetch(
      messages,
      {
        apiKey: 'test-key',
        preserveRecentMessages: 1,
        maxStateTokens: 25_000,
        maxRequestTokens: stateTokens + 150,
      },
      jevFetch((name) => (name.startsWith('call_') ? 0.9 : 0.1), seen),
    );

    expect(output.requests).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.flatMap((r) => r.questions).sort()).toEqual(
      ['call_t1', 'call_t2', 'call_t3', 'result_t1', 'result_t2', 'result_t3'],
    );
    const states = new Set(seen.map((r) => JSON.stringify(r.state)));
    expect(states.size).toBe(1);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'drop_result', 'drop_result']);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.charsAfter).toBeLessThan(output.charsBefore);
  });

  it('keeps everything without calling Jev when no tool call is a candidate', async () => {
    let called = 0;
    const output = await compactWithFetch(
      [message('user', 'hello'), message('assistant', 'hi')],
      { apiKey: 'test-key' },
      async () => {
        called += 1;
        return { status: 200, ok: true, text: '{}' };
      },
    );
    expect(called).toBe(0);
    expect(output.requests).toBe(0);
    expect(output.messages).toHaveLength(2);
  });

  it('falls back when the estimated reduction is too small', async () => {
    const fallback = await compactOrFallback(
      transcript(),
      { apiKey: 'test-key', preserveRecentMessages: 1, minReductionRatio: 0.25 },
      jevFetch(() => 0.95),
    );
    expect(fallback).toBeNull();
  });

  it('rejects malformed answers and failed requests', async () => {
    await expect(
      compactWithFetch(transcript(), { apiKey: 'test-key', preserveRecentMessages: 1 }, async () => ({
        status: 200,
        ok: true,
        text: JSON.stringify({ answers: { call_t1: { noul: 0.5 } } }),
      })),
    ).rejects.toThrow(/Invalid Jev answer/);
    await expect(
      compactWithFetch(transcript(), { apiKey: 'test-key', preserveRecentMessages: 1 }, async () => ({
        status: 500,
        ok: false,
        text: '',
      })),
    ).rejects.toThrow(/500/);
    await expect(
      compactWithFetch(transcript(), { preserveRecentMessages: 1 }, jevFetch(() => 0)),
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});
