import { redactField, redactForEgress } from './secrets.js';
import type { CallAnswer, JevAnswer, JevQuestions, JevResponse, JevRoundCounts, JevState, JevTerminalCode, ToolCall } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/** API key destination: HTTPS or an explicit loopback HTTP host, no userinfo. */
export function checkBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JevConfigError('url');
  }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1];
  // Check the host as written, not a normalized IPv4 alias such as 127.1.
  const loopbackHttp = parsed.protocol === 'http:' &&
    /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(authority ?? '');
  if (!authority || parsed.username || parsed.password || authority.includes('@') ||
    !(parsed.protocol === 'https:' || loopbackHttp)) {
    throw new JevConfigError('url');
  }
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/**
 * The HTTP request for one Jev call, for any fetch-like transport. Every string of the body is masked with its field
 * name in view (`redactField`) and every object key with `redactForEgress`, the API key as a known value: the second
 * mask behind `compact`, which masks the history before cutting it, and the only one for a caller that builds its own
 * state. A JSON replacer keeps `toJSON` and the usual error on a cyclic value; `state` and `questions` are not changed.
 */
/**
 * The masking replacer both wires share: every string value is masked with its field name in view (`redactField`) and
 * every object key with `redactForEgress`, the API key as a known value. A JSON replacer keeps `toJSON` and the usual
 * error on a cyclic value. Split out so the Decisions builder masks exactly like the System One one.
 */
export function jevMaskReplacer(known: readonly string[]): (this: object, key: string, value: unknown) => unknown {
  const arrayField = new WeakMap<object, string>();
  return function (this: object, key: string, value: unknown) {
    // JSON.stringify names an array element "0"; the field that holds the array is the name redactField needs.
    const field = Array.isArray(this) ? (arrayField.get(this) ?? key) : key;
    if (typeof value === 'string') return redactField(field, value, known);
    if (Array.isArray(value)) arrayField.set(value, field);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    // An object whose key is a secret comes back as a copy with masked keys (JSON.stringify then visits its values);
    // any other object is returned as is, so the usual cycle check still applies.
    const keys = Object.keys(value).map((k) => [k, redactForEgress(k, known)] as const);
    if (keys.every(([k, masked]) => k === masked)) return value;
    return Object.fromEntries(keys.map(([k, masked]) => [masked, (value as Record<string, unknown>)[k]]));
  };
}

export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const url = params.baseUrl ?? SYSTEM_ONE_URL;
  checkBaseUrl(url);
  return {
    url,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: params.model ?? DEFAULT_MODEL, state, questions }, jevMaskReplacer([params.apiKey])),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only safe status and delay metadata crosses the transport boundary. Never retain the body or headers. */
