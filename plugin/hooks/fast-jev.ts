import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

const DEFAULTS = {
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  charsPerToken: 3.5,
  model: 'jev-latest',
};

const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

const CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.';

const INPUT_CHARS = [1000, 200, 60];
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

export type HookFetch = (
  url: string,
  init?: HookFetchInit,
) => Promise<HookFetchResponse>;

export type ModConfig = {
  apiKey?: string;
  keepThreshold?: number;
  preserveRecentMessages?: number;
  compactAtPercent?: number;
  minReductionRatio?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  charsPerToken?: number;
  model?: string;
  goal?: string;
};

type ResolvedConfig = {
  apiKey?: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  compactAtPercent: number;
  minReductionRatio: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  charsPerToken: number;
  model: string;
  goal: string;
};

export type ToolCall = {
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  callIndex: number;
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  pinned: boolean;
};

export type CallAnswer = {
  keepCall: number;
  keepResult: number;
};

export type CallDecision = CallAnswer & {
  id: string;
  tool: string;
  action: 'keep' | 'drop_result' | 'drop_call';
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
};

type HistoryToolCall = {
  id: string;
  tool: string;
  input: string;
  result: string;
};

type HistoryEntry = {
  i: number;
  role: 'user' | 'assistant';
  text: string;
  tool_calls?: HistoryToolCall[];
};

export type JevState = {
  context: string;
  goal: string;
  history: HistoryEntry[];
};

export type CompactionOutput = {
  messages: SessionMessage[];
  decisions: CallDecision[];
  charsBefore: number;
  charsAfter: number;
  stateTokens: number;
  requests: number;
};

type JevAnswer = { type?: 'noul'; noul: number };
type JevResponse = { answers?: Record<string, JevAnswer> };

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

function optionNumber(
  options: PluginOptions | ModConfig,
  key: keyof ModConfig,
  fallback: number,
): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(
  options: PluginOptions | ModConfig,
  key: keyof ModConfig,
  fallback: string,
): string {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function resolveConfig(options: PluginOptions | ModConfig): ResolvedConfig {
  return {
    apiKey:
      typeof options.apiKey === 'string' && options.apiKey.length > 0
        ? options.apiKey
        : undefined,
    keepThreshold: optionNumber(options, 'keepThreshold', DEFAULTS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        optionNumber(
          options,
          'preserveRecentMessages',
          DEFAULTS.preserveRecentMessages,
        ),
      ),
    ),
    compactAtPercent: optionNumber(
      options,
      'compactAtPercent',
      DEFAULTS.compactAtPercent,
    ),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      DEFAULTS.minReductionRatio,
    ),
    maxStateTokens: Math.max(
      1,
      optionNumber(options, 'maxStateTokens', DEFAULTS.maxStateTokens),
    ),
    maxRequestTokens: Math.max(
      1,
      optionNumber(options, 'maxRequestTokens', DEFAULTS.maxRequestTokens),
    ),
    charsPerToken: Math.max(
      0.1,
      optionNumber(options, 'charsPerToken', DEFAULTS.charsPerToken),
    ),
    model: optionString(options, 'model', DEFAULTS.model),
    goal: optionString(options, 'goal', ''),
  };
}

export function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number,
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

