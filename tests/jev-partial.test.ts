import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectToolCalls, compact, estimateTokens, fitState, JevHttpError, JevRoundError,
  questionsFor, readBatchAnswers, resolveOptions, runRoundJobs,
} from '../src/index.js';
import type { CallAnswer, CompactOptions, JevAsker, JevQuestions, JevResponse, Message, ToolCall } from '../src/index.js';

const H: Message[] = [
  { role: 'user', text: 'go', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a.txt' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'x'.repeat(5000) }] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r2', tool: 'Read', input: { file_path: 'b.txt' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r2', text: 'y'.repeat(5000) }] },
  { role: 'assistant', text: 'done', toolUses: [] },
  { role: 'user', text: 'next', toolUses: [] },
];
const H1 = H.filter((_message, i) => i !== 3 && i !== 4);
const O = { preserveRecentMessages: 1, minReduction: 0, compactionTimeoutMs: 10000, nowMs: async () => Date.now() };
const calls = collectToolCalls(H, 1);
const state = { context: 'ctx', goal: 'g', history: [] };
const V1: JevResponse = { answers: { call_t1: { noul: 0.1 }, result_t1: { noul: 0.1 } } };
const V2: JevResponse = { answers: { call_t2: { noul: 0.1 }, result_t2: { noul: 0.1 } } };
const score = { keepCall: 0.1, keepResult: 0.1 };
const maxRequestTokens = fitState(H, calls, resolveOptions(O)).tokens + 20 + Math.max(...calls.map((c) => estimateTokens(JSON.stringify(questionsFor(c)))));
const jobs = calls.map((call) => ({ state, batch: [call] }));

async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function rejection(pending: Promise<unknown>): Promise<JevRoundError> {
  const error = await pending.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(JevRoundError); return error as JevRoundError;
}
function answerFor(questions: JevQuestions): JevResponse {
  return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.1 }])) };
}
function assertUnscored(result: Awaited<ReturnType<typeof compact>>, id = 't2'): void {
  expect(result.decisions.find((decision) => decision.id === id)).toEqual({ id, tool: 'Read', action: 'keep', reason: 'unscored', keepCall: 1, keepResult: 1 });
  expect(result.messages[3]).toBe(H[3]); expect(result.messages[4]).toBe(H[4]);
  expect(result.messages[3]!.toolUses[0]).toBe(H[3]!.toolUses[0]);
  expect(result.messages[4]!.toolResults![0]).toBe(H[4]!.toolResults![0]);
  expect(result.messages[4]!.toolResults![0]!.text).toBe('y'.repeat(5000));
}
function syntheticJobs(size: number) {
  return Array.from({ length: size }, (_, i) => ({ state, batch: [{
    id: `t${i + 1}`, tool_use_id: `r${i + 1}`, tool: 'Read', input: { file_path: 'fixture.txt' },
    callIndex: 1, resultIndex: 2, resultChars: 5000, isError: false, pinned: false,
  } satisfies ToolCall] }));
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('R2 partial pairs', () => {
  it('retains unscored original pairs from a partial batch', async () => {
    const response = { answers: { ...V1.answers, call_t2: { noul: 0.7 } } }, K = new Map<string, CallAnswer>();
    const parsed = readBatchAnswers(response, calls);
    expect([...parsed.scored]).toEqual([['t1', score]]); expect(parsed.missingCalls).toEqual(['t2']);
    const ask = vi.fn<JevAsker['ask']>(async () => response), before = JSON.stringify(H);
    const result = await compact(H, { ask }, { ...O, knownAnswers: K });
    assertUnscored(result); expect(result.stats.jev).toMatchObject({ completion: 'partial', retries: 0, terminalCode: 'none', scoredCalls: 1, unscoredCalls: 1 });
    expect([...K]).toEqual([['r1', score]]); expect(ask).toHaveBeenCalledOnce(); expect(JSON.stringify(H)).toBe(before);
  });
  it('does not derive a decision from one valid half of a pair', async () => {
    const response = { answers: { ...V1.answers, result_t2: { noul: 0 } } }, K = new Map<string, CallAnswer>();
    expect([...readBatchAnswers(response, calls).scored]).toEqual([['t1', score]]);
    const result = await compact(H, { ask: async () => response }, { ...O, knownAnswers: K });
    assertUnscored(result); expect([...K]).toEqual([['r1', score]]);
  });
  it('does not hide an invalid answer behind a missing half', async () => {
    const response = { answers: { ...V1.answers, call_t2: { noul: '0.7' } } }, K = new Map<string, CallAnswer>();
    const ask = vi.fn<JevAsker['ask']>(async () => response as unknown as JevResponse);
    const error = await rejection(compact(H, { ask }, { ...O, knownAnswers: K }));
    expect(error.code).toBe('contract'); expect(error.message).toContain('Invalid Jev answer for call_t2');
    expect(error.counts.retries).toBe(0); expect(K.size).toBe(0); expect(ask).toHaveBeenCalledOnce();
  });
  it('rolls back an out-of-range answer beside a valid pair', async () => {
    const response = { answers: { ...V1.answers, call_t2: { noul: 1.01 }, result_t2: { noul: 0.5 } } };
    const K = new Map<string, CallAnswer>(), before = JSON.stringify(H);
    const error = await rejection(compact(H, { ask: async () => response }, { ...O, knownAnswers: K }));
    expect(error.code).toBe('contract'); expect(error.counts.attempts).toBe(1);
    expect(K.size).toBe(0); expect(JSON.stringify(H)).toBe(before);
  });
  it('rejects injected NaN without clamping or retry', async () => {
    const response = { answers: { ...V1.answers, call_t2: { noul: NaN }, result_t2: { noul: 0.5 } } }, K = new Map<string, CallAnswer>();
    const error = await rejection(compact(H, { ask: async () => response }, { ...O, knownAnswers: K }));
    expect(error.code).toBe('contract'); expect(error.counts).toMatchObject({ attempts: 1, retries: 0 }); expect(K.size).toBe(0);
  });
  it('inherited requested answer', async () => {
    const answers = Object.assign(Object.create({ call_t2: { noul: 0.5 } }), V1.answers, { result_t2: { noul: 0.5 } });
    const K = new Map<string, CallAnswer>();
    const error = await rejection(compact(H, { ask: async () => ({ answers }) }, { ...O, knownAnswers: K }));
    expect(error.code).toBe('contract'); expect(K.size).toBe(0);
  });
  it('rejects a batch without any complete pair', async () => {
    const K = new Map<string, CallAnswer>();
    const error = await rejection(compact(H1, { ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }) }, { ...O, knownAnswers: K }));
    expect(error).toMatchObject({ code: 'contract', contractKind: 'no_complete_pair' }); expect(K.size).toBe(0);
  });
  it('rejects empty answers as a contract failure', async () => {
    const K = new Map<string, CallAnswer>();
    const error = await rejection(compact(H1, { ask: async () => ({ answers: {} }) }, { ...O, knownAnswers: K }));
    expect(error.code).toBe('contract'); expect(error.counts).toMatchObject({ attempts: 1, retries: 0 }); expect(K.size).toBe(0);
  });
  it('ignores and never caches an unrequested question id', async () => {
    const response = { answers: { ...V1.answers, call_t999: { noul: 0.1 } } }, K = new Map<string, CallAnswer>();
    expect([...readBatchAnswers(response, [calls[0]!]).scored]).toEqual([['t1', score]]);
    const result = await compact(H1, { ask: async () => response }, { ...O, knownAnswers: K });
    expect(result.stats.jev).toMatchObject({ completion: 'complete', scoredCalls: 1, unscoredCalls: 0 });
    expect(result.decisions.map((decision) => decision.id)).toEqual(['t1']); expect([...K]).toEqual([['r1', score]]);
  });
  it('salvages a valid neighbor when transient attempts are exhausted', async () => {
    const K = new Map<string, CallAnswer>();
    const asker: JevAsker = { async ask(_state, q) { if ('call_t1' in q) return V1; throw new JevHttpError(503); } };
    const pending = compact(H, asker, { ...O, knownAnswers: K, maxRequestTokens, maxConcurrentJevRequests: 2, maxJevAttempts: 2 });
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.stats.requests).toBe(2);
    expect(result.stats.jev).toEqual({ completion: 'partial', terminalCode: 'http_5xx', attempts: 3, retries: 1, parsed: 1, scoredCalls: 1, unscoredCalls: 1 });
    expect([...K]).toEqual([['r1', score]]); assertUnscored(result);
  });
  it('preserves accepted pairs at the deadline without waiting for a hanging neighbor', async () => {
    const K = new Map<string, CallAnswer>(), signals: AbortSignal[] = [];
    const asker: JevAsker = { ask(_s, q, signal) {
      signals.push(signal!); return 'call_t1' in q ? new Promise((resolve) => setTimeout(() => resolve(V1), 20)) : new Promise(() => {});
    } };
    const pending = compact(H, asker, { ...O, knownAnswers: K, maxRequestTokens, maxConcurrentJevRequests: 2, compactionTimeoutMs: 1000 });
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.stats.jev).toEqual({ completion: 'partial', terminalCode: 'deadline', attempts: 2, retries: 0, parsed: 1, scoredCalls: 1, unscoredCalls: 1 });
    expect(signals).toHaveLength(2); expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect([...K]).toEqual([['r1', score]]); assertUnscored(result);
  });
  it('does not mutate a frozen snapshot after a late invalid answer', async () => {
    const K = new Map<string, CallAnswer>(), late = deferred<JevResponse>(), unhandled: unknown[] = [];
    const observer = (error: unknown) => { unhandled.push(error); }; process.on('unhandledRejection', observer);
    const write = vi.fn(async (_path: string, _text: string) => {}); let returned = 0;
    try {
      const asker: JevAsker = { ask(_s, q) { return 'call_t1' in q ? new Promise((resolve) => setTimeout(() => resolve(V1), 20)) : late.promise; } };
      // hooks/fast-jev.ts (offloadOutputs/toSessionMessages) is not ported (MERGE-MATRIX Q5 SKIP):
      // the factkeep case ran the result through the hook's offload post-processing; the frozen-view
      // guarantees under test live in the engine itself, so the raw engine result is observed directly.
      const pending = compact(H, asker, { ...O, knownAnswers: K, maxRequestTokens, maxConcurrentJevRequests: 2, compactionTimeoutMs: 1000 })
        .then(async (result) => {
          const messages = result.messages;
          returned++; return { result, messages };
        });
      await flush(); await vi.advanceTimersByTimeAsync(1000);
      const { result, messages } = await pending, S = result.stats.jev!;
      const statsBefore = JSON.stringify(S), cacheBefore = JSON.stringify([...K]), writesBefore = write.mock.calls.length;
      expect(Object.isFrozen(S)).toBe(true); expect(messages[4]).toBe(H[4]); expect(returned).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      late.resolve({ answers: { call_t2: { noul: 7 }, result_t2: { noul: 0.1 } } });
      await flush(); await vi.advanceTimersByTimeAsync(0);
      expect(JSON.stringify(S)).toBe(statsBefore); expect(JSON.stringify([...K])).toBe(cacheBefore);
      expect(write).toHaveBeenCalledTimes(writesBefore); expect(returned).toBe(1); expect(unhandled).toEqual([]);
    } finally { process.removeListener('unhandledRejection', observer); }
  });
  it('rolls back accepted neighbors on a fatal contract failure', async () => {
    const K = new Map<string, CallAnswer>(), signals: AbortSignal[] = [];
    const asker: JevAsker = { ask(_s, q, signal) {
      signals.push(signal!); return new Promise((resolve) => setTimeout(() => resolve('call_t1' in q ? V1 : { answers: [] } as unknown as JevResponse), 'call_t1' in q ? 20 : 30));
    } };
    const failure = rejection(compact(H, asker, { ...O, knownAnswers: K, maxRequestTokens, maxConcurrentJevRequests: 2 }));
    await flush(); await vi.advanceTimersByTimeAsync(30);
    expect((await failure).code).toBe('contract'); expect(K.size).toBe(0); expect(signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(10000); expect(signals).toHaveLength(2);
    const sent: string[] = [];
    const queued = rejection(runRoundJobs({ ask: async (_s, q) => { const key = Object.keys(q)[0]!; sent.push(key); return { answers: [] } as unknown as JevResponse; } }, syntheticJobs(3), { ...O, maxConcurrentJevRequests: 1 }));
    expect((await queued).code).toBe('contract'); expect(sent).toEqual(['call_t1']);
  });
  it('rolls back partial pairs under the explicit rollback policy', async () => {
    const K = new Map<string, CallAnswer>(), before = JSON.stringify(H);
    const error = await rejection(compact(H, { ask: async () => ({ answers: { ...V1.answers, call_t2: { noul: 0.7 } } }) }, { ...O, knownAnswers: K, partialAnswers: 'rollback' }));
    expect(error).toMatchObject({ code: 'contract', contractKind: 'incomplete_pair' });
    expect(K.size).toBe(0); expect(JSON.stringify(H)).toBe(before);
  });
  it('limits fan-out and returns results in job index order', async () => {
    const explicitJobs = syntheticJobs(5), sendOrder: number[] = []; let inFlight = 0, peak = 0;
    const replies = explicitJobs.map(() => deferred<JevResponse>()), asked: JevQuestions[] = [];
    const asker: JevAsker = { ask(_s, q) {
      const index = Number(Object.keys(q)[0]!.slice('call_t'.length)) - 1;
      sendOrder.push(index); asked[index] = q; inFlight++; peak = Math.max(peak, inFlight);
      return replies[index]!.promise.then((response) => { inFlight--; return response; });
    } };
    const pending = runRoundJobs(asker, explicitJobs, { ...O, maxConcurrentJevRequests: 2, maxJevAttempts: 1 });
    await flush(); expect(sendOrder).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(10);
    replies[1]!.resolve(answerFor(asked[1]!)); replies[0]!.resolve(answerFor(asked[0]!)); await flush();
    expect(sendOrder).toEqual([0, 1, 2, 3]);
    await vi.advanceTimersByTimeAsync(10);
    replies[3]!.resolve(answerFor(asked[3]!)); replies[2]!.resolve(answerFor(asked[2]!)); await flush();
    expect(sendOrder).toEqual([0, 1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(10);
    replies[4]!.resolve(answerFor(asked[4]!));
    const result = await pending;
    expect(peak).toBe(2); expect(result.stats).toMatchObject({ completion: 'complete', attempts: 5 });
    expect(result.answers.map((map) => [...map.keys()])).toEqual([['t1'], ['t2'], ['t3'], ['t4'], ['t5']]);
  });
  it('never sends queued jobs after the deadline', async () => {
    const sent: number[] = [];
    const failure = rejection(runRoundJobs({ ask: (_s, q) => { sent.push(Number(Object.keys(q)[0]!.slice('call_t'.length)) - 1); return new Promise(() => {}); } }, syntheticJobs(3), { ...O, maxConcurrentJevRequests: 1, compactionTimeoutMs: 1000 }));
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    const error = await failure;
    expect(error.code).toBe('deadline'); expect(error.counts.attempts).toBe(1); expect(sent).toEqual([0]);
  });
  it('starts no round or timer when all answers are cached', async () => {
    const K = new Map<string, CallAnswer>([['r1', score]]), before = JSON.stringify([...K]), ask = vi.fn<JevAsker['ask']>();
    const result = await compact(H1, { ask }, { ...O, knownAnswers: K });
    expect(ask).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(result.stats.requests).toBe(0); expect(result.stats).not.toHaveProperty('jev'); expect(JSON.stringify([...K])).toBe(before);
  });
  it('asks only previously unscored calls in the next round', async () => {
    const K = new Map<string, CallAnswer>();
    await compact(H, { ask: async () => ({ answers: { ...V1.answers, call_t2: { noul: 0.7 } } }) }, { ...O, knownAnswers: K });
    expect([...K.keys()]).toEqual(['r1']);
    const ask = vi.fn<JevAsker['ask']>(async () => V2);
    await compact(H, { ask }, { ...O, knownAnswers: K });
    expect(ask).toHaveBeenCalledOnce(); expect(Object.keys(ask.mock.calls[0]![1])).toEqual(['call_t2', 'result_t2']);
    expect([...K]).toEqual([['r1', score], ['r2', score]]);
  });
});

describe('R2 scheduler controls', () => {
  it('preserves explicit rollback for a terminal unknown neighbor failure', async () => {
    const K = new Map<string, CallAnswer>([['older', score]]), before = JSON.stringify([...K]), history = JSON.stringify(H);
    const asker: JevAsker = { async ask(_s, q) { if ('call_t1' in q) return V1; throw new Error('batch failed'); } };
    const error = await rejection(compact(H, asker, { ...O, knownAnswers: K, maxRequestTokens, partialAnswers: 'rollback' }));
    expect(error.code).toBe('unknown'); expect(error.counts).toMatchObject({ attempts: 2, retries: 0 });
    expect(JSON.stringify([...K])).toBe(before); expect(JSON.stringify(H)).toBe(history); expect(vi.getTimerCount()).toBe(0);
  });
  it('freezes answer views, values and stats without exposing a mutable backing map', async () => {
    const snapshot = await runRoundJobs({ ask: async () => V1 }, [jobs[0]!], O), map = snapshot.answers[0]!;
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.answers)).toBe(true);
    expect(Object.isFrozen(map)).toBe(true); expect(Object.isFrozen(map.get('t1'))).toBe(true); expect(Object.isFrozen(snapshot.stats)).toBe(true);
    expect(map).not.toHaveProperty('set'); expect(map.has('t1')).toBe(true); expect([...map.entries()]).toEqual([['t1', score]]);
    expect([...map.values()]).toEqual([score]);
    map.forEach((value, key, observed) => { expect(observed).toBe(map); expect(key).toBe('t1'); expect(value).toEqual(score); });
  });
  it('holds a worker slot throughout retry sleep', async () => {
    const sent: string[] = []; let attempts = 0;
    const asker: JevAsker = { async ask(_s, q) { const id = Object.keys(q)[0]!; sent.push(id); if (id === 'call_t1' && ++attempts === 1) throw new JevHttpError(503); return answerFor(q); } };
    const pending = runRoundJobs(asker, jobs, { ...O, maxConcurrentJevRequests: 1 });
    await flush(); expect(sent).toEqual(['call_t1']); await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).stats.completion).toBe('complete'); expect(sent).toEqual(['call_t1', 'call_t1', 'call_t2']);
  });
  it('uses stable terminal precedence independently of arrival order', async () => {
    const asker: JevAsker = { async ask(_s, q) { if ('call_t1' in q) return V1; if ('call_t2' in q) throw new JevHttpError(503); throw new JevHttpError(401); } };
    const result = await runRoundJobs(asker, syntheticJobs(3), { ...O, maxJevAttempts: 1 });
    expect(result.stats).toEqual({ completion: 'partial', terminalCode: 'http_4xx', attempts: 3, retries: 0, parsed: 1, scoredCalls: 1, unscoredCalls: 2 });
  });
  it('rechecks closure after an awaited send clock returns late', async () => {
    const clock = deferred<number>(); let reads = 0;
    const ask = vi.fn<JevAsker['ask']>();
    const failure = rejection(runRoundJobs({ ask }, [jobs[0]!], { ...O, compactionTimeoutMs: 1000, nowMs: async () => ++reads < 3 ? 0 : clock.promise }));
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    const error = await failure; expect(error.code).toBe('deadline'); expect(error.counts.attempts).toBe(0);
    clock.resolve(0); await flush(); expect(ask).not.toHaveBeenCalled();
  });
  it('blocks sends on a forward clock jump', async () => {
    let reads = 0; const ask = vi.fn<JevAsker['ask']>();
    const error = await rejection(runRoundJobs({ ask }, [jobs[0]!], { ...O, nowMs: async () => ++reads === 1 ? 0 : 10000 }));
    expect(error.code).toBe('deadline'); expect(ask).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not extend the timer after a backward clock jump', async () => {
    let reads = 0; const ask = vi.fn<JevAsker['ask']>(() => new Promise(() => {}));
    const failure = rejection(runRoundJobs({ ask }, [jobs[0]!], { ...O, compactionTimeoutMs: 1000, nowMs: async () => ++reads === 1 ? 0 : -1000 }));
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect((await failure).code).toBe('deadline'); expect(ask).toHaveBeenCalledOnce();
  });
  it('does not cache fresh pairs when rails construction fails', async () => {
    const K = new Map<string, CallAnswer>(); let answered = false;
    const broken = H1.map((message) => ({ ...message }));
    const input = { get file_path() { if (answered) throw new Error('rails failed'); return 'a.txt'; } };
    broken[1] = { ...broken[1]!, toolUses: [{ ...broken[1]!.toolUses[0]!, input }] };
    await expect(compact(broken, { ask: async () => { answered = true; return V1; } }, { ...O, knownAnswers: K })).rejects.toThrow('rails failed');
    expect(K.size).toBe(0);
  });
  it('does not count cache, pinned or floor provenance as fresh', async () => {
    const K = new Map<string, CallAnswer>([['r1', score]]);
    const result = await compact(H, { ask: async () => V2 }, { ...O, knownAnswers: K });
    expect(result.stats.jev).toMatchObject({ attempts: 1, scoredCalls: 1, unscoredCalls: 0 });
    const floor = await compact(H, { ask: async () => { throw new Error('must not send'); } }, { ...O, maxStateTokens: 1 });
    expect(floor.stats.requests).toBe(0); expect(floor.stats).not.toHaveProperty('jev');
    expect(floor.decisions.every((decision) => decision.reason !== 'unscored')).toBe(true);
  });
  it('counts parsed partial responses without retrying or merging half pairs', async () => {
    const K = new Map<string, CallAnswer>([['unrelated', score]]);
    const result = await compact(H, { ask: async () => ({ answers: { ...V1.answers, result_t2: { noul: 0 } } }) }, { ...O, knownAnswers: K });
    expect(result.stats.jev).toMatchObject({ parsed: 1, attempts: 1, retries: 0, scoredCalls: 1, unscoredCalls: 1 });
    expect([...K]).toEqual([['unrelated', score], ['r1', score]]); assertUnscored(result);
  });
});
