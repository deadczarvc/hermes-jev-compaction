import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  collectToolCalls, compact, estimateTokens, fitState, isRetryableJevError, JevClient, JevConfigError, JevContractError, JevHttpError,
  JevNetworkError, JevRoundError, parseJevResponse, parseRetryAfter, questionsFor, resolveOptions, runRoundJobs,
} from '../src/index.js';
import type { CallAnswer, CompactOptions, JevAsker, JevResponse, Message, ToolCall } from '../src/index.js';

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
const O = { preserveRecentMessages: 1, minReduction: 0, compactionTimeoutMs: 10000 };
const calls = collectToolCalls(H, 1);
const maxRequestTokens = fitState(H, calls, resolveOptions(O)).tokens + 20 + Math.max(...calls.map((c) => estimateTokens(JSON.stringify(questionsFor(c)))));
const state = { context: 'ctx', goal: 'g', history: [] };
const call: ToolCall = { id: 't1', tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a.txt' }, callIndex: 1, resultIndex: 2, resultChars: 5000, isError: false, pinned: false };
const V1: JevResponse = { answers: { call_t1: { noul: 0.1 }, result_t1: { noul: 0.1 } } };
const jobs = [{ state, batch: [call] }];
const score = { keepCall: 0.1, keepResult: 0.1 };

async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function sleep(ms: number, { signal }: { signal: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
function script(responses: readonly (JevResponse | Error)[]) {
  const sendAt: number[] = [], sleeps: number[] = [];
  const ask = vi.fn<JevAsker['ask']>(async () => {
    sendAt.push(Date.now());
    const response = responses[sendAt.length - 1];
    if (!response) throw new Error('Unexpected extra attempt');
    if (response instanceof Error) throw response;
    return response;
  });
  const options = { ...O, maxJevAttempts: 3, nowMs: async () => Date.now(), retrySleep: (ms: number, opts: { signal: AbortSignal }) => { sleeps.push(ms); return sleep(ms, opts); } };
  return { asker: { ask }, ask, sendAt, sleeps, options };
}
async function rejection(pending: Promise<unknown>): Promise<JevRoundError> {
  const error = await pending.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(JevRoundError);
  return error as JevRoundError;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('R2 bounded retries', () => {
  it('succeeds without retry', async () => {
    const s = script([V1]);
    const result = await runRoundJobs(s.asker, jobs, s.options);
    expect(result.stats).toEqual({ completion: 'complete', terminalCode: 'none', attempts: 1, retries: 0, parsed: 1, scoredCalls: 1, unscoredCalls: 0 });
    expect(s.sendAt).toEqual([0]); expect(s.sleeps).toEqual([]);
  });
  it('retries 429 then succeeds', async () => {
    const s = script([new JevHttpError(429), V1]);
    const pending = runRoundJobs(s.asker, jobs, s.options);
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).stats).toMatchObject({ completion: 'complete', terminalCode: 'none', attempts: 2, retries: 1 });
    expect(s.sendAt).toEqual([0, 1000]); expect(s.sleeps).toEqual([1000]);
  });
  it('retries 500 then succeeds', async () => {
    const s = script([new JevHttpError(500), V1]);
    const pending = runRoundJobs(s.asker, jobs, s.options);
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).stats).toMatchObject({ completion: 'complete', attempts: 2 });
    expect(s.sendAt).toEqual([0, 1000]);
  });
  it('retries a typed network failure then caches success', async () => {
    const s = script([new JevNetworkError(), V1]), K = new Map<string, CallAnswer>();
    const pending = compact(H1, s.asker, { ...s.options, knownAnswers: K });
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).stats.jev).toMatchObject({ completion: 'complete', attempts: 2 });
    expect(s.sleeps).toEqual([1000]); expect([...K]).toEqual([['r1', score]]);
  });
  it('native cause ECONNRESET', async () => {
    const first = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(first).mockResolvedValue(new Response(JSON.stringify(V1)));
    const client = new JevClient({ apiKey: 'fixture', fetch: fetcher });
    await expect(client.ask(state, {})).rejects.toBeInstanceOf(JevNetworkError);
    fetcher.mockReset().mockRejectedValueOnce(first).mockResolvedValue(new Response(JSON.stringify(V1)));
    const pending = compact(H1, client, O);
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).stats.jev).toMatchObject({ completion: 'complete', attempts: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not infer network errors from messages', async () => {
    const s = script([new Error('network (503)')]), K = new Map<string, CallAnswer>();
    const error = await rejection(compact(H1, s.asker, { ...s.options, knownAnswers: K }));
    expect(error.code).toBe('unknown'); expect(error.counts).toMatchObject({ attempts: 1, retries: 0 });
    expect(s.sleeps).toEqual([]); expect(K.size).toBe(0);
  });
  it('does not retry 401', async () => {
    const s = script([new JevHttpError(401)]), K = new Map<string, CallAnswer>();
    const error = await rejection(compact(H1, s.asker, { ...s.options, knownAnswers: K }));
    expect(error.code).toBe('http_4xx'); expect(error.counts).toMatchObject({ attempts: 1, retries: 0 });
    expect(s.sleeps).toEqual([]); expect(K.size).toBe(0);
  });
  it('does not retry or expose a 403 HTML body', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('<html>denied</html>', { status: 403 }));
    const error = await rejection(compact(H1, new JevClient({ apiKey: 'fixture', fetch: fetcher }), O));
    expect(fetcher).toHaveBeenCalledOnce(); expect(error.code).toBe('http_4xx');
    expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(/<html>|denied/);
  });
  it('does not retry malformed JSON', async () => {
    const K = new Map<string, CallAnswer>();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{'));
    const error = await rejection(compact(H1, new JevClient({ apiKey: 'fixture', fetch: fetcher }), { ...O, knownAnswers: K }));
    expect(error.code).toBe('contract'); expect(error.message).toContain('Jev returned malformed JSON');
    expect(fetcher).toHaveBeenCalledOnce(); expect(K.size).toBe(0);
  });
  it('does not retry a broken envelope', async () => {
    const K = new Map<string, CallAnswer>();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"answers":[]}'));
    const error = await rejection(compact(H1, new JevClient({ apiKey: 'fixture', fetch: fetcher }), { ...O, knownAnswers: K }));
    expect(error.code).toBe('contract'); expect(error.message).toContain('Jev response is missing answers');
    expect(fetcher).toHaveBeenCalledOnce(); expect(K.size).toBe(0);
  });
  it('starts exactly N attempts including the first', async () => {
    const s = script([new JevHttpError(503), new JevHttpError(429), new JevHttpError(503), V1]);
    const failure = rejection(runRoundJobs(s.asker, jobs, s.options));
    await flush(); await vi.advanceTimersByTimeAsync(3000);
    const error = await failure;
    expect(error.code).toBe('http_5xx'); expect(error.counts).toMatchObject({ attempts: 3, retries: 2 });
    expect(s.sendAt).toEqual([0, 1000, 3000]); expect(s.sleeps).toEqual([1000, 2000]); expect(s.ask).toHaveBeenCalledTimes(3);
  });
  it('disables retry at N equals one', async () => {
    const s = script([new JevHttpError(503), V1]);
    const error = await rejection(runRoundJobs(s.asker, jobs, { ...s.options, maxJevAttempts: 1 }));
    expect(error.code).toBe('http_5xx'); expect(error.counts.attempts).toBe(1);
    expect(s.ask).toHaveBeenCalledOnce(); expect(s.sleeps).toEqual([]);
  });
  it('rejects N equals zero before IO', () => {
    const ask = vi.fn<JevAsker['ask']>();
    expect(() => resolveOptions({ maxJevAttempts: 0 })).toThrow(RangeError);
    expect(ask).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('Retry-After seconds', async () => {
    const retryAfterMs = parseRetryAfter({ 'ReTrY-AfTeR': '2' }, 0);
    const s = script([new JevHttpError(429, retryAfterMs), V1]);
    const pending = runRoundJobs(s.asker, jobs, s.options);
    await flush(); await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).stats.completion).toBe('complete');
    expect(s.sleeps).toEqual([2000]); expect(s.sendAt).toEqual([0, 2000]);
  });
  it('Retry-After HTTP date', () => {
    expect(parseRetryAfter({ 'retry-after': 'Thu, 01 Jan 1970 00:00:02 GMT' }, 0)).toBe(2000);
  });
  it('Retry-After invalid', async () => {
    const retryAfterMs = parseRetryAfter({ 'retry-after': 'later' }, 0);
    expect(retryAfterMs).toBeUndefined();
    const s = script([new JevHttpError(429, retryAfterMs), V1]);
    const pending = runRoundJobs(s.asker, jobs, s.options);
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).stats.attempts).toBe(2); expect(s.sleeps).toEqual([1000]);
  });
  it('does not shorten a 31 second Retry-After', async () => {
    const s = script([new JevHttpError(429, parseRetryAfter({ 'retry-after': '31' }, 0))]);
    const error = await rejection(runRoundJobs(s.asker, jobs, { ...s.options, compactionTimeoutMs: 100000 }));
    expect(error.code).toBe('rate_limited'); expect(error.counts.attempts).toBe(1); expect(s.sleeps).toEqual([]);
  });
  it('does not sleep when delay equals the remaining budget', async () => {
    const s = script([new JevHttpError(503)]);
    const error = await rejection(runRoundJobs(s.asker, jobs, { ...s.options, compactionTimeoutMs: 1000 }));
    expect(error.code).toBe('deadline'); expect(error.counts.attempts).toBe(1);
    expect(s.sleeps).toEqual([]); expect(s.sendAt).toEqual([0]);
  });
  it('closes at the deadline during an abort-ignorant retry sleep', async () => {
    const s = script([new JevHttpError(503), V1]), K = new Map<string, CallAnswer>();
    let signal: AbortSignal | undefined;
    const failure = rejection(compact(H1, s.asker, { ...s.options, knownAnswers: K, compactionTimeoutMs: 1500,
      retrySleep: (_ms, opts) => { signal = opts.signal; return new Promise((resolve) => setTimeout(resolve, 2000)); },
    }));
    await flush(); await vi.advanceTimersByTimeAsync(1500);
    const error = await failure;
    expect(error.code).toBe('deadline'); expect(error.counts.attempts).toBe(1); expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.sendAt).toEqual([0]); expect(K.size).toBe(0);
  });
  it('native hanging error body', async () => {
    const response = new Response('unavailable', { status: 503 });
    const text = vi.spyOn(response, 'text').mockReturnValue(new Promise(() => {}));
    const cancel = vi.spyOn(response.body!, 'cancel').mockRejectedValue(new Error('cancel failed'));
    const sendAt: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => { sendAt.push(Date.now()); return sendAt.length === 1 ? response : new Response(JSON.stringify(V1)); });
    const pending = compact(H1, new JevClient({ apiKey: 'fixture', fetch: fetcher }), O);
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).stats.jev?.completion).toBe('complete');
    expect(text).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2); expect(sendAt).toEqual([0, 1000]);
  });
});