export function collectToolCalls(
  messages: readonly SessionMessage[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResultSummary }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = '';
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

function resultNote(call: ToolCall): string {
  return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`;
}

function historyEntries(
  messages: readonly SessionMessage[],
  calls: readonly ToolCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}

function goalFromMessages(messages: readonly SessionMessage[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

export type FittedState = {
  state: JevState;
  tokens: number;
  stage: string;
};

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages
 * until it fits `maxStateTokens`: tool inputs are truncated, then long texts
 * are abridged oldest-first (pinned messages last), then old messages collapse
 * to a one-line note. Throws when even that is too big.
 */
export function fitState(
  messages: readonly SessionMessage[],
  calls: readonly ToolCall[],
  config: Pick<
    ResolvedConfig,
    'maxStateTokens' | 'charsPerToken' | 'preserveRecentMessages' | 'goal'
  >,
): FittedState {
  const goal = config.goal || goalFromMessages(messages);
  const measure = (history: HistoryEntry[]): [JevState, number] => {
    const state: JevState = { context: CONTEXT, goal, history };
    return [state, estimateTokens(JSON.stringify(state), config.charsPerToken)];
  };
  const fits = (tokens: number): boolean => tokens <= config.maxStateTokens;

  let history = historyEntries(messages, calls, INPUT_CHARS[0] ?? 1000);
  let [state, tokens] = measure(history);
  if (fits(tokens)) return { state, tokens, stage: 'full' };

  for (const limit of INPUT_CHARS.slice(1)) {
    history = historyEntries(messages, calls, limit);
    [state, tokens] = measure(history);
    if (fits(tokens)) return { state, tokens, stage: `inputs<=${limit}` };
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, config.preserveRecentMessages);
  const order = [
    ...history.filter((entry) => !pinned(entry)),
    ...history.filter(pinned),
  ];

  for (const entry of order) {
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    entry.text = abridge(entry.text, TEXT_HEAD, TEXT_TAIL);
    [state, tokens] = measure(history);
    if (fits(tokens)) return { state, tokens, stage: 'texts abridged' };
  }

  for (const entry of order) {
    if (pinned(entry) || entry.text.length === 0) continue;
    entry.text = `[… ${entry.text.length} chars omitted …]`;
    [state, tokens] = measure(history);
    if (fits(tokens)) return { state, tokens, stage: 'old messages collapsed' };
  }

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${config.maxStateTokens})`,
  );
}

function questionsFor(call: ToolCall): Record<string, unknown> {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  config: Pick<ResolvedConfig, 'maxRequestTokens' | 'charsPerToken'>,
): ToolCall[][] {
  const budget = config.maxRequestTokens - stateTokens;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(
      JSON.stringify(questionsFor(call)),
      config.charsPerToken,
    );
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${config.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  config: Pick<ResolvedConfig, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) {
    return { ...base, action: 'keep', reason: 'pinned' };
  }
  if (answer.keepResult >= config.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= config.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

function noul(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name];
  if (!answer || typeof answer.noul !== 'number') {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

async function askBatch(
  batch: readonly ToolCall[],
  state: JevState,
  config: ResolvedConfig,
  fetchFn: HookFetch,
): Promise<Map<string, CallAnswer>> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const questions = Object.assign({}, ...batch.map(questionsFor)) as Record<
    string,
    unknown
  >;
  const response = await fetchFn(SYSTEM_ONE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: config.model, state, questions }),
  });
  if (!response.ok) {
    throw new Error(`TypeSafe request failed with ${response.status}`);
  }
  let parsed: JevResponse;
  try {
    parsed = JSON.parse(response.text) as JevResponse;
  } catch {
    throw new Error('TypeSafe returned malformed JSON');
  }
  const answers = parsed.answers;
  if (!answers) throw new Error('TypeSafe response is missing answers');
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noul(answers, `call_${call.id}`),
        keepResult: noul(answers, `result_${call.id}`),
      },
    ]),
  );
}

function removedNote(result: ToolResultSummary): string {
  return `[tool result removed during compaction: ${result.text.length} chars${
    result.isError ? ', error' : ''
  }; re-run the tool if needed]`;
}

function strippedToolUse(tool: ToolUseSummary, note: string): ToolUseSummary {
  const copy: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
    text: note,
  };
  if (tool.isError) copy.isError = true;
  return copy;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result is replaced by a one-line note.
 * Messages that lose all their content are removed; untouched messages keep
 * the engine's handle.
 */
