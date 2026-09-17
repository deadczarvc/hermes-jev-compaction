export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Chunk {
  id: string;
  role: Role;
  turn: number;
  text: string;
  pinned?: boolean;
}

export type ChunkKind =
  | 'user_instruction'
  | 'decision'
  | 'file_reference'
  | 'error'
  | 'pending_task'
  | 'stale_tool_output'
  | 'chatter'
  | 'other';

export interface ChunkDecision {
  id: string;
  drop: number;
  kind: ChunkKind;
  kindConfidence: number;
  action: 'keep' | 'drop';
  reason:
    | 'pinned'
    | 'recent'
    | 'protected_kind'
    | 'below_threshold'
    | 'low_confidence'
    | 'dropped';
}

export interface CompactOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  goal?: string;
  dropThreshold?: number;
  minKindConfidence?: number;
  protectedKinds?: ChunkKind[];
  preserveRecentTurns?: number;
  maxQuestionsPerCall?: number;
  fetch?: typeof fetch;
}

export interface CompactResult {
  kept: Chunk[];
  dropped: Chunk[];
  decisions: ChunkDecision[];
  stats: {
    chunks: number;
    kept: number;
    dropped: number;
    calls: number;
    charsBefore: number;
    charsAfter: number;
    ms: number;
  };
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JevState = string | JsonValue;

export interface NoulQuestion {
  type: 'noul';
  instructions: string | JsonValue;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string | JsonValue;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string | JsonValue;
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