export class JevHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, retryAfterMs?: number) {
    super(`Jev request failed (${status})`);
    this.name = 'JevHttpError';
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class JevNetworkError extends Error {
  readonly code = 'network';
  constructor() { super('Jev network request failed'); this.name = 'JevNetworkError'; }
}

/** Typed configuration failures are round-fatal, but never contain a credential, destination or original cause. */
export class JevConfigError extends Error {
  readonly kind: 'api_key' | 'url' | 'request';
  /** `message` names the missing setting (an env var name), never its value. */
  constructor(kind: 'api_key' | 'url' | 'request', message?: string) {
    const messages = {
      api_key: 'TYPESAFE_API_KEY is not configured',
      url: 'baseUrl must be https:// or a loopback http:// URL',
      request: 'Jev request configuration is invalid',
    };
    super(message ?? messages[kind] ?? messages.request); this.name = 'JevConfigError'; this.kind = kind;
  }
}

export type JevContractKind = 'json' | 'envelope' | 'answer' | 'no_complete_pair' | 'incomplete_pair';
export class JevContractError extends Error {
  readonly kind: JevContractKind;
  constructor(kind: JevContractKind, answerName?: string) {
    const messages: Record<JevContractKind, string> = {
      json: 'Jev returned malformed JSON',
      envelope: 'Jev response is missing answers',
      answer: `Invalid Jev answer for ${answerName ?? 'requested question'}`,
      no_complete_pair: 'Invalid Jev answer: no complete pair in batch',
      incomplete_pair: 'Invalid Jev answer: incomplete pair in rollback mode',
    };
    super(messages[kind]); this.name = 'JevContractError'; this.kind = kind;
  }
}

/** Safe failure payload for the final audit adapter. No original exception or transport data is retained. */
export class JevRoundError extends Error {
  readonly code: Exclude<JevTerminalCode, 'none'>;
  readonly counts: Readonly<JevRoundCounts>;
  readonly contractKind?: JevContractKind;
  constructor(code: Exclude<JevTerminalCode, 'none'>, counts: JevRoundCounts, detail?: JevHttpError | JevContractError | JevConfigError, timeoutMs?: number) {
    super(code === 'deadline' ? `Jev round timed out after ${timeoutMs} ms` :
      detail instanceof JevConfigError ? detail.message : detail?.message ?? `Jev round failed (${code})`);
    this.name = 'JevRoundError'; this.code = code;
    this.counts = Object.freeze({ ...counts });
    if (detail instanceof JevContractError) this.contractKind = detail.kind;
  }
}

/** Headers from native fetch or the buffered host SDK. */
export type JevResponseHeaders = Readonly<Record<string, string>> | { get(name: string): string | null };

/** Parse only delta seconds or a strict IMF-fixdate. An excessive integer is not an absent header. */
export function parseRetryAfter(headers: JevResponseHeaders | undefined, nowMs: number): number | undefined {
  if (!headers) return undefined;
  const value = typeof headers.get === 'function' ? headers.get('retry-after') :
    Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isSafeInteger(ms) ? ms : Number.POSITIVE_INFINITY;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
  const date = Date.parse(text);
  if (!Number.isFinite(date) || new Date(date).toUTCString() !== text) return undefined;
  return Math.max(0, date - nowMs);
}

export function isRetryableJevError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  return error instanceof JevNetworkError || (error instanceof JevHttpError && Number.isInteger(error.status) &&
    (error.status === 429 || (error.status >= 500 && error.status <= 599)));
}

/** Machine-readable native fetch causes only; arbitrary TypeError messages and TLS/config errors remain unknown. */
export function isNativeJevNetworkError(error: unknown): boolean {
  if (error instanceof JevNetworkError) return true;
  if (!(error instanceof Error) || !isRecord(error.cause)) return false;
  const code = error.cause.code;
  return typeof code === 'string' && [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ].includes(code);
}

function responseEnvelope(response: unknown): JevResponse {
  if (!isRecord(response) || !isRecord(response.answers)) throw new JevContractError('envelope');
  return response as JevResponse;
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
  headers?: JevResponseHeaders,
  nowMs: number = Date.now(),
): JevResponse {
  if (!ok) {
    throw new JevHttpError(status, parseRetryAfter(headers, nowMs));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevContractError('json');
  }
  return responseEnvelope(parsed);
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer: unknown = isRecord(answers) && Object.hasOwn(answers, name) ? answers[name] : undefined;
  if (
    !isRecord(answer) ||
    !Object.hasOwn(answer, 'noul') ||
    (answer.type !== undefined && answer.type !== 'noul') ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  ) {
    throw new JevContractError('answer', name);
  }
  return answer.noul;
}

/** Missing halves are unscored, never combined with another attempt or cache. Invalid requested halves are fatal. */
export function readBatchAnswers(response: unknown, batch: readonly Pick<ToolCall, 'id'>[]): { scored: Map<string, CallAnswer>; missingCalls: string[] } {
  const { answers } = responseEnvelope(response);
  const scored = new Map<string, CallAnswer>(), missingCalls: string[] = [];
  for (const call of batch) {
    const names = [`call_${call.id}`, `result_${call.id}`];
    const values = names.map((name) => {
      if (Object.hasOwn(answers, name)) return noulAnswer(answers, name);
      if (name in answers) throw new JevContractError('answer', name);
      return undefined;
    });
    if (values[0] === undefined || values[1] === undefined) missingCalls.push(call.id);
    else scored.set(call.id, { keepCall: values[0], keepResult: values[1] });
  }
  if (batch.length > 0 && scored.size === 0) throw new JevContractError('no_complete_pair');
  return { scored, missingCalls };
}
