import { JevClient } from './client.js';
import type {
  Chunk,
  ChunkDecision,
  ChunkKind,
  CompactOptions,
  CompactResult,
  JevAnswer,
  JevQuestions,
} from './types.js';

const DEFAULT_DROP_THRESHOLD = 0.8;
const DEFAULT_MIN_KIND_CONFIDENCE = 0.5;
const DEFAULT_PROTECTED_KINDS: ChunkKind[] = [
  'user_instruction',
  'pending_task',
];
const DEFAULT_PRESERVE_RECENT_TURNS = 2;
export const DEFAULT_MAX_QUESTIONS_PER_CALL = 64;

const KIND_CRITERIA: Record<ChunkKind, string> = {
  user_instruction: 'An instruction, constraint, preference, or request from the user',
  decision: 'A design/implementation decision or key finding',
  file_reference: 'Names a file path, symbol, command, URL or identifier that will be needed',
  error: 'An error message or its fix',
  pending_task: 'Work that still needs to be done',
  stale_tool_output: 'Tool/file/log output that has already been acted on',
  chatter: 'Greetings, acknowledgements, filler',
  other: 'Other content that does not fit the categories above',
};

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Unexpected Jev response: ${label} must be a number`);
  }
  return value;
}

function requireAnswers(response: { answers?: unknown }): Record<string, JevAnswer> {
  if (!response.answers || typeof response.answers !== 'object') {
    throw new Error(
      `Unexpected Jev response: expected an answers object, got ${JSON.stringify(response)}`,
    );
  }
  return response.answers as Record<string, JevAnswer>;
}

function choiceAnswer(
  answers: Record<string, JevAnswer>,
  id: string,
): { choice: ChunkKind; confidence: number } {
  const answer = answers[`kind_${id}`];
  if (!answer || typeof answer !== 'object' || !('choice' in answer)) {
    throw new Error(
      `Unexpected Jev response: missing choice answer kind_${id}`,
    );
  }
  if (!(answer.choice in KIND_CRITERIA)) {
    throw new Error(
      `Unexpected Jev response: unknown chunk kind for ${id}: ${String(answer.choice)}`,
    );
  }
  return {
    choice: answer.choice as ChunkKind,
    confidence: requireNumber(answer.confidence, `kind_${id}.confidence`),
  };
}

function dropAnswer(
  answers: Record<string, JevAnswer>,
  id: string,
): number {
  const answer = answers[`drop_${id}`];
  if (!answer || typeof answer !== 'object' || !('noul' in answer)) {
    throw new Error(
      `Unexpected Jev response: missing noul answer drop_${id}`,
    );
  }
  return requireNumber(answer.noul, `drop_${id}.noul`);
}

function makeQuestions(batch: Chunk[]): JevQuestions {
  return Object.fromEntries(
    batch.flatMap((chunk) => [
      [
        `drop_${chunk.id}`,
        {
          type: 'noul' as const,
          instructions: `Chunk ${chunk.id} can be removed from the transcript without losing information needed to continue the task.`,
        },
      ],
      [
        `kind_${chunk.id}`,
        {
          type: 'choice' as const,
          instructions: `What kind of information is in chunk ${chunk.id}?`,
          criteria: KIND_CRITERIA,
        },
      ],
    ]),
  );
}

function makeState(
  chunks: Chunk[],
  goal?: string,
): { goal: string; transcript: Omit<Chunk, 'pinned'>[] } {
  return {
    goal: goal ?? '',
    transcript: chunks.map(({ id, role, turn, text }) => ({
      id,
      role,
      turn,
      text,
    })),
  };
}

function baseDecision(chunk: Chunk, reason: ChunkDecision['reason']): ChunkDecision {
  return {
    id: chunk.id,
    drop: 0,
    kind: 'other',
    kindConfidence: 0,
    action: 'keep',
    reason,
  };
}

export async function compact(
  chunks: Chunk[],
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const dropThreshold = options.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
  const minKindConfidence =
    options.minKindConfidence ?? DEFAULT_MIN_KIND_CONFIDENCE;
  const protectedKinds = new Set(
    options.protectedKinds ?? DEFAULT_PROTECTED_KINDS,
  );
  const preserveRecentTurns =
    options.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT_TURNS;
  const maxQuestions =
    options.maxQuestionsPerCall ?? DEFAULT_MAX_QUESTIONS_PER_CALL;
  if (maxQuestions < 2) {
    throw new Error('maxQuestionsPerCall must be at least 2');
  }
  const batchSize = Math.floor(maxQuestions / 2);
  const maxTurn = chunks.reduce(
    (maximum, chunk) => Math.max(maximum, chunk.turn),
    0,
  );
  const recentCutoff = maxTurn - preserveRecentTurns + 1;
  const candidates = chunks.filter(
    (chunk) => !chunk.pinned && chunk.turn < recentCutoff,
  );
  const batches: Chunk[][] = [];
  for (let index = 0; index < candidates.length; index += batchSize) {
    batches.push(candidates.slice(index, index + batchSize));
  }

  const client = new JevClient(options);
  const responses = await Promise.all(
    batches.map(async (batch) => ({
      batch,
      response: await client.ask(
        makeState(chunks, options.goal),
        makeQuestions(batch),
      ),
    })),
  );
  const answers = new Map<string, JevAnswer>();
  for (const { response } of responses) {
    for (const [id, answer] of Object.entries(requireAnswers(response))) {
      answers.set(id, answer);
    }
  }

  const answerRecord = Object.fromEntries(answers);
  const decisions = chunks.map((chunk) => {
    if (chunk.pinned) return baseDecision(chunk, 'pinned');
    if (chunk.turn >= recentCutoff) return baseDecision(chunk, 'recent');
    const kindAnswer = choiceAnswer(answerRecord, chunk.id);
    const drop = dropAnswer(answerRecord, chunk.id);
    const decision: ChunkDecision = {
      id: chunk.id,
      drop,
      kind: kindAnswer.choice,
      kindConfidence: kindAnswer.confidence,
      action: 'keep',
      reason: 'below_threshold',
    };
    if (
      protectedKinds.has(kindAnswer.choice) &&
      kindAnswer.confidence >= minKindConfidence
    ) {
      decision.reason = 'protected_kind';
    } else if (drop < dropThreshold) {
      decision.reason = 'below_threshold';
    } else if (kindAnswer.confidence < minKindConfidence) {
      decision.reason = 'low_confidence';
    } else {
      decision.action = 'drop';
      decision.reason = 'dropped';
    }
    return decision;
  });
  const droppedIds = new Set(
    decisions.filter((decision) => decision.action === 'drop').map((decision) => decision.id),
  );
  const kept = chunks.filter((chunk) => !droppedIds.has(chunk.id));
  const dropped = chunks.filter((chunk) => droppedIds.has(chunk.id));
  const charsBefore = chunks.reduce((total, chunk) => total + chunk.text.length, 0);
  const charsAfter = kept.reduce((total, chunk) => total + chunk.text.length, 0);
  return {
    kept,
    dropped,
    decisions,
    stats: {
      chunks: chunks.length,
      kept: kept.length,
      dropped: dropped.length,
      calls: batches.length,
      charsBefore,
      charsAfter,
      ms: Date.now() - started,
    },
  };
}
