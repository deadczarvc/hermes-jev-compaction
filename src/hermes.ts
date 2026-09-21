// hermes-jev-compaction — Hermes Agent adapter for fast-jev-compaction.
// Maps OpenAI-chat transcripts (Hermes session format) onto the library's
// Message[] so the Jev decision engine can score Hermes tool calls.
import type { Message, ToolResult, ToolUse } from './types.js';

/**
 * OpenAI-chat-style message — the interchange format Hermes stores in session
 * state and sends to OpenAI-compatible providers. Covers both the nested
 * (`function: { name, arguments }`) and flat (`name`, `arguments`) tool call
 * spellings found in the wild.
 */
export interface HermesToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string; [key: string]: unknown };
  name?: string;
  arguments?: string;
  [key: string]: unknown;
}

export interface HermesMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | (string & {});
  content: unknown;
  tool_calls?: HermesToolCall[];
  tool_call_id?: string;
  error?: boolean;
  [key: string]: unknown;
}

export interface HermesTranscript {
  messages: Message[];
  /** System texts, kept out of the compactable transcript; pass them as `goal`. */
  systemTexts: string[];
  /** Original system messages (verbatim), for toHermes to restore. */
  systemEntries: HermesMessage[];
  /** Complete native input, in its original order. Required for lossless output. */
  sourceMessages: readonly HermesMessage[];
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

function parseInput(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // fall through to the raw wrapper
    }
    return { raw };
  }
  return {};
}

function callName(call: HermesToolCall): string {
  return call.name ?? call.function?.name ?? 'unknown_tool';
}

function callArguments(call: HermesToolCall): unknown {
  return call.function?.arguments ?? call.arguments;
}

/**
 * Maps an OpenAI-chat transcript onto the compactable `Message[]` projection.
 * The projection is deliberately text-only for scoring. `sourceMessages` is
 * always retained verbatim and is the only source used to serialize output,
 * so non-text parts and provider-specific fields are never reconstructed.
 */
export function fromHermes(messages: readonly HermesMessage[]): HermesTranscript {
  const out: Message[] = [];
  const systemTexts: string[] = [];
  const systemEntries: HermesMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text = contentText(message.content);
      if (text) systemTexts.push(text);
      systemEntries.push(message);  // verbatim, restored by toHermes
      continue;
    }
    if (message.role === 'tool') {
      const result: ToolResult = {
        tool_use_id: message.tool_call_id ?? '',
        text: contentText(message.content),
      };
      if (message.error === true) result.isError = true;
      const previous = out[out.length - 1];
      if (
        previous &&
        previous.role === 'user' &&
        previous.text === '' &&
        previous.toolUses.length === 0 &&
        previous.toolResults
      ) {
        previous.toolResults.push(result);
      } else {
        out.push({ role: 'user', text: '', toolUses: [], toolResults: [result] });
      }
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const toolUses: ToolUse[] = (message.tool_calls ?? []).map((call, index) => ({
      tool_use_id: call.id ?? `call_${index}`,
      tool: callName(call),
      input: parseInput(callArguments(call)),
    }));
    out.push({ role, text: contentText(message.content), toolUses });
  }
  return { messages: out, systemTexts, systemEntries, sourceMessages: messages };
}

function isTranscript(value: readonly HermesMessage[] | HermesTranscript): value is HermesTranscript {
  return !Array.isArray(value);
}

