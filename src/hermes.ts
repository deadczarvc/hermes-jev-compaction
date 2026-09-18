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
  function?: { name?: string; arguments?: string };
  name?: string;
  arguments?: string;
}

export interface HermesMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | (string & {});
  content: unknown;
  tool_calls?: HermesToolCall[];
  tool_call_id?: string;
}

export interface HermesTranscript {
  messages: Message[];
  /** System texts, kept out of the compactable transcript; pass them as `goal`. */
  systemTexts: string[];
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
 * Maps an OpenAI-chat transcript onto the library's `Message[]`.
 * Consecutive `tool` messages are grouped into one user message carrying
 * `toolResults`, mirroring the pairing the library expects by `tool_use_id`.
 * Tool messages whose `tool_call_id` is missing or unmatched stay untouched
 * (the library never drops unpaired calls).
 */
export function fromHermes(messages: readonly HermesMessage[]): HermesTranscript {
  const out: Message[] = [];
  const systemTexts: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text = contentText(message.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (message.role === 'tool') {
      const result: ToolResult = {
        tool_use_id: message.tool_call_id ?? '',
        text: contentText(message.content),
      };
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
  return { messages: out, systemTexts };
}

/**
 * Inverse of `fromHermes`. Untouched assistant messages keep their original
 * tool call objects wherever the library returned them unchanged; rebuilt
 * calls are re-serialized from the parsed input. Tool results become `tool`
 * messages in transcript order, followed by any user text of the same
 * message. Empty assistant messages are dropped.
 */
export function toHermes(messages: readonly Message[]): HermesMessage[] {
  const out: HermesMessage[] = [];
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
