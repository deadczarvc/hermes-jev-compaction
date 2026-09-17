import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

type Kind =
  | 'user_instruction'
  | 'decision'
  | 'file_reference'
  | 'error'
  | 'pending_task'
  | 'stale_tool_output'
  | 'chatter'
  | 'other';

const KIND_CRITERIA: Record<Kind, string> = {
  user_instruction:
    'An instruction, constraint, preference, or request from the user',
  decision: 'A design/implementation decision or key finding',
  file_reference:
    'Names a file path, symbol, command, URL or identifier that will be needed',
  error: 'An error message or its fix',
  pending_task: 'Work that still needs to be done',
  stale_tool_output: 'Tool/file/log output that has already been acted on',
  chatter: 'Greetings, acknowledgements, filler',
  other: 'Other content that does not fit the categories above',
};

const DEFAULTS = {
  dropThreshold: 0.8,
  minKindConfidence: 0.5,
  protectedKinds: ['user_instruction', 'pending_task'] as Kind[],
  preserveRecentMessages: 6,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  maxWindowChars: 60_000,
  previewChars: 800,
  model: 'jev-latest',
};

const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

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

export type CompactionUnit = {
  id: string;
  messages: SessionMessage[];
  pinned: boolean;
  preview: string;
};

export type UnitDecision = {
  id: string;
  drop: number;
  kind: Kind;
  kindConfidence: number;
  action: 'keep' | 'drop';
  reason:
    | 'pinned'
    | 'protected_kind'
    | 'below_threshold'
    | 'low_confidence'
    | 'dropped';
};

export type ModConfig = {
  apiKey?: string;
  dropThreshold?: number;
  minKindConfidence?: number;
  protectedKinds?: Kind[];
  preserveRecentMessages?: number;
  compactAtPercent?: number;
  minReductionRatio?: number;
  maxWindowChars?: number;
  previewChars?: number;
  model?: string;
  goal?: string;
};

type ResolvedConfig = {
  apiKey?: string;
  dropThreshold: number;
  minKindConfidence: number;
  protectedKinds: Set<Kind>;
  preserveRecentMessages: number;
  compactAtPercent: number;
  minReductionRatio: number;
  maxWindowChars: number;
  previewChars: number;
  model: string;
  goal: string;
};

type JevAnswer =
  | { type?: 'noul'; noul: number }
  | {
      type?: 'choice';
      choice: string;
      confidence: number;
      probabilities?: Record<string, number>;
    };

type JevResponse = {
  answers?: Record<string, JevAnswer>;
};

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
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
  const protectedKinds = options.protectedKinds;
  return {
    apiKey:
      typeof options.apiKey === 'string' && options.apiKey.length > 0
        ? options.apiKey
        : undefined,
    dropThreshold: optionNumber(
      options,
      'dropThreshold',
      DEFAULTS.dropThreshold,
    ),
    minKindConfidence: optionNumber(
      options,
      'minKindConfidence',
      DEFAULTS.minKindConfidence,
    ),
    protectedKinds: new Set(
      Array.isArray(protectedKinds)
        ? protectedKinds.filter((kind): kind is Kind =>
            Object.prototype.hasOwnProperty.call(KIND_CRITERIA, kind),
          )
        : DEFAULTS.protectedKinds,
    ),
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
    maxWindowChars: Math.max(
      1,
      Math.floor(
        optionNumber(options, 'maxWindowChars', DEFAULTS.maxWindowChars),
      ),
    ),
    previewChars: Math.max(
      1,
      Math.floor(optionNumber(options, 'previewChars', DEFAULTS.previewChars)),
    ),
    model: optionString(options, 'model', DEFAULTS.model),
    goal: optionString(options, 'goal', ''),
  };
}

function hasMatchingToolResult(
  assistant: SessionMessage,
  user: SessionMessage,
): boolean {
  if (assistant.role !== 'assistant' || assistant.toolUses.length === 0) {
    return false;
  }
  const ids = new Set(assistant.toolUses.map((tool) => tool.tool_use_id));
  const resultIds = new Set(
    (user.toolResults ?? []).map((result) => result.tool_use_id),
  );
  return [...ids].every((id) => resultIds.has(id));
}

function toolPreview(tool: ToolUseSummary, limit: number): string {
  let input = '';
  try {
    input = JSON.stringify(tool.input);
  } catch {
    input = '[unserializable input]';
  }
  return `${tool.tool}: ${truncate(input, limit)}`;
}

function unitPreview(messages: readonly SessionMessage[], limit: number): string {
  const roles = messages.map((message) => message.role).join('+');
  const tools = messages
    .flatMap((message) => message.toolUses)
    .map((tool) => toolPreview(tool, limit))
    .join('; ');
  const text = truncate(
    messages
      .map((message) => message.text)
      .filter(Boolean)
      .join('\n'),
    limit,
  );
  return `role=${roles}; tools=${tools || '(none)'}; text=${text}`;
}

