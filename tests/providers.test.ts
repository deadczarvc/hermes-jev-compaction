import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildJevRequest, compactMessages, JevClient, noulAnswer, parseJevResponse,
  requireJevApiKey, resolveJevEndpoint, selectJevApiKey,
  type JevAnswer, type JevClientOptions, type JevProviderOptions, type JevResponse,
  type Message,
} from '../src/index.js';

// forgetAnswers() from the factkeep hooks/fast-jev.ts is not ported (MERGE-MATRIX Q5 SKIP):
// the hermes engine has no module-global answer cache — knownAnswers is a per-call
// compact option (src/types.ts), so there is no cross-test state to reset.

const T = 'https://api.typesafe.ai/v1/systemone';
const O = 'https://openrouter.ai/api/v1/systemone';
const V = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const KT = 'fixtureTypeSafe';
const KO = 'fixtureOpenRouter';
const KV = 'fixtureGateway';
const Q = { q: { type: 'noul' as const, instructions: 'keep?' } };
const S = { history: [] };
const R = { answers: { q: { type: 'noul' as const, noul: 0.98 } } };
const E = resolveJevEndpoint;
const K = selectJevApiKey;
const keyNames = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY'] as const;
type Env = Partial<Record<(typeof keyNames)[number], string>>;
type Trace = { url: string; init?: RequestInit };
type Reply = JevResponse | { status: number; ok: boolean; text: string };

function isolateEnv(env: Env): void {
  for (const key of keyNames) vi.stubEnv(key, env[key]);
}

function C(options: JevClientOptions, env: Env, reply: Reply) {
  isolateEnv(env);
  const trace: Trace[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    trace.push({ url: String(url), init });
    return 'answers' in reply
      ? new Response(JSON.stringify(reply), { status: 200 })
      : new Response(reply.text, { status: reply.status });
  });
  const response = new JevClient({ ...options, fetch: fetcher }).ask(S, Q);
  return { response, trace, fetcher };
}

beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('approved provider policy table', () => {
  it('default endpoint ⇒ TypeSafe tuple', () => {
    const result = E({});
    expect(result).toEqual({ provider: 'typesafe', baseUrl: T, model: 'jev-latest', keyEnv: 'TYPESAFE_API_KEY', thirdParty: false });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('ambient keys ⇒ no provider inference', () => {
    const endpoint = E({});
    expect(K(endpoint, undefined, { TYPESAFE_API_KEY: KT, OPENROUTER_API_KEY: KO, AI_GATEWAY_API_KEY: KV })).toBe(KT);
    expect(endpoint.baseUrl).toBe(T);
  });

  it('only Gateway key ⇒ no TypeSafe key', () => {
    const endpoint = E({});
    expect(K(endpoint, undefined, { AI_GATEWAY_API_KEY: KV })).toBeUndefined();
    expect(endpoint.provider).toBe('typesafe');
  });

  it('string consent ⇒ invalid option', () => {
    expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: 'true' } as unknown as JevProviderOptions))
      .toThrow('allowThirdPartyEgress must be a boolean');
  });

  it('OpenRouter consent ⇒ compatible tuple', () => {
    expect(E({ provider: 'openrouter', allowThirdPartyEgress: true })).toEqual({
      provider: 'openrouter', baseUrl: O, model: 'jev-latest', keyEnv: 'OPENROUTER_API_KEY', thirdParty: true,
    });
  });

  it('Gateway consent ⇒ compatible tuple', () => {
    expect(E({ provider: 'vercel', allowThirdPartyEgress: true })).toEqual({
      provider: 'vercel', baseUrl: V, model: 'typesafe-ai/jev', keyEnv: 'AI_GATEWAY_API_KEY', thirdParty: true,
    });
  });

  it('unknown provider ⇒ no guessed alias', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(() => E({ provider: 'gateway', allowThirdPartyEgress: true } as unknown as JevProviderOptions)).toThrow('Unknown Jev provider');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('OpenRouter provider with TypeSafe URL ⇒ mismatch', () => {
    expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, baseUrl: T })).toThrow('baseUrl does not match selected Jev provider');
  });

  it('baseUrl alone ⇒ no new provider opt-in', () => {
    expect(() => E({ baseUrl: O })).toThrow('baseUrl does not match selected Jev provider');
  });

  it('OpenRouter suffix impostor ⇒ mismatch', () => {
    expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, baseUrl: 'https://evilopenrouter.ai/api/v1/systemone' }))
      .toThrow('baseUrl does not match selected Jev provider');
  });

  it('OpenRouter query ⇒ mismatch', () => {
    expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, baseUrl: O + '?tenant=x' })).toThrow('baseUrl does not match selected Jev provider');
  });

  it('SDK OpenRouter prefix ⇒ not a full endpoint', () => {
    expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, baseUrl: 'https://openrouter.ai/api' }))
      .toThrow('baseUrl does not match selected Jev provider');
  });

  it('native Gateway endpoint ⇒ no dialect inference', () => {
    expect(() => E({ provider: 'vercel', allowThirdPartyEgress: true, baseUrl: 'https://ai-gateway.vercel.sh/v1/evaluate' }))
      .toThrow('baseUrl does not match selected Jev provider');
  });

  it('OpenRouter HTTP ⇒ unsafe URL', () => {
    expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, baseUrl: 'http://openrouter.ai/api/v1/systemone' }))
      .toThrow('baseUrl must be https:// or a loopback http:// URL');
  });

  it('userinfo ⇒ unsafe URL', () => {
    expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, baseUrl: 'https://u:p@openrouter.ai/api/v1/systemone' }))
      .toThrow('baseUrl must be https:// or a loopback http:// URL');
  });

  it('explicit pinned OpenRouter model ⇒ no rewrite', () => {
    expect(E({ provider: 'openrouter', allowThirdPartyEgress: true, model: 'typesafe/jev-1.13' }).model).toBe('typesafe/jev-1.13');
  });

  it('explicit wrong Gateway model ⇒ no implicit replacement', () => {
    expect(() => E({ provider: 'vercel', allowThirdPartyEgress: true, model: 'jev-latest' })).toThrow('Unsupported Jev model for selected provider');
  });

  it('empty explicit model ⇒ invalid model', () => {
    expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, model: '' })).toThrow('Unsupported Jev model for selected provider');
  });

  it('OpenRouter env ⇒ only OpenRouter key', () => {
    expect(K(E({ provider: 'openrouter', allowThirdPartyEgress: true }), undefined,
      { TYPESAFE_API_KEY: KT, OPENROUTER_API_KEY: KO, AI_GATEWAY_API_KEY: KV })).toBe(KO);
  });

  it('explicit key ⇒ wins over provider env', () => {
    expect(K(E({ provider: 'vercel', allowThirdPartyEgress: true }), 'fixtureExplicit', { AI_GATEWAY_API_KEY: KV })).toBe('fixtureExplicit');
  });

  it('empty explicit key ⇒ no ambient fallback', async () => {
    const run = C({ provider: 'openrouter', allowThirdPartyEgress: true, apiKey: '' }, { OPENROUTER_API_KEY: KO }, R);
    await expect(run.response).rejects.toThrow('OPENROUTER_API_KEY is not configured');
    expect(run.trace).toEqual([]);
  });

  it('TypeSafe key only ⇒ not sent to OpenRouter', async () => {
    const run = C({ provider: 'openrouter', allowThirdPartyEgress: true }, { TYPESAFE_API_KEY: KT }, R);
    await expect(run.response).rejects.toThrow('OPENROUTER_API_KEY is not configured');
    expect(run.trace).toEqual([]);
  });

  it('TypeSafe key only ⇒ not sent to Gateway', async () => {
    const run = C({ provider: 'vercel', allowThirdPartyEgress: true }, { TYPESAFE_API_KEY: KT }, R);
    await expect(run.response).rejects.toThrow('AI_GATEWAY_API_KEY is not configured');
    expect(run.trace).toEqual([]);
  });

  it('OpenRouter request ⇒ System One body', async () => {
    const run = C({ provider: 'openrouter', allowThirdPartyEgress: true }, { OPENROUTER_API_KEY: KO }, R);
    expect(await run.response).toEqual(R);
    expect(run.trace.map(({ url }) => url)).toEqual([O]);
    expect(run.trace[0]?.init?.method).toBe('POST');
    expect(run.trace[0]?.init?.headers).toEqual({ authorization: 'Bearer ' + KO, 'content-type': 'application/json' });
    expect(JSON.parse(String(run.trace[0]?.init?.body))).toEqual({ model: 'jev-latest', state: S, questions: Q });
  });

  it('Gateway request ⇒ noul not boolean', async () => {
    const run = C({ provider: 'vercel', allowThirdPartyEgress: true }, { AI_GATEWAY_API_KEY: KV }, R);
    expect(await run.response).toEqual(R);
    expect(run.trace.map(({ url }) => url)).toEqual([V]);
    expect(run.trace[0]?.init?.method).toBe('POST');
    expect(run.trace[0]?.init?.headers).toEqual({ authorization: 'Bearer ' + KV, 'content-type': 'application/json' });
    expect(JSON.parse(String(run.trace[0]?.init?.body))).toEqual({ model: 'typesafe-ai/jev', state: S, questions: Q });
  });

  it('active key in state ⇒ known mask', () => {
    const state = { memo: KO };
    const request = buildJevRequest({ apiKey: KO, baseUrl: O, model: 'jev-latest' }, state, Q);
    expect(JSON.parse(request.body)).toEqual({ model: 'jev-latest', state: { memo: '[REDACTED:known]' }, questions: Q });
    expect(state).toEqual({ memo: KO });
  });

  it('active key in question ⇒ known mask', () => {
    const request = buildJevRequest({ apiKey: KV, baseUrl: V, model: 'typesafe-ai/jev' }, S, { q: { type: 'noul', instructions: KV } });
    expect(JSON.parse(request.body).questions).toEqual({ q: { type: 'noul', instructions: '[REDACTED:known]' } });
  });

  it('compatible Gateway envelope ⇒ preserve usage and metadata', () => {
    const text = '{"model":"typesafe-ai/jev","answers":{"q":{"type":"noul","noul":0.98}},"usage":{"input_tokens":275,"output_tokens":20},"provider_metadata":{"gateway":{"cost":"0.00001155"}}}';
    const result = parseJevResponse(200, true, text);
    expect(result).toEqual(JSON.parse(text));
    expect(noulAnswer(result.answers, 'q')).toBe(0.98);
  });

  it('native boolean answer ⇒ contract error', () => {
    expect(() => noulAnswer({ q: { type: 'boolean', probability: 0.98 } } as unknown as Record<string, JevAnswer>, 'q')).toThrow('Invalid Jev answer for q');
  });

  it('noul above one ⇒ contract error', () => {
    expect(() => noulAnswer({ q: { type: 'noul', noul: 1.01 } }, 'q')).toThrow('Invalid Jev answer for q');
  });

  it('noul zero ⇒ accepted boundary', () => { expect(noulAnswer({ q: { type: 'noul', noul: 0 } }, 'q')).toBe(0); });
  it('noul one ⇒ accepted boundary', () => { expect(noulAnswer({ q: { type: 'noul', noul: 1 } }, 'q')).toBe(1); });

  it('custom remote without consent ⇒ deny', () => {
    expect(() => E({ provider: 'custom', baseUrl: 'https://jev.example.test/v1/systemone' })).toThrow('Third-party Jev egress is disabled');
  });

  it('custom loopback ⇒ explicit-key namespace only', () => {
    expect(E({ provider: 'custom', baseUrl: 'http://127.0.0.1:8321/v1/systemone' })).toEqual({
      provider: 'custom', baseUrl: 'http://127.0.0.1:8321/v1/systemone', model: 'jev-latest', keyEnv: null, thirdParty: false,
    });
  });

  it('custom without URL ⇒ no default recipient', () => {
    expect(() => E({ provider: 'custom' })).toThrow('baseUrl is required for custom provider');
  });

  it('custom ambient key ⇒ no credential', () => {
    const endpoint = E({ provider: 'custom', baseUrl: 'http://localhost:8321/v1/systemone' });
    const key = K(endpoint, undefined, { TYPESAFE_API_KEY: KT });
    expect(key).toBeUndefined();
    expect(() => requireJevApiKey(endpoint, key)).toThrow('apiKey is required for custom provider');
  });

  it('provider 401 ⇒ no cross-provider fallback', async () => {
    const run = C({ provider: 'openrouter', allowThirdPartyEgress: true }, { OPENROUTER_API_KEY: KO, TYPESAFE_API_KEY: KT }, { status: 401, ok: false, text: 'denied' });
    await expect(run.response).rejects.toThrow('Jev request failed (401)');
    expect(run.trace.map(({ url }) => url)).toEqual([O]);
  });

  it('aborted native signal ⇒ zero request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new JevClient({ provider: 'openrouter', allowThirdPartyEgress: true, apiKey: KO });
    const controller = new AbortController();
    controller.abort(new Error('cancelled before send'));
    await expect(client.ask(S, Q, controller.signal)).rejects.toThrow('cancelled before send');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('native 307 redirect ⇒ no second recipient', async () => {
    const sinkRequests: { authorization?: string; body: string }[] = [];
    const sink = createServer((request, response) => {
      const item = { authorization: request.headers.authorization, body: '' };
      sinkRequests.push(item);
      request.on('data', (data: Buffer) => { item.body += data.toString(); });
      request.on('end', () => { response.end(JSON.stringify(R)); });
    });
    let firstRequests = 0;
    const first = createServer((request, response) => {
      firstRequests++;
      request.resume();
      response.writeHead(307, { location: loopbackUrl(sink) + '/sink' });
      response.end();
    });
    try {
      await listen(sink);
      await listen(first);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const client = new JevClient({ provider: 'custom', apiKey: KT, baseUrl: loopbackUrl(first) + '/v1/systemone' });
      await expect(client.ask(S, Q)).rejects.toThrow(/fetch failed/i);
      expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe('error');
      expect(firstRequests).toBe(1);
      expect(sinkRequests).toEqual([]);
    } finally {
      await Promise.all([close(first), close(sink)]);
    }
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
}
function loopbackUrl(server: Server): string { return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => { server.close(() => resolve()); });
}

describe('provider policy boundary regressions', () => {
  it('rejects named endpoint normalization and unsupported model forms', () => {
    for (const baseUrl of [O + '/', O + '#fragment', 'https://openrouter.ai:443/api/v1/systemone', 'https://OPENROUTER.ai/api/v1/systemone']) {
      expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, baseUrl })).toThrow('baseUrl does not match selected Jev provider');
    }
    for (const model of ['', ' jev-latest', 'jev-latest\n', 'jev-x\u0000', 'jev-x\u0085', 'x'.repeat(129), 'other/jev-x']) {
      expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, model })).toThrow('Unsupported Jev model for selected provider');
    }
    expect(E({ provider: 'openrouter', allowThirdPartyEgress: true, model: '~typesafe/jev-latest' }).model).toBe('~typesafe/jev-latest');
  });

  it('reads only the selected credential namespace', () => {
    const read = vi.fn((key: string) => key === 'OPENROUTER_API_KEY' ? KO : undefined);
    const env = new Proxy({}, { get: (_target, key) => read(String(key)) });
    expect(K(E({ provider: 'openrouter', allowThirdPartyEgress: true }), undefined, env)).toBe(KO);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('OPENROUTER_API_KEY');
  });

  it('classifies custom loopback by the authority as written', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      for (const scheme of ['https', 'http']) {
        expect(E({ provider: 'custom', baseUrl: `${scheme}://${host}:8321/v1/systemone` }).thirdParty).toBe(false);
      }
    }
    for (const host of ['127.1', '2130706433', 'localhost.evil.test', '[::ffff:127.0.0.1]']) {
      expect(() => E({ provider: 'custom', baseUrl: `https://${host}/v1/systemone` })).toThrow('Third-party Jev egress is disabled');
    }
  });

  it('native loopback accepts the System One contract without redirecting', async () => {
    const trace: { method?: string; authorization?: string; body: string }[] = [];
    const server = createServer((request, response) => {
      const item = { method: request.method, authorization: request.headers.authorization, body: '' };
      trace.push(item);
      request.on('data', (chunk: Buffer) => { item.body += chunk.toString(); });
      request.on('end', () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(R)); });
    });
    try {
      await listen(server);
      const client = new JevClient({ provider: 'custom', apiKey: KT, baseUrl: loopbackUrl(server) + '/v1/systemone' });
      expect(await client.ask(S, Q)).toEqual(R);
      expect(trace).toHaveLength(1);
      expect(trace[0]?.method).toBe('POST');
      expect(trace[0]?.authorization).toBe('Bearer ' + KT);
      expect(JSON.parse(trace[0]!.body)).toEqual({ model: 'jev-latest', state: S, questions: Q });
    } finally { await close(server); }
  });

  it('compactMessages masks the selected key before fitting and never rereads it', async () => {
    isolateEnv({ OPENROUTER_API_KEY: KO, TYPESAFE_API_KEY: KT });
    const messages: Message[] = [
      { role: 'user', text: KO, toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: KO } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'x'.repeat(5000) }] },
      { role: 'user', text: 'continue', toolUses: [] },
    ];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = String(init?.body);
      expect(body).not.toContain(KO);
      expect(body).toContain('[REDACTED:known]');
      const payload = JSON.parse(body);
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(payload.questions).map((name) => [name, { noul: 0.98 }])) }));
    });
    await compactMessages(messages, { provider: 'openrouter', allowThirdPartyEgress: true, preserveRecentMessages: 1, minReduction: 0, fetch: fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(O);
    expect(messages[0]?.text).toBe(KO);
    await expect(compactMessages(messages, { provider: 'vercel', allowThirdPartyEgress: true, preserveRecentMessages: 1, minReduction: 0, fetch: fetcher })).rejects.toThrow('AI_GATEWAY_API_KEY is not configured');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