function sourceAwareToHermes(
  compacted: readonly Message[],
  transcript: HermesTranscript,
): HermesMessage[] {
  const calls = new Set<string>();
  const results = new Map<string, string>();
  for (const message of compacted) {
    for (const tool of message.toolUses) calls.add(tool.tool_use_id);
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, result.text);
  }

  const callSources = new Map<string, number[]>();
  const resultSources = new Map<string, number[]>();
  transcript.sourceMessages.forEach((message, index) => {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (!call.id) continue;
        const source = callSources.get(call.id) ?? [];
        source.push(index);
        callSources.set(call.id, source);
      }
    }
    if (message.role === 'tool' && message.tool_call_id) {
      const source = resultSources.get(message.tool_call_id) ?? [];
      source.push(index);
      resultSources.set(message.tool_call_id, source);
    }
  });

  const droppedCalls = new Set<string>();
  const changedResults = new Map<number, string>();
  const droppedResults = new Set<number>();
  for (const [id, sources] of callSources) {
    const resultSource = resultSources.get(id);
    // Only a unique native pair is mutable. Missing or duplicate IDs have no
    // trustworthy source record, so preserve them rather than guessing.
    if (sources.length !== 1 || resultSource?.length !== 1) continue;
    const resultIndex = resultSource[0]!;
    if (!calls.has(id)) {
      droppedCalls.add(id);
      droppedResults.add(resultIndex);
      continue;
    }
    const nextText = results.get(id);
    const original = transcript.sourceMessages[resultIndex]!;
    if (nextText !== undefined && nextText !== contentText(original.content)) {
      changedResults.set(resultIndex, nextText);
    }
  }

  const output: HermesMessage[] = [];
  transcript.sourceMessages.forEach((message, index) => {
    if (droppedResults.has(index)) return;
    if (message.role === 'assistant' && message.tool_calls?.some((call) => call.id && droppedCalls.has(call.id))) {
      // Retain the exact source record and remove only calls explicitly dropped.
      // This avoids erasing opaque assistant fields or non-text content.
      const tool_calls = message.tool_calls.filter((call) => !call.id || !droppedCalls.has(call.id));
      const copy: HermesMessage = { ...message };
      if (tool_calls.length > 0) copy.tool_calls = tool_calls;
      else delete copy.tool_calls;
      output.push(copy);
      return;
    }
    const replacement = changedResults.get(index);
    output.push(replacement === undefined ? message : { ...message, content: replacement });
  });
  return output;
}

/**
 * Applies a compaction projection to native Hermes records. Passing the full
 * `HermesTranscript` is lossless: untouched records retain their exact native
 * structure and order, while a matched decision changes only its source call
 * or result. The array overload remains for legacy callers without a source.
 */
export function toHermes(
  messages: readonly Message[],
  source?: readonly HermesMessage[] | HermesTranscript,
): HermesMessage[] {
  if (source && isTranscript(source)) return sourceAwareToHermes(messages, source);
  const systemEntries = source;
  const out: HermesMessage[] = [...(systemEntries ?? [])];
  for (const message of messages) {
    const hasTools = message.toolUses.length > 0;
    const hasResults = (message.toolResults ?? []).length > 0;
    if (message.role === 'assistant') {
      if (message.text.length === 0 && !hasTools && !hasResults) continue;
      // applyDecisions can leave toolResults on the assistant message itself
      // (a rebuilt call+result pair), so both halves are emitted here.
      if (message.text.length > 0 || hasTools) {
        const entry: HermesMessage = {
          role: 'assistant',
          content: message.text.length > 0 ? message.text : null,
        };
        if (hasTools) {
          entry.tool_calls = message.toolUses.map((use) => ({
            id: use.tool_use_id,
            type: 'function',
            function: { name: use.tool, arguments: JSON.stringify(use.input) },
          }));
        }
        out.push(entry);
      }
      for (const result of message.toolResults ?? []) {
        out.push({ role: 'tool', tool_call_id: result.tool_use_id, content: result.text });
      }
      continue;
    }
    for (const result of message.toolResults ?? []) {
      out.push({ role: 'tool', tool_call_id: result.tool_use_id, content: result.text });
    }
    if (message.text.length > 0) out.push({ role: 'user', content: message.text });
  }
  return out;
}

/** Goal string for `compact`: system texts plus optional explicit goal. */
export function hermesGoal(systemTexts: readonly string[], explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return systemTexts.join('\n');
}