export function groupMessages(
  messages: readonly SessionMessage[],
  options: Pick<ModConfig, 'preserveRecentMessages' | 'previewChars'> = {},
): CompactionUnit[] {
  const preserveRecentMessages = Math.max(
    0,
    Math.floor(
      options.preserveRecentMessages ?? DEFAULTS.preserveRecentMessages,
    ),
  );
  const previewChars = Math.max(
    1,
    Math.floor(options.previewChars ?? DEFAULTS.previewChars),
  );
  const recentStart = Math.max(0, messages.length - preserveRecentMessages);
  const units: CompactionUnit[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const next = messages[index + 1];
    const paired =
      message.role === 'assistant' &&
      next?.role === 'user' &&
      hasMatchingToolResult(message, next);
    const grouped = paired ? [message, next] : [message];
    const end = index + grouped.length - 1;
    units.push({
      id: `unit-${index}`,
      messages: grouped,
      pinned: index === 0 || end >= recentStart,
      preview: unitPreview(grouped, previewChars),
    });
    index = end;
  }
  return units;
}

export function packWindows(
  units: readonly CompactionUnit[],
  maxWindowChars: number,
): CompactionUnit[][] {
  const windows: CompactionUnit[][] = [];
  let current: CompactionUnit[] = [];
  let currentChars = 0;
  for (const unit of units) {
    const size = unit.preview.length;
    if (current.length > 0 && currentChars + size > maxWindowChars) {
      windows.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(unit);
    currentChars += size;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

export function decideUnit(
  unit: Pick<CompactionUnit, 'id' | 'pinned'>,
  answer: { drop: number; kind: Kind; kindConfidence: number },
  config: Pick<ResolvedConfig, 'dropThreshold' | 'minKindConfidence' | 'protectedKinds'>,
): UnitDecision {
  if (unit.pinned) {
    return {
      id: unit.id,
      drop: 0,
      kind: 'other',
      kindConfidence: 0,
      action: 'keep',
      reason: 'pinned',
    };
  }
  const decision: UnitDecision = {
    id: unit.id,
    drop: answer.drop,
    kind: answer.kind,
    kindConfidence: answer.kindConfidence,
    action: 'keep',
    reason: 'below_threshold',
  };
  if (
    config.protectedKinds.has(answer.kind) &&
    answer.kindConfidence >= config.minKindConfidence
  ) {
    decision.reason = 'protected_kind';
  } else if (answer.drop < config.dropThreshold) {
    decision.reason = 'below_threshold';
  } else if (answer.kindConfidence < config.minKindConfidence) {
    decision.reason = 'low_confidence';
  } else {
    decision.action = 'drop';
    decision.reason = 'dropped';
  }
  return decision;
}

function messageChars(message: SessionMessage): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    total += tool.tool.length;
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
    total += tool.text?.length ?? 0;
  }
  for (const result of message.toolResults ?? []) {
    total += result.text.length + result.tool_use_id.length;
  }
  return total;
}

function goalFromMessages(messages: readonly SessionMessage[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (!message.toolResults || message.toolResults.length === 0),
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

function questionsFor(units: readonly CompactionUnit[]): Record<string, unknown> {
  return Object.fromEntries(
    units.flatMap((unit) => [
      [
        `drop_${unit.id}`,
        {
          type: 'noul',
          instructions: `Unit ${unit.id} can be removed from the conversation without losing information the assistant needs to continue the current task`,
        },
      ],
      [
        `kind_${unit.id}`,
        {
          type: 'choice',
          instructions: `What kind of information is in unit ${unit.id}?`,
          criteria: KIND_CRITERIA,
        },
      ],
    ]),
  );
}

function answerFor(
  answers: Record<string, JevAnswer>,
  unit: CompactionUnit,
): { drop: number; kind: Kind; kindConfidence: number } {
  const dropAnswer = answers[`drop_${unit.id}`];
  const kindAnswer = answers[`kind_${unit.id}`];
  if (
    !dropAnswer ||
    !('noul' in dropAnswer) ||
    typeof dropAnswer.noul !== 'number' ||
    !kindAnswer ||
    !('choice' in kindAnswer) ||
    typeof kindAnswer.choice !== 'string' ||
    !(kindAnswer.choice in KIND_CRITERIA) ||
    typeof kindAnswer.confidence !== 'number'
  ) {
    throw new Error(`Invalid Jev answers for ${unit.id}`);
  }
  return {
    drop: dropAnswer.noul,
    kind: kindAnswer.choice as Kind,
    kindConfidence: kindAnswer.confidence,
  };
}

async function askWindow(
  window: readonly CompactionUnit[],
  goal: string,
  config: ResolvedConfig,
  fetchFn: HookFetch,
): Promise<Map<string, UnitDecision>> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const response = await fetchFn(SYSTEM_ONE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      state: {
        goal,
        window: window.map((unit) => ({
          id: unit.id,
          role: unit.messages.map((message) => message.role).join('+'),
          preview: unit.preview,
        })),
      },
      questions: questionsFor(window),
    }),
  });
  if (!response.ok) {
    throw new Error(`TypeSafe request failed with HTTP ${response.status}`);
  }
  const parsed = JSON.parse(response.text) as JevResponse;
  if (!parsed.answers) throw new Error('TypeSafe response has no answers');
  return new Map(
    window.map((unit) => {
      const answer = answerFor(parsed.answers as Record<string, JevAnswer>, unit);
      return [
        unit.id,
        decideUnit(unit, answer, {
          dropThreshold: config.dropThreshold,
          minKindConfidence: config.minKindConfidence,
          protectedKinds: config.protectedKinds,
        }),
      ];
    }),
  );
}

