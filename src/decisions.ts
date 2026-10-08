// The OpenAI Decisions wire (2026-10-08): the second request shape this package can speak. `POST
// /v1/decisions` takes the evidence as text plus typed questions (`predicate`, `choice`, `score`) and answers with
// an `answers` array; every answer carries its calibrated probability, refusals are typed and carry none. This
// module maps that shape onto the System One envelope the rest of the package already eats: a `noul` question
// becomes a `predicate`, `choice`/`score` keep their types, and a refusal is dropped — an unscored call stays
// verbatim through the caller's partial-answers policy, never fabricated into a probability. The two builders
// share `jevMaskReplacer`, so the wires cannot drift apart on masking.
import { checkBaseUrl, JevContractError, JevHttpError, jevMaskReplacer, parseRetryAfter, type JevRequest, type JevResponseHeaders } from './request.js';
import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions';
/** The only model the Decisions public beta serves (2026-10-08). */
export const DECISIONS_MODEL = 'gpt-6-luna';

type DecisionsQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | { type: 'choice'; name: string; instructions: string; choices: { value: string; description: string }[] }
  | { type: 'score'; name: string; instructions: string; levels: { label: string }[] };

/**
 * System One questions mapped onto the Decisions question types. A `noul` question's criteria fold into its
 * instructions (the Decisions predicate has no separate criteria field); a `choice` question's criteria become the
 * choices (a null description falls back to its value); a `score` question's criteria become the ordered levels.
 */
export function decisionsQuestions(questions: JevQuestions): DecisionsQuestion[] {
  return Object.entries(questions).map(([name, q]): DecisionsQuestion => {
    if (q.type === 'noul') {
      // Newlines, not an inline run-on: "…is about True when: …" read as one broken sentence and
      // gpt-6-luna answered the subject gate False 3/3; the separated form answers 0.89 (live probe).
      const criteria = q.criteria && (q.criteria.true !== undefined || q.criteria.false !== undefined)
        ? `\nTrue when: ${q.criteria.true ?? 'the condition holds'}.\nFalse when: ${q.criteria.false ?? 'it does not'}.`
        : '';
      return { type: 'predicate', name, instructions: q.instructions + criteria };
    }
    if (q.type === 'choice') {
      return {
        type: 'choice', name, instructions: q.instructions,
        choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description: description ?? value })),
      };
    }
    return { type: 'score', name, instructions: q.instructions, levels: q.criteria.map((label) => ({ label })) };
  });
}

/**
 * The HTTP request for one Decisions call, for any fetch-like transport. Masking is the System One builder's
 * (`jevMaskReplacer`): the state is serialized once, then the whole body, each pass masking values and keys.
 */
export function buildDecisionsRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const url = params.baseUrl ?? OPENAI_DECISIONS_URL;
  checkBaseUrl(url);
  const mask = jevMaskReplacer([params.apiKey]);
  const input = JSON.stringify(state, mask);
  return {
    url,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    // The Decisions API takes the evidence as a text string; the same fitted state the System One wire sends is
    // that text, so both wires show the model the same conversation (the state was masked above).
    body: JSON.stringify({ model: params.model ?? DECISIONS_MODEL, input, questions: decisionsQuestions(questions) }, mask),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The `probabilities` array of a choice/score answer as the System One record; a score entry keys by its label. */
function probabilitiesFrom(entries: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.label === 'string' ? entry.label : entry.value;
    if ((typeof key === 'string' || typeof key === 'number')
      && typeof entry.probability === 'number' && Number.isFinite(entry.probability)) {
      out[String(key)] = entry.probability;
    }
  }
  return out;
}

/**
 * Maps a Decisions response onto the System One envelope. A refusal is omitted (the call goes unscored, never a
 * made-up probability); an answer of an unknown type is omitted the same way. Probability bounds are left to
 * `noulAnswer`'s existing validation, so both wires fail identically on a server that breaks the contract.
 */
export function parseDecisionsResponse(
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
  if (!isRecord(parsed) || !Array.isArray(parsed.answers)) throw new JevContractError('envelope');
  const answers: Record<string, JevAnswer> = {};
  for (const raw of parsed.answers) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue;
    if (raw.type === 'predicate') {
      if (typeof raw.probability === 'number' && Number.isFinite(raw.probability)) {
        answers[raw.name] = { type: 'noul', noul: raw.probability };
      }
    } else if (raw.type === 'choice') {
      if (typeof raw.choice === 'string') {
        answers[raw.name] = {
          type: 'choice', choice: raw.choice,
          confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0,
          probabilities: probabilitiesFrom(raw.probabilities),
        };
      }
    } else if (raw.type === 'score') {
      if (typeof raw.score === 'number' && Number.isFinite(raw.score)) {
        answers[raw.name] = {
          type: 'score', score: raw.score,
          confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0,
          probabilities: probabilitiesFrom(raw.probabilities),
        };
      }
    }
  }
  const response: JevResponse = { answers };
  if (typeof parsed.model === 'string') response.model = parsed.model;
  const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
  const inputTokens = usage && typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens) ? usage.input_tokens : undefined;
  const outputTokens = usage && typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? usage.output_tokens : undefined;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    response.usage = {
      ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
      ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
    };
  }
  return response;
}
