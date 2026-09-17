import { chunkMessages } from './chunk.js';
import { compact } from './compact.js';
import type {
  Chunk,
  CompactOptions,
  CompactResult,
  Role,
} from './types.js';

export interface Message {
  role: Role;
  content: string;
}

export interface CompactMessagesOptions extends CompactOptions {}

export interface CompactMessagesResult {
  messages: Message[];
  result: CompactResult;
}

export async function compactMessages(
  messages: Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactMessagesResult> {
  const chunks: Chunk[] = messages.flatMap((message, turn) =>
    chunkMessages(
      [message],
      {
        mode:
          message.role === 'tool'
            ? 'line'
            : message.role === 'system'
              ? 'message'
              : 'sentence',
      },
    ).map((chunk) => ({ ...chunk, id: `${turn}-${chunk.id.split('-')[1]}` , turn })),
  );
  const result = await compact(chunks, options);
  const keptByTurn = new Map<number, Chunk[]>();
  for (const chunk of result.kept) {
    const group = keptByTurn.get(chunk.turn) ?? [];
    group.push(chunk);
    keptByTurn.set(chunk.turn, group);
  }
  const rebuilt = messages.flatMap((message, turn) => {
    const kept = keptByTurn.get(turn);
    if (!kept?.length) return [];
    return [{
      role: message.role,
      content: kept.map((chunk) => chunk.text).join('\n'),
    }];
  });
  return { messages: rebuilt, result };
}
