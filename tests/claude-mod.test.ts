import { describe, expect, it } from 'vitest';
import {
  compactOrFallback,
  decideUnit,
  groupMessages,
  packWindows,
  type CompactionUnit,
} from '../plugin/hooks/fast-jev.ts';

type Message = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: Array<{
    tool_use_id: string;
    tool: string;
    input: Record<string, unknown>;
  }>;
  toolResults?: Array<{
    tool_use_id: string;
    text: string;
    isError: boolean;
  }>;
};

function message(
  role: Message['role'],
  text: string,
  extra: Partial<Message> = {},
): Message {
  return { role, text, toolUses: [], ...extra };
}

function units(...previews: string[]): CompactionUnit[] {
  return previews.map((preview, index) => ({
    id: `unit-${index}`,
    messages: [message('user', preview)],
    pinned: false,
    preview,
  }));
}

describe('Claude Code mod pure logic', () => {
  it('groups an assistant tool call with its following tool result', () => {
    const grouped = groupMessages([
      message('user', 'start'),
      message('assistant', '', {
        toolUses: [
          { tool_use_id: 'tool-1', tool: 'Read', input: { file: 'a.ts' } },
        ],
      }),
      message('user', '', {
        toolResults: [
          { tool_use_id: 'tool-1', text: 'contents', isError: false },
        ],
      }),
      message('assistant', 'done'),
    ], { preserveRecentMessages: 0 });

    expect(grouped).toHaveLength(3);
    expect(grouped[1]?.messages).toHaveLength(2);
    expect(grouped[1]?.messages[0]?.role).toBe('assistant');
    expect(grouped[1]?.messages[1]?.toolResults?.[0]?.tool_use_id).toBe('tool-1');
  });

  it('pins the first unit and newest messages', () => {
    const grouped = groupMessages(
      [
        message('user', 'first'),
        message('assistant', 'old'),
        message('user', 'new'),
      ],
      { preserveRecentMessages: 1 },
    );

    expect(grouped.map((unit) => unit.pinned)).toEqual([true, false, true]);
  });

  it('packs windows without exceeding the character budget after the first unit', () => {
    const packed = packWindows(units('1234', '5678', '90'), 8);
    expect(packed.map((window) => window.map((unit) => unit.preview))).toEqual([
      ['1234', '5678'],
      ['90'],
    ]);
  });

  it('applies the requested decision matrix', () => {
    const config = {
      dropThreshold: 0.8,
      minKindConfidence: 0.5,
      protectedKinds: new Set(['user_instruction' as const]),
    };
    const unit = { id: 'unit-1', pinned: false };
    expect(decideUnit(unit, {
      drop: 0.99,
      kind: 'user_instruction',
      kindConfidence: 0.9,
    }, config).reason).toBe('protected_kind');
    expect(decideUnit(unit, {
      drop: 0.2,
      kind: 'other',
      kindConfidence: 0.9,
    }, config).reason).toBe('below_threshold');
    expect(decideUnit(unit, {
      drop: 0.9,
      kind: 'other',
      kindConfidence: 0.2,
    }, config).reason).toBe('low_confidence');
    expect(decideUnit(unit, {
      drop: 0.9,
      kind: 'other',
      kindConfidence: 0.9,
    }, config).action).toBe('drop');
    expect(decideUnit({ id: 'unit-0', pinned: true }, {
      drop: 1,
      kind: 'other',
      kindConfidence: 1,
    }, config).reason).toBe('pinned');
  });

  it('falls back when the estimated reduction is too small', async () => {
    const messages = [
      message('user', 'pinned context'),
      message('assistant', 'small candidate'),
    ];
    const fallback = await compactOrFallback(
      messages,
      {
        apiKey: 'test-key',
        preserveRecentMessages: 0,
        minReductionRatio: 0.9,
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body ?? '{}') as {
          questions: Record<string, { type: string }>;
        };
        const answers = Object.fromEntries(
          Object.keys(body.questions).map((key) => [
            key,
            key.startsWith('drop_')
              ? { type: 'noul', noul: 0.1 }
              : { type: 'choice', choice: 'other', confidence: 0.9 },
          ]),
        );
        return { status: 200, ok: true, text: JSON.stringify({ answers }) };
      },
    );

    expect(fallback).toBeNull();
  });
});