describe('R2 transport controls', () => {
  it('preserves canonical missing-key diagnostics without HTTP or retry', async () => {
    const fetcher = vi.fn<typeof fetch>(), client = new JevClient({ apiKey: '', fetch: fetcher }), K = new Map<string, CallAnswer>();
    await expect(client.ask(state, {})).rejects.toBeInstanceOf(JevConfigError);
    const error = await rejection(compact(H1, client, { ...O, knownAnswers: K }));
    expect(error.code).toBe('unknown'); expect(error.message).toBe('TYPESAFE_API_KEY is not configured');
    expect(error.counts).toMatchObject({ attempts: 1, retries: 0 }); expect(fetcher).not.toHaveBeenCalled(); expect(K.size).toBe(0);
  });
  it('treats typed configuration failures as fatal to accepted neighbors', async () => {
    const K = new Map<string, CallAnswer>(), history = JSON.stringify(H), signals: AbortSignal[] = [];
    const asker: JevAsker = { ask(_s, q, signal) { signals.push(signal!); return new Promise((resolve, reject) => setTimeout(() => {
      if ('call_t1' in q) resolve(V1); else reject(new JevConfigError('api_key'));
    }, 'call_t1' in q ? 20 : 30)); } };
    const failure = rejection(compact(H, asker, { ...O, knownAnswers: K, maxRequestTokens, maxConcurrentJevRequests: 2 }));
    await flush(); await vi.advanceTimersByTimeAsync(30);
    const error = await failure;
    expect(error.code).toBe('unknown'); expect(error.message).toBe('TYPESAFE_API_KEY is not configured');
    expect(K.size).toBe(0); expect(JSON.stringify(H)).toBe(history); expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('does not reclassify a request-builder exception with a network-shaped cause', async () => {
    const fetcher = vi.fn<typeof fetch>(), client = new JevClient({ apiKey: 'fixture', fetch: fetcher });
    const broken = { toJSON() { throw new TypeError('payload must not escape', { cause: { code: 'ECONNRESET' } }); } };
    const error = await client.ask(broken, {}).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(JevConfigError); expect(error).toMatchObject({ kind: 'request' });
    expect(String(error)).not.toContain('payload must not escape'); expect(fetcher).not.toHaveBeenCalled();
    expect(() => new JevClient({ apiKey: 'fixture', baseUrl: 'http://invalid.example.test/' })).toThrow(JevConfigError);
  });
  it('retries only typed 429, integer 5xx and network failures', () => {
    const controller = new AbortController();
    for (const status of [429, 500, 501, 502, 503, 504, 599]) expect(isRetryableJevError(new JevHttpError(status), controller.signal)).toBe(true);
    for (const status of [301, 401, 403, 499, 500.5, 600]) expect(isRetryableJevError(new JevHttpError(status), controller.signal)).toBe(false);
    expect(isRetryableJevError(new JevNetworkError(), controller.signal)).toBe(true);
    expect(isRetryableJevError(new JevContractError('json'), controller.signal)).toBe(false);
    expect(isRetryableJevError(new Error('network 503'), controller.signal)).toBe(false);
    controller.abort(); expect(isRetryableJevError(new JevNetworkError(), controller.signal)).toBe(false);
  });
  it('validates every explicitly supplied retry option without rounding', async () => {
    for (const value of [-1, 0, 1.5, 5, NaN, Infinity]) expect(() => resolveOptions({ maxJevAttempts: value })).toThrow(RangeError);
    for (const value of [-1, 0, 1.5, 9, NaN, Infinity]) expect(() => resolveOptions({ maxConcurrentJevRequests: value })).toThrow(RangeError);
    for (const partialAnswers of ['keep', false, null]) expect(() => resolveOptions({ partialAnswers } as unknown as CompactOptions)).toThrow(RangeError);
    for (const retrySleep of [false, 1, null]) expect(() => resolveOptions({ retrySleep } as unknown as CompactOptions)).toThrow(RangeError);
    expect(() => resolveOptions({ nowMs: null } as unknown as CompactOptions)).toThrow(RangeError);
    const ask = vi.fn<JevAsker['ask']>();
    await expect(compact(H1, { ask }, { maxJevAttempts: 0 })).rejects.toBeInstanceOf(RangeError);
    expect(ask).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(resolveOptions()).toMatchObject({ maxJevAttempts: 3, maxConcurrentJevRequests: 4, partialAnswers: 'retain-unscored', compactionTimeoutMs: 120000 });
  });
  it('uses the fourth attempt only after 1000, 2000 and 4000 ms', async () => {
    const s = script([new JevHttpError(503), new JevHttpError(503), new JevHttpError(503), V1]);
    const pending = runRoundJobs(s.asker, jobs, { ...s.options, maxJevAttempts: 4 });
    await flush(); await vi.advanceTimersByTimeAsync(7000);
    expect((await pending).stats).toMatchObject({ attempts: 4, retries: 3, completion: 'complete' });
    expect(s.sendAt).toEqual([0, 1000, 3000, 7000]); expect(s.sleeps).toEqual([1000, 2000, 4000]);
  });
  it('rejects unsafe or non-IMF Retry-After values and preserves excessive waits', () => {
    for (const value of ['', '-1', '1.5', '1e3', 'tomorrow', '2026-01-01', 'Fri, 30 Feb 2024 00:00:00 GMT']) expect(parseRetryAfter({ 'retry-after': value }, 0)).toBeUndefined();
    expect(parseRetryAfter({ 'retry-after': 'Thu, 01 Jan 1970 00:00:00 GMT' }, 1)).toBe(0);
    expect(parseRetryAfter({ 'retry-after': '999999999999999999999999999' }, 0)).toBeGreaterThan(30000);
    expect(parseJevResponse(200, true, JSON.stringify(V1), new Headers())).toEqual(V1);
  });
  it('does not classify TLS or unknown TypeErrors as network failures', async () => {
    for (const error of [new TypeError('fetch failed'), new TypeError('network', { cause: { code: 'CERT_HAS_EXPIRED' } })]) {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
      await expect(new JevClient({ apiKey: 'fixture', fetch: fetcher }).ask(state, {})).rejects.toBe(error);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('observes two identical loopback requests for 503 then 200', async () => {
    vi.useRealTimers();
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        bodies.push(body); response.writeHead(bodies.length === 1 ? 503 : 200, { 'content-type': 'application/json' });
        response.end(bodies.length === 1 ? 'unavailable' : JSON.stringify(V1));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new JevClient({ provider: 'custom', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/systemone` });
      const result = await compact(H1, client, O);
      expect(result.stats.jev).toMatchObject({ attempts: 2, retries: 1, completion: 'complete' });
      expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it('poisons loopback HTTP 200 with malformed JSON and observes only one request', async () => {
    vi.useRealTimers(); let requests = 0;
    const server = createServer((request, response) => { requests++; request.resume(); response.writeHead(200); response.end('{'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new JevClient({ provider: 'custom', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/systemone` });
      expect((await rejection(compact(H1, client, O))).code).toBe('contract'); expect(requests).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