export type CompactionOutput = {
  messages: SessionMessage[];
  decisions: UnitDecision[];
  charsBefore: number;
  charsAfter: number;
};

export async function compactWithFetch(
  messages: readonly SessionMessage[],
  options: ModConfig = {},
  fetchFn: HookFetch,
): Promise<CompactionOutput> {
  const config = resolveConfig(options);
  const units = groupMessages(messages, config);
  const candidates = units.filter((unit) => !unit.pinned);
  if (candidates.length === 0) {
    return {
      messages: [...messages],
      decisions: units.map((unit) =>
        decideUnit(unit, { drop: 0, kind: 'other', kindConfidence: 0 }, config),
      ),
      charsBefore: messages.reduce((sum, message) => sum + messageChars(message), 0),
      charsAfter: messages.reduce((sum, message) => sum + messageChars(message), 0),
    };
  }
  const windows = packWindows(candidates, config.maxWindowChars);
  const results = await Promise.all(
    windows.map((window) => askWindow(window, goalFromMessages(messages), config, fetchFn)),
  );
  const byId = new Map(results.flatMap((result) => [...result.entries()]));
  const decisions = units.map((unit) => {
    const decision = byId.get(unit.id);
    return (
      decision ??
      decideUnit(unit, { drop: 0, kind: 'other', kindConfidence: 0 }, config)
    );
  });
  const dropped = new Set(
    decisions
      .filter((decision) => decision.action === 'drop')
      .map((decision) => decision.id),
  );
  const keptUnits = units.filter((unit) => !dropped.has(unit.id));
  const kept = keptUnits.flatMap((unit) => unit.messages);
  return {
    messages: kept,
    decisions,
    charsBefore: messages.reduce((sum, message) => sum + messageChars(message), 0),
    charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
  };
}

export async function compactOrFallback(
  messages: readonly SessionMessage[],
  options: ModConfig = {},
  fetchFn: HookFetch,
): Promise<CompactionOutput | null> {
  const result = await compactWithFetch(messages, options, fetchFn);
  const reduction =
    result.charsBefore === 0
      ? 0
      : (result.charsBefore - result.charsAfter) / result.charsBefore;
  return reduction < (options.minReductionRatio ?? DEFAULTS.minReductionRatio)
    ? null
    : result;
}

function optionConfig(options: PluginOptions): ModConfig {
  return {
    apiKey: typeof options.apiKey === 'string' ? options.apiKey : undefined,
    dropThreshold: optionNumber(options, 'dropThreshold', DEFAULTS.dropThreshold),
    minKindConfidence: optionNumber(
      options,
      'minKindConfidence',
      DEFAULTS.minKindConfidence,
    ),
    preserveRecentMessages: optionNumber(
      options,
      'preserveRecentMessages',
      DEFAULTS.preserveRecentMessages,
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
    maxWindowChars: optionNumber(
      options,
      'maxWindowChars',
      DEFAULTS.maxWindowChars,
    ),
    previewChars: optionNumber(options, 'previewChars', DEFAULTS.previewChars),
    model: optionString(options, 'model', DEFAULTS.model),
  };
}

async function getApiKey(
  $: { env: { get: (name: string) => Promise<string | undefined> } },
  config: ModConfig,
): Promise<string | undefined> {
  return config.apiKey ?? (await $.env.get('TYPESAFE_API_KEY'));
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = optionConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const apiKey = await getApiKey($, configured);
      const result = await compactOrFallback(
        event.messages,
        { ...configured, apiKey },
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return {
            status: response.status,
            ok: response.ok,
            text: response.text,
          };
        },
      );
      if (!result) {
        $.ui.log(
          'fast-jev-compaction: fallback (reduction below minimum)',
        );
        return next(event);
      }
      return { messages: result.messages };
    } catch (error) {
      $.ui.log(
        `fast-jev-compaction: fallback (${error instanceof Error ? error.message : String(error)})`,
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
