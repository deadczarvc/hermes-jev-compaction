import type { Chunk, Role } from './types.js';

export type ChunkMode = 'line' | 'sentence' | 'message';

export interface ChunkMessagesOptions {
  mode?: ChunkMode;
}

function splitText(text: string, mode: ChunkMode): string[] {
  if (mode === 'message') return text.trim() ? [text.trim()] : [];
  const pieces =
    mode === 'line'
      ? text.split(/\r?\n/)
      : text.split(/(?<=[.!?])\s+|\n+/);
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

function mergeShortPieces(pieces: string[]): string[] {
  const merged: string[] = [];
  for (const piece of pieces) {
    if (piece.length < 20 && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${piece}`;
    } else {
      merged.push(piece);
    }
  }
  return merged;
}

export function chunkMessages(
  messages: { role: Role; content: string }[],
  options: ChunkMessagesOptions = {},
): Chunk[] {
  const mode = options.mode ?? 'message';
  return messages.flatMap((message, turn) => {
    const pieces = mode === 'sentence'
      ? mergeShortPieces(splitText(message.content, mode))
      : splitText(message.content, mode);
    return pieces.map((text, index) => ({
      id: `${turn}-${index}`,
      role: message.role,
      turn,
      text,
      ...(message.role === 'system' ? { pinned: true } : {}),
    }));
  });
}
