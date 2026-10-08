export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped' | 'unscored';
}

export type JevTerminalCode = 'none' | 'network' | 'http_4xx' | 'http_5xx' | 'rate_limited' | 'deadline' | 'contract' | 'unknown';

/** Round-local counts; cached, pinned, reduced and state-budget floor calls are excluded. */
export interface JevRoundCounts {
  attempts: number;
  retries: number;
  parsed: number;
  scoredCalls: number;
  unscoredCalls: number;
}

export interface JevRoundStats extends JevRoundCounts {
  completion: 'complete' | 'partial';
  terminalCode: JevTerminalCode;
}

/** Metadata-only observation of the existing round; never selects facts or changes request budgets. */
export interface RoundObservation {
  completion: 'complete' | 'partial' | 'failed';
  terminal_code: JevTerminalCode;
  requests_planned: number | null;
  attempts: number;
  retries: number;
  parsed: number;
  scored_calls: number;
  unscored_calls: number;
  fresh: number;
  cache: number;
  floor: number;
  reduced: number;
  pinned: number;
  request_estimated_max: number | null;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  usage_responses: number;
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number;
  /** Deadline for the entire Jev round, including all batches and response bodies. Default 120000 ms. */
  compactionTimeoutMs?: number;
  /** Cancelable host timer; the hook supplies $.clock.sleep, the library uses a native timer. */
  deadlineSleep?: (ms: number, options: { signal: AbortSignal }) => Promise<void>;
  /** Total attempts per logical batch, including the first. Integer 1..4; default 3. */
  maxJevAttempts?: number;
  /** Worker slots, including retry pauses. Integer 1..8; default 4. */
  maxConcurrentJevRequests?: number;
  /** Retain unresolved original pairs, or reject the entire fresh round. Default retain-unscored. */
  partialAnswers?: 'retain-unscored' | 'rollback';
  /** Cancelable backoff, separate from the round deadline timer. Defaults to a native timer. */
  retrySleep?: (ms: number, options: { signal: AbortSignal }) => Promise<void>;
  /** Clock for absolute round guards; the hook supplies $.clock.now. Defaults to Date.now. */
  nowMs?: () => Promise<number>;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
  /**
   * Jev's answers from an earlier compaction of the same session, by `tool_use_id`. Calls found here are not asked
   * again (re-asking gave the same action on 711/711 calls). `compact` adds the new answers to a mutable map.
   */
  knownAnswers?: Map<string, CallAnswer>;
  /**
   * The char reduction the rails must reach (default 0.3). The hook passes what the context window needs (see
   * `pressure` in hooks/fast-jev.ts), so a compaction gives up no more facts than the window requires.
   */
  minReduction?: number;
  /**
   * Values masked exactly wherever they appear in what is sent to Jev, on top of the secret families (the hook passes
   * its own API key). Masking runs before the history is cut to fit, so a value split by a cut is masked too.
   */
  secrets?: readonly string[];
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  compactionTimeoutMs: number;
  maxJevAttempts: number;
  maxConcurrentJevRequests: number;
  partialAnswers: 'retain-unscored' | 'rollback';
  retrySleep: NonNullable<CompactOptions['retrySleep']>;
  nowMs: NonNullable<CompactOptions['nowMs']>;
  truncateHeadChars: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    requests: number;
    /** Present only for a planned Jev round. Actual sends and accepted complete pairs, not host application. */
    jev?: Readonly<JevRoundStats>;
    ms: number;
    /** Rail tier used (0 = strictest); a higher tier gave up rails to clear the reduction floor. */
    railTier?: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse>;
}
