import { describe, expect, it, vi } from 'vitest';

import {
  chunkMessages,
  compact,
  compactMessages,
  JevClient,
  type Chunk,
  type JevQuestions,
} from '../src/index.js';

function responseForQuestions(
  questions: JevQuestions,
  values: Record<string, { drop: number; kind: string; confidence: number }>,
) {
  return {
    answers: Object.fromEntries(
      Object.keys(questions).map((id) => {
        const chunkId = id.replace(/^(drop|kind)_/, '');
        const value = values[chunkId] ?? {
          drop: 0.1,
          kind: 'other',
          confidence: 0.9,
        };
        return [
          id,
          id.startsWith('drop_')
            ? { type: 'noul', noul: value.drop }
            : {
                type: 'choice',
                choice: value.kind,
                confidence: value.confidence,
                probabilities: { [value.kind]: value.confidence },
              },
        ];
      }),
    ),
  };
}

describe('chunkMessages', () => {
  it('pins system messages and creates stable ids', () => {
    expect(
      chunkMessages([
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'Fix the test.' },
      ]),
    ).toEqual([
      {
        id: '0-0',
        role: 'system',
        turn: 0,
        text: 'You are a coding agent.',
        pinned: true,
      },
      {
        id: '1-0',
        role: 'user',
        turn: 1,
        text: 'Fix the test.',
      },
    ]);
  });

  it('splits sentences and merges short pieces into the previous chunk', () => {
    expect(
      chunkMessages(
        [
          {
            role: 'assistant',
            content: 'The test fails because the fixture is stale. Hi!',
          },
        ],
        { mode: 'sentence' },
      ),
    ).toEqual([
      {
        id: '0-0',
        role: 'assistant',
        turn: 0,
        text: 'The test fails because the fixture is stale. Hi!',
      },
    ]);
  });

  it('splits tool output by line', () => {
    expect(
      chunkMessages(
        [{ role: 'tool', content: 'line one\nline two' }],
        { mode: 'line' },
      ).map((chunk) => chunk.text),
    ).toEqual(['line one', 'line two']);
  });
});

describe('compact', () => {
  it('applies every decision reason', async () => {
    const values = {
      '1-0': { drop: 0.99, kind: 'user_instruction', confidence: 0.9 },
      '2-0': { drop: 0.2, kind: 'chatter', confidence: 0.9 },
      '3-0': { drop: 0.99, kind: 'other', confidence: 0.2 },
      '4-0': { drop: 0.99, kind: 'other', confidence: 0.9 },
    };
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: JevQuestions;
      };
      return new Response(JSON.stringify(responseForQuestions(body.questions, values)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const chunks: Chunk[] = [
      { id: '0-0', role: 'system', turn: 0, text: 'System', pinned: true },
      { id: '1-0', role: 'user', turn: 1, text: 'Instruction' },
      { id: '2-0', role: 'assistant', turn: 2, text: 'Chatter' },
      { id: '3-0', role: 'tool', turn: 3, text: 'Uncertain' },
      { id: '4-0', role: 'assistant', turn: 4, text: 'Stale' },
    ];

    const result = await compact(chunks, {
      fetch: fetcher,
      preserveRecentTurns: 0,
    });

    expect(result.decisions.map(({ id, reason, action }) => ({ id, reason, action }))).toEqual([
      { id: '0-0', reason: 'pinned', action: 'keep' },
      { id: '1-0', reason: 'protected_kind', action: 'keep' },
      { id: '2-0', reason: 'below_threshold', action: 'keep' },
      { id: '3-0', reason: 'low_confidence', action: 'keep' },
      { id: '4-0', reason: 'dropped', action: 'drop' },
    ]);
    expect(result.dropped.map(({ id }) => id)).toEqual(['4-0']);
  });

  it('batches questions while sending the full transcript in every call', async () => {
    const states: { transcript: Chunk[] }[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        state: { transcript: Chunk[] };
        questions: JevQuestions;
      };
      states.push(body.state);
      return new Response(JSON.stringify(responseForQuestions(body.questions, {})), {
        status: 200,
      });
    });
    const chunks = Array.from({ length: 5 }, (_, turn) => ({
      id: `${turn}-0`,
      role: 'assistant' as const,
      turn,
      text: `Chunk ${turn}`,
    }));

    const result = await compact(chunks, {
      fetch: fetcher,
      maxQuestionsPerCall: 4,
      preserveRecentTurns: 0,
    });

    expect(result.stats.calls).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(states.every((state) => state.transcript.length === chunks.length)).toBe(true);
  });

  it('keeps chunks from the configured recent turns', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: JevQuestions };
      return new Response(JSON.stringify(responseForQuestions(body.questions, {
        '0-0': { drop: 0.99, kind: 'chatter', confidence: 0.9 },
      })), { status: 200 });
    });
    const result = await compact(
      [
        { id: '0-0', role: 'assistant', turn: 0, text: 'Old' },
        { id: '1-0', role: 'assistant', turn: 1, text: 'Recent' },
      ],
      { fetch: fetcher, preserveRecentTurns: 1 },
    );

    expect(result.decisions.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: '0-0', reason: 'dropped' },
      { id: '1-0', reason: 'recent' },
    ]);
  });
});

describe('compactMessages', () => {
  it('rebuilds kept chunks and removes empty messages', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: JevQuestions;
      };
      const values = {
        '0-0': { drop: 0.1, kind: 'other', confidence: 0.9 },
        '0-1': { drop: 0.99, kind: 'chatter', confidence: 0.9 },
        '1-0': { drop: 0.1, kind: 'other', confidence: 0.9 },
        '2-0': { drop: 0.99, kind: 'chatter', confidence: 0.9 },
      };
      return new Response(JSON.stringify(responseForQuestions(body.questions, values)), {
        status: 200,
      });
    });

    const result = await compactMessages(
      [
        {
          role: 'user',
          content: 'Keep this detail. Drop this entire message because it is no longer needed.',
        },
        { role: 'assistant', content: 'Another message stays.' },
        { role: 'user', content: 'Only this message is stale and should disappear.' },
      ],
      { fetch: fetcher, preserveRecentTurns: 0 },
    );

    expect(result.messages).toEqual([
      { role: 'user', content: 'Keep this detail.' },
      { role: 'assistant', content: 'Another message stays.' },
    ]);
  });
});

describe('JevClient', () => {
  it('throws non-2xx responses with the response body', async () => {
    const client = new JevClient({
      apiKey: 'test-key',
      fetch: vi.fn(async () => new Response('bad key', {
        status: 401,
        statusText: 'Unauthorized',
      })),
    });

    await expect(client.ask('state', {})).rejects.toThrow(
      'Jev request failed (401 Unauthorized): bad key',
    );
  });
});
