import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDecisionsRequest, DECISIONS_MODEL, JevClient, OPENAI_DECISIONS_URL, parseDecisionsResponse,
  type JevQuestions,
} from '../src/index.js';

const D = OPENAI_DECISIONS_URL;
const KEY = 'fixtureOpenAiKey';
const Q: JevQuestions = { q: { type: 'noul', instructions: 'keep?' } };
const S = { history: [] };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('decisions wire: the request', () => {
  it('endpoint, headers, text input and a predicate question', () => {
    const request = buildDecisionsRequest({ apiKey: KEY, model: DECISIONS_MODEL, baseUrl: D }, S, Q);
    expect(request.url).toBe(D);
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({ authorization: 'Bearer ' + KEY, 'content-type': 'application/json' });
    const body = JSON.parse(request.body);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.input).toBe(JSON.stringify(S));
    expect(body.questions).toEqual([{ type: 'predicate', name: 'q', instructions: 'keep?' }]);
  });

  it('noul criteria fold into instructions, choice criteria become choices, score criteria become levels', () => {
    const questions: JevQuestions = {
      n: { type: 'noul', instructions: 'keep?', criteria: { true: 'it matters', false: 'it does not' } },
      c: { type: 'choice', instructions: 'pick', criteria: { a: 'AA', b: null } },
      s: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] },
    };
    const body = JSON.parse(buildDecisionsRequest({ apiKey: KEY, baseUrl: D }, S, questions).body);
    expect(body.questions).toEqual([
      { type: 'predicate', name: 'n', instructions: 'keep?\nTrue when: it matters.\nFalse when: it does not.' },
      { type: 'choice', name: 'c', instructions: 'pick', choices: [{ value: 'a', description: 'AA' }, { value: 'b', description: 'b' }] },
      { type: 'score', name: 's', instructions: 'rate', levels: [{ label: 'low' }, { label: 'high' }] },
    ]);
  });

  it('masks exactly like the System One builder and never mutates the state', () => {
    const state = { memo: KEY };
    const request = buildDecisionsRequest({ apiKey: KEY, baseUrl: D }, state, { q: { type: 'noul', instructions: KEY } });
    const body = JSON.parse(request.body);
    expect(body.input).toBe('{"memo":"[REDACTED:known]"}');
    expect(body.questions[0].instructions).toBe('[REDACTED:known]');
    expect(state).toEqual({ memo: KEY });
  });

  it('refuses a non-HTTPS destination', () => {
    expect(() => buildDecisionsRequest({ apiKey: KEY, baseUrl: 'http://openai.com/v1/decisions' }, S, Q))
      .toThrow('baseUrl must be https:// or a loopback http:// URL');
  });
});

describe('decisions wire: the response', () => {
  it('predicate ⇒ noul; model and usage preserved', () => {
    const text = JSON.stringify({
      model: 'gpt-6-luna',
      answers: [{ type: 'predicate', name: 'q', probability: 0.92 }],
      usage: { input_tokens: 171, output_tokens: 0 },
    });
    const result = parseDecisionsResponse(200, true, text);
    expect(result.answers.q).toEqual({ type: 'noul', noul: 0.92 });
    expect(result.model).toBe('gpt-6-luna');
    expect(result.usage).toEqual({ input_tokens: 171, output_tokens: 0 });
  });

  it('a refusal is omitted (unscored), never fabricated', () => {
    const text = JSON.stringify({ model: 'gpt-6-luna', answers: [{ type: 'refusal', name: 'q' }] });
    expect(parseDecisionsResponse(200, true, text).answers).toEqual({});
  });

  it('choice ⇒ probabilities record plus confidence', () => {
    const text = JSON.stringify({
      answers: [{
        type: 'choice', name: 'd', choice: 'billing', confidence: 0.93,
        probabilities: [{ value: 'billing', probability: 0.95 }, { value: 'other', probability: 0.05 }],
      }],
    });
    expect(parseDecisionsResponse(200, true, text).answers.d).toEqual({
      type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.95, other: 0.05 },
    });
  });

  it('score ⇒ label-keyed probabilities', () => {
    const text = JSON.stringify({
      answers: [{
        type: 'score', name: 'sev', score: 1.1, confidence: 0.55,
        probabilities: [
          { value: 0, label: 'Cosmetic', probability: 0.1 },
          { value: 1, label: 'Workaround', probability: 0.7 },
          { value: 2, label: 'Blocked', probability: 0.2 },
        ],
      }],
    });
    expect(parseDecisionsResponse(200, true, text).answers.sev).toEqual({
      type: 'score', score: 1.1, confidence: 0.55, probabilities: { Cosmetic: 0.1, Workaround: 0.7, Blocked: 0.2 },
    });
  });

  it('contract breaks are typed errors, never defaults', () => {
    expect(() => parseDecisionsResponse(200, true, 'not json')).toThrow('Jev returned malformed JSON');
    expect(() => parseDecisionsResponse(200, true, '{"answers":{}}')).toThrow('Jev response is missing answers');
    expect(() => parseDecisionsResponse(429, false, 'busy')).toThrow('Jev request failed (429)');
  });
});

describe('luna through JevClient', () => {
  it('sends the Decisions body and maps the answer onto the System One envelope', async () => {
    vi.stubEnv('OPENAI_API_KEY', KEY);
    const trace: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      trace.push({ url: String(url), init });
      return new Response(JSON.stringify({
        model: 'gpt-6-luna',
        answers: [{ type: 'predicate', name: 'q', probability: 0.98 }],
      }), { status: 200 });
    });
    const client = new JevClient({ provider: 'luna', allowThirdPartyEgress: true, fetch: fetcher });
    const result = await client.ask(S, Q);
    expect(result.answers.q).toEqual({ type: 'noul', noul: 0.98 });
    expect(trace.map(({ url }) => url)).toEqual([D]);
    expect(trace[0]?.init?.method).toBe('POST');
    expect(trace[0]?.init?.headers).toEqual({ authorization: 'Bearer ' + KEY, 'content-type': 'application/json' });
    const body = JSON.parse(String(trace[0]?.init?.body));
    expect(body.model).toBe('gpt-6-luna');
    expect(body.questions).toEqual([{ type: 'predicate', name: 'q', instructions: 'keep?' }]);
  });

  it('a refusal leaves the question unanswered (the round treats it as unscored)', async () => {
    vi.stubEnv('OPENAI_API_KEY', KEY);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: 'gpt-6-luna',
      answers: [{ type: 'refusal', name: 'q' }],
    }), { status: 200 }));
    const client = new JevClient({ provider: 'luna', allowThirdPartyEgress: true, fetch: fetcher });
    const result = await client.ask(S, Q);
    expect(result.answers).toEqual({});
  });
});