export function applyDecisions(
  messages: readonly SessionMessage[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
): SessionMessage[] {
  const actionById = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = calls.find((candidate) => candidate.id === decision.id);
    if (call && decision.action !== 'keep') {
      actionById.set(call.tool_use_id, decision.action);
    }
  }
  const kept: SessionMessage[] = [];
  for (const message of messages) {
    const touchedUses = message.toolUses.some((tool) => actionById.has(tool.tool_use_id));
    const touchedResults = (message.toolResults ?? []).some((result) =>
      actionById.has(result.tool_use_id),
    );
    if (!touchedUses && !touchedResults) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actionById.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) =>
        actionById.get(tool.tool_use_id) === 'drop_result'
          ? strippedToolUse(
              tool,
              `[tool result removed during compaction: ${tool.text?.length ?? 0} chars; re-run the tool if needed]`,
            )
          : tool,
      );
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actionById.get(result.tool_use_id) !== 'drop_call')
      .map((result) =>
        actionById.get(result.tool_use_id) === 'drop_result'
          ? {
              tool_use_id: result.tool_use_id,
              text: removedNote(result),
              isError: result.isError,
            }
          : result,
      );
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: SessionMessage = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

export function messageChars(message: SessionMessage): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) {
    total += result.text.length;
  }
  return total;
}

export function reductionRatio(result: CompactionOutput): number {
  return result.charsBefore === 0
    ? 0
    : (result.charsBefore - result.charsAfter) / result.charsBefore;
}

export async function compactWithFetch(
  messages: readonly SessionMessage[],
  options: ModConfig = {},
  fetchFn: HookFetch,
): Promise<CompactionOutput> {
  const config = resolveConfig(options);
  const calls = collectToolCalls(messages, config.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);
  if (candidates.length === 0) {
    return {
      messages: [...messages],
      decisions: calls.map((call) =>
        decideCall(call, { keepCall: 1, keepResult: 1 }, config),
      ),
      charsBefore,
      charsAfter: charsBefore,
      stateTokens: 0,
      requests: 0,
    };
  }
  const fitted = fitState(messages, calls, config);
  const batches = batchCalls(candidates, fitted.tokens, config);
  const answered = await Promise.all(
    batches.map((batch) => askBatch(batch, fitted.state, config, fetchFn)),
  );
  const answers = new Map(answered.flatMap((map) => [...map.entries()]));
  const decisions = calls.map((call) =>
    decideCall(
      call,
      answers.get(call.id) ?? { keepCall: 1, keepResult: 1 },
      config,
    ),
  );
  const kept = applyDecisions(messages, decisions, calls);
  return {
    messages: kept,
    decisions,
    charsBefore,
    charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
    stateTokens: fitted.tokens,
    requests: batches.length,
  };
}

export async function compactOrFallback(
  messages: readonly SessionMessage[],
  options: ModConfig = {},
  fetchFn: HookFetch,
): Promise<CompactionOutput | null> {
  const result = await compactWithFetch(messages, options, fetchFn);
  return reductionRatio(result) <
    (options.minReductionRatio ?? DEFAULTS.minReductionRatio)
    ? null
    : result;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function summarize(result: CompactionOutput): string {
  const counts = new Map<CallDecision['reason'], number>();
  for (const decision of result.decisions) {
    counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([reason, count]) => `${count} ${reason}`);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${result.stateTokens} tokens in ${result.requests} request(s)`;
}

function decisionLog(result: CompactionOutput): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

function optionConfig(options: PluginOptions): ModConfig {
  const resolved = resolveConfig(options);
  return {
    apiKey: resolved.apiKey,
    keepThreshold: resolved.keepThreshold,
    preserveRecentMessages: resolved.preserveRecentMessages,
    compactAtPercent: resolved.compactAtPercent,
    minReductionRatio: resolved.minReductionRatio,
    maxStateTokens: resolved.maxStateTokens,
    maxRequestTokens: resolved.maxRequestTokens,
    charsPerToken: resolved.charsPerToken,
    model: resolved.model,
  };
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: ModConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = optionConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const apiKey = await getApiKey($, configured);
      const config = { ...configured, apiKey };
      const result = await compactWithFetch(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      $.ui.log(`decisions: ${decisionLog(result) || '(none)'}`);
      const minReduction = config.minReductionRatio ?? DEFAULTS.minReductionRatio;
      if (reductionRatio(result) < minReduction) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(minReduction)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${result.messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages: result.messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < (configured.compactAtPercent ?? DEFAULTS.compactAtPercent)) {
        return next(event);
      }
      compacting = true;
      await $.session.compact();
      return next(event);
    } finally {
      compacting = false;
    }
  });
};
