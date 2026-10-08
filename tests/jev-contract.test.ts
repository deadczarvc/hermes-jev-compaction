import { describe, expect, it } from 'vitest';
import { compact, noulAnswer, parseJevResponse } from '../src/index.js';
import type { JevAsker, Message } from '../src/index.js';

// --- P1-B: the architect's acceptance table (side/p1b/b-contract.cases.ts, copied verbatim to tests/jev-contract.test.ts) ---
// Jev's answers are probabilities: out of [0, 1] they are a broken response, not a decision. A round that does not
// finish in time must not hold the compaction. Sources: upstream #27/#40/#42 (answer contract), #45/#117 (deadline),
// forks f003 TaylorWatson, f009 fagemx, f001 ferrisworks (withCompactionDeadline), f017 flupkede.
const session = (): Message[] => [
  { role: 'user', text: 'go', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a.txt' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'x'.repeat(5000) }] },
  { role: 'assistant', text: 'done', toolUses: [] },
  { role: 'user', text: 'next', toolUses: [] },
];

describe('P1-B — the answer contract', () => {
  for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects noul ${bad}`, () => expect(() => noulAnswer({ q: { noul: bad } }, 'q')).toThrow(/Invalid Jev answer/));
  }
  for (const good of [0, 0.5, 1]) {
    it(`accepts noul ${good}`, () => expect(noulAnswer({ q: { noul: good } }, 'q')).toBe(good));
  }
  it('rejects answers given as an array', () => {
    expect(() => parseJevResponse(200, true, '{"answers":[]}')).toThrow(/missing answers/);
  });
  it('an out-of-range answer fails the compaction instead of deciding a call', async () => {
    const broken: JevAsker = {
      async ask(_s, q) {
        return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 7 }])) };
      },
    };
    await expect(compact(session(), broken, { preserveRecentMessages: 1, minReduction: 0 })).rejects.toThrow(/Invalid Jev answer/);
  });
});

describe('P1-B — the round deadline', () => {
  it('a hanging Jev round rejects after compactionTimeoutMs', async () => {
    const hang: JevAsker = { ask: () => new Promise(() => {}) };
    const started = Date.now();
    await expect(
      compact(session(), hang, { preserveRecentMessages: 1, minReduction: 0, compactionTimeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it('a quick round is unaffected by the deadline', async () => {
    const quick: JevAsker = {
      async ask(_s, q) {
        return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }])) };
      },
    };
    const result = await compact(session(), quick, { preserveRecentMessages: 1, minReduction: 0, compactionTimeoutMs: 5_000 });
    expect(result.messages.length).toBeGreaterThan(0);
  });
});

// Additional worker regressions; the architect's block above remains unchanged.
import { afterEach, vi } from 'vitest';
import { collectToolCalls, fitState, JevClient, resolveOptions } from '../src/index.js';
import type { CallAnswer, JevAnswer, JevQuestions, JevResponse } from '../src/index.js';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const validAnswers = (questions: JevQuestions): JevResponse => ({
  answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.1 }])),
});
const roundOptions = { preserveRecentMessages: 1, minReduction: 0, compactionTimeoutMs: 100 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function batchedSession(): { messages: Message[]; maxRequestTokens: number } {
  const messages = session();
  messages.splice(3, 0,
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r2', tool: 'Read', input: { file_path: 'b.txt' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r2', text: 'y'.repeat(5000) }] },
  );
  const calls = collectToolCalls(messages, 1);
  const { tokens } = fitState(messages, calls, resolveOptions(roundOptions));
  return { messages, maxRequestTokens: tokens + 250 };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('P1-B — malformed answers', () => {
  it.each([null, 0, '0.5', true, [], { noul: '0.5' }, { noul: -Infinity }, { type: 'choice', noul: 0.5 }])(
    'rejects a malformed answer %j with the requested error', (value) => {
      expect(() => noulAnswer({ q: value } as Record<string, JevAnswer>, 'q')).toThrow('Invalid Jev answer for q');
    },
  );
  it('rejects inherited answers and inherited noul fields', () => {
    expect(() => noulAnswer(Object.create({ q: { noul: 0.5 } }), 'q')).toThrow('Invalid Jev answer for q');
    expect(() => noulAnswer({ q: Object.create({ noul: 0.5 }) }, 'q')).toThrow('Invalid Jev answer for q');
  });
  it.each(['[]', '{}', '{"answers":null}', '{"answers":0}', '{"answers":"x"}', '{"answers":[]}'])(
    'rejects the response shape %s', (text) => {
      expect(() => parseJevResponse(200, true, text)).toThrow('Jev response is missing answers');
    },
  );
  it('accepts typed and type-less boundary probabilities', () => {
    expect(noulAnswer({ q: { type: 'noul', noul: 0 } }, 'q')).toBe(0);
    expect(noulAnswer({ q: { noul: 1 } }, 'q')).toBe(1);
    expect(parseJevResponse(200, true, '{"answers":{}}').answers).toEqual({});
  });
});

describe('P1-B — deadline lifecycle', () => {
  it('defaults to 120000 ms and resolves finite timer-safe durations', () => {
    expect(resolveOptions().compactionTimeoutMs).toBe(120_000);
    expect(resolveOptions({ compactionTimeoutMs: 100 }).compactionTimeoutMs).toBe(100);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(resolveOptions({ compactionTimeoutMs: value }).compactionTimeoutMs).toBe(120_000);
    }
    expect(resolveOptions({ compactionTimeoutMs: 0 }).compactionTimeoutMs).toBe(1);
    expect(resolveOptions({ compactionTimeoutMs: 10.9 }).compactionTimeoutMs).toBe(10);
    expect(resolveOptions({ compactionTimeoutMs: 2 ** 31 }).compactionTimeoutMs).toBe(2_147_483_647);
  });

  it.each(['success', 'request error', 'answer error'] as const)('clears the timer on %s', async (outcome) => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const asker: JevAsker = { async ask(_s, questions, signal) {
      requestSignal = signal;
      if (outcome === 'request error') throw new Error('request failed');
      if (outcome === 'answer error') return { answers: {} };
      return validAnswers(questions);
    } };
    const pending = compact(session(), asker, roundOptions);
    if (outcome === 'success') await expect(pending).resolves.toHaveProperty('messages');
    else await expect(pending).rejects.toThrow(outcome === 'request error' ? 'Jev round failed (unknown)' : 'Invalid Jev answer');
    expect(vi.getTimerCount()).toBe(0);
    expect(requestSignal).toBeDefined();
    expect(requestSignal?.aborted).toBe(outcome !== 'success');
    await vi.advanceTimersByTimeAsync(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no timer and makes no request when everything is cached or pinned', async () => {
    vi.useFakeTimers();
    const ask = vi.fn<JevAsker['ask']>();
    const knownAnswers = new Map<string, CallAnswer>([['r1', { keepCall: 0.1, keepResult: 0.1 }]]);
    await compact(session(), { ask }, { ...roundOptions, knownAnswers });
    await compact(session(), { ask }, { ...roundOptions, preserveRecentMessages: 50 });
    await compact([], { ask }, roundOptions);
    expect(ask).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('uses one deadline and cancels all batches (transport honors abort: %s)', async (honorsAbort) => {
    vi.useFakeTimers();
    const { messages, maxRequestTokens } = batchedSession();
    const signals: AbortSignal[] = [];
    const knownAnswers = new Map<string, CallAnswer>();
    const asker: JevAsker = { ask(_s, _q, signal) {
      expect(signal).toBeDefined();
      signals.push(signal!);
      return new Promise((_resolve, reject) => {
        if (honorsAbort) signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
    } };
    const before = JSON.stringify(messages);
    const pending = compact(messages, asker, { ...roundOptions, maxRequestTokens, knownAnswers });
    const assertion = expect(pending).rejects.toThrow('Jev round timed out after 100 ms');
    await flushMicrotasks();
    expect(signals).toHaveLength(2);
    expect(new Set(signals).size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(knownAnswers.size).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('late answers and late rejections cannot populate the cache after a timeout', async () => {
    vi.useFakeTimers();
    const { messages, maxRequestTokens } = batchedSession();
    const first = deferred<JevResponse>();
    const second = deferred<JevResponse>();
    const questions: JevQuestions[] = [];
    const knownAnswers = new Map<string, CallAnswer>();
    const asker: JevAsker = { ask(_s, q) { questions.push(q); return questions.length === 1 ? first.promise : second.promise; } };
    const assertion = expect(compact(messages, asker, { ...roundOptions, maxRequestTokens, knownAnswers }))
      .rejects.toThrow('Jev round timed out after 100 ms');
    await flushMicrotasks();
    expect(questions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    first.resolve(validAnswers(questions[0]!));
    second.reject(new Error('late request failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(knownAnswers.size).toBe(0);
    const ask = vi.fn<JevAsker['ask']>(async (_s, q) => validAnswers(q));
    await compact(messages, { ask }, { ...roundOptions, maxRequestTokens, knownAnswers });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(knownAnswers.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains valid batch answers on a terminal unknown failure', async () => {
    vi.useFakeTimers();
    const { messages, maxRequestTokens } = batchedSession();
    const signals: AbortSignal[] = [];
    const knownAnswers = new Map<string, CallAnswer>();
    const asker: JevAsker = { async ask(_s, q, signal) {
      signals.push(signal!);
      if (signals.length === 2) throw new Error('batch failed');
      return validAnswers(q);
    } };
    const result = await compact(messages, asker, { ...roundOptions, maxRequestTokens, knownAnswers });
    expect(result.stats.jev).toEqual({ completion: 'partial', terminalCode: 'unknown', attempts: 2, retries: 0, parsed: 1, scoredCalls: 1, unscoredCalls: 1 });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect([...knownAnswers]).toEqual([['r1', { keepCall: 0.1, keepResult: 0.1 }]]);
    expect(result.messages[3]).toBe(messages[3]);
    expect(result.messages[4]).toBe(messages[4]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('P1-B — JevClient cancellation', () => {
  it.each(['headers', 'body', 'success'] as const)('exercises native fetch against a loopback server: %s', async (phase) => {
    const received = deferred<void>();
    const rejected = deferred<unknown>();
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      received.resolve();
      request.resume();
      if (phase === 'headers') return;
      response.writeHead(200, { 'content-type': 'application/json' });
      if (phase === 'body') { response.write('{'); return; }
      response.end(JSON.stringify({ answers: { call_t1: { noul: 0.1 }, result_t1: { noul: 0.1 } } }));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const { port } = server.address() as AddressInfo;
      const client = new JevClient({ apiKey: 'test', provider: 'custom', baseUrl: `http://127.0.0.1:${port}/systemone` });
      let signal: AbortSignal | undefined;
      const asker: JevAsker = { async ask(state, questions, roundSignal) {
        signal = roundSignal;
        try { return await client.ask(state, questions, roundSignal); }
        catch (error) { rejected.resolve(error); throw error; }
      } };
      const pending = compact(session(), asker, { ...roundOptions, compactionTimeoutMs: 300 });
      const assertion = phase === 'success'
        ? expect(pending).resolves.toHaveProperty('messages')
        : expect(pending).rejects.toThrow('Jev round timed out after 300 ms');
      await received.promise;
      await assertion;
      expect(signal?.aborted).toBe(phase !== 'success');
      if (phase !== 'success') {
        // The transport itself must reject, not just the outer compaction race.
        expect(await rejected.promise).toBeInstanceOf(Error);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes the round AbortSignal to an abort-aware fetch', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true }));
    };
    const client = new JevClient({ apiKey: 'test', fetch: fetcher });
    const assertion = expect(compact(session(), client, roundOptions)).rejects.toThrow('Jev round timed out after 100 ms');
    await flushMicrotasks();
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason.message).toBe('Jev round timed out after 100 ms');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled body consumption even when fetch ignores cancellation', async () => {
    vi.useFakeTimers();
    const response = new Response('{}', { status: 200 });
    vi.spyOn(response, 'text').mockReturnValue(new Promise(() => {}));
    let requestSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_url, init) => { requestSignal = init?.signal ?? undefined; return response; };
    const assertion = expect(compact(session(), new JevClient({ apiKey: 'test', fetch: fetcher }), roundOptions))
      .rejects.toThrow('Jev round timed out after 100 ms');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(response.text).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends no request for an already-aborted signal', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort(new Error('cancelled before send'));
    const client = new JevClient({ apiKey: 'test', fetch: fetcher });
    await expect(client.ask({}, {}, controller.signal)).rejects.toThrow('cancelled before send');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
