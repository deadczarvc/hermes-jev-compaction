import type { Message, ToolResult, ToolUse } from './types.js';

export const ESTIMATOR_ID = 'dense30-v1';
export const PROJECTION_ID = 'visible-text-input-result-v1';
export type Transcript = readonly Readonly<Omit<Message, 'toolUses' | 'toolResults'> & {
  toolUses: readonly Readonly<ToolUse>[];
  toolResults?: readonly Readonly<ToolResult>[];
}>[];
export type MeasurementCode = 'ok' | 'ambiguous_id' | 'unserializable_input';
export type MeasureResult = Readonly<{ chars: number; tokens: number; mirrorMismatches: number; code: 'ok' }> |
  Readonly<{ chars: null; tokens: null; code: Exclude<MeasurementCode, 'ok'> }>;
export type CanonicalProjection = Readonly<{ code: 'ok'; components: readonly string[]; mirrorMismatches: number }> |
  Readonly<{ code: Exclude<MeasurementCode, 'ok'> }>;

/** Integer units/30; ASCII runs and non-whitespace UTF-16 code units only. Not a billing tokenizer. */
export function estimateDenseTokens(text: string): number {
  let units = 0, end = 0;
  const outside = (value: string): number => {
    let n = 0;
    for (let i = 0; i < value.length; i++) if (!/\s/.test(value[i]!)) n += 27;
    return n;
  };
  for (const match of text.matchAll(/[A-Za-z0-9]+/g)) {
    units += outside(text.slice(end, match.index));
    const run = match[0];
    let plain = 0;
    for (const piece of run.match(/[A-Za-z]+|[0-9]+/g) ?? []) {
      plain += /^[0-9]/.test(piece) ? 15 * piece.length : 30 * (1 + Math.floor((piece.length - 1) / 6));
    }
    const letters = /[A-Za-z]/.test(run), digits = /[0-9]/.test(run);
    const dense = (run.length >= 8 && letters && digits) ||
      (run.length >= 16 && !digits && (run.match(/[aeiou]/gi)?.length ?? 0) / run.length < 0.25 && new Set(run).size >= 8);
    units += dense ? Math.max(plain, 10 * run.length) : plain;
    end = match.index + run.length;
  }
  return Math.ceil((units + outside(text.slice(end))) / 30);
}

/** One outcome per id, result blocks taking priority even when empty. No mutation or guessed counts. */
export function canonicalResults(messages: Transcript): CanonicalProjection {
  const uses = new Map<string, Readonly<ToolUse>>(), results = new Map<string, Readonly<ToolResult>>();
  const components: string[] = [];
  for (const message of messages) {
    components.push(message.text);
    for (const use of message.toolUses) {
      if (uses.has(use.tool_use_id)) return { code: 'ambiguous_id' };
      uses.set(use.tool_use_id, use);
    }
    for (const result of message.toolResults ?? []) {
      if (results.has(result.tool_use_id)) return { code: 'ambiguous_id' };
      results.set(result.tool_use_id, result);
    }
  }
  let mirrorMismatches = 0;
  for (const [id, use] of uses) {
    try {
      const input = JSON.stringify(use.input);
      if (input === undefined) return { code: 'unserializable_input' };
      components.push(input);
    } catch { return { code: 'unserializable_input' }; }
    const result = results.get(id);
    if (result && use.text !== undefined && use.text !== result.text) mirrorMismatches++;
    if (result) components.push(result.text);
    else if (use.text !== undefined) components.push(use.text);
  }
  for (const [id, result] of results) if (!uses.has(id)) components.push(result.text);
  return { code: 'ok', components, mirrorMismatches };
}

export function measureTranscript(messages: Transcript): MeasureResult {
  const projection = canonicalResults(messages);
  if (projection.code !== 'ok') return { chars: null, tokens: null, code: projection.code };
  let chars = 0, tokens = 0;
  for (const component of projection.components) { chars += component.length; tokens += estimateDenseTokens(component); }
  return { chars, tokens, mirrorMismatches: projection.mirrorMismatches, code: 'ok' };
}
