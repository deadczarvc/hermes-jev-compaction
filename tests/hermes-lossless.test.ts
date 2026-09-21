import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { compact } from '../src/compact.js';
import { fromHermes, toHermes } from '../src/hermes.js';
import type { HermesMessage } from '../src/hermes.js';
import type { JevAsker } from '../src/types.js';

const allKeep: JevAsker = {
  async ask(_state, questions) {
    return {
      answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 1 }])),
    };
  },
};

const losslessTranscript: HermesMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'input_text', text: 'before image' },
      { type: 'input_image', image_url: 'opaque://image', detail: 'high' },
      { type: 'input_text', text: ' after image' },
    ],
    vendor_user: { untouched: true },
  },
  { role: 'developer', content: [{ type: 'input_image', image_url: 'opaque://developer' }], developer_meta: 7 },
  { role: 'system', content: null, system_meta: { mustStay: 'middle' } },
  {
    role: 'assistant',
    content: [{ type: 'output_text', text: 'calling tool' }, { type: 'image', url: 'opaque://assistant' }],
    tool_calls: [
      {
        id: 'native-call-1',
        type: 'function',
        function: { name: 'shell', arguments: ' { "command" : "echo spaced" } ' },
        call_meta: { opaque: true },
      },
    ],
    reasoning: { encrypted: 'keep-me' },
  },
  {
    role: 'tool',
    tool_call_id: 'native-call-1',
    content: [{ type: 'output_text', text: 'tool output' }, { type: 'image', url: 'opaque://tool' }],
    error: true,
    tool_meta: { opaque: true },
  },
  { role: 'mystery-role', content: '', opaque: { error: 'retain' } },
  { role: 'assistant', content: null, finish_reason: 'stop' },
];

describe('lossless Hermes projection', () => {
  it('returns byte-for-structure identical native records when every decision is KEEP', async () => {
    const projected = fromHermes(losslessTranscript);
    expect(projected.messages.flatMap((message) => message.toolResults ?? [])).toContainEqual(
      expect.objectContaining({ tool_use_id: 'native-call-1', isError: true }),
    );
    const result = await compact(projected.messages, allKeep, { preserveRecentMessages: 0 });
    expect(toHermes(result.messages, projected)).toEqual(losslessTranscript);
  });

  it('changes only the matched source tool result for an explicit result drop', async () => {
    const source: HermesMessage[] = [
      { role: 'user', content: 'start', user_meta: { untouched: true } },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'safe-id', type: 'function', function: { name: 'x', arguments: 'not-json  ' } }],
        reasoning: { opaque: true },
      },
      {
        role: 'tool',
        tool_call_id: 'safe-id',
        content: 'x'.repeat(600),
        error: true,
        result_meta: { preserve: true },
      },
    ];
    const projected = fromHermes(source);
    const askDropResult: JevAsker = {
      async ask(_state, questions) {
        return {
          answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: key.startsWith('call_') ? 1 : 0 }])),
        };
      },
    };
    const result = await compact(projected.messages, askDropResult, {
      preserveRecentMessages: 0,
      truncateHeadChars: 10,
    });
    const restored = toHermes(result.messages, projected);
    expect(restored).toHaveLength(source.length);
    expect(restored[0]).toEqual(source[0]);
    expect(restored[1]).toEqual(source[1]);
    expect(restored[2]).toMatchObject({ role: 'tool', tool_call_id: 'safe-id', error: true, result_meta: { preserve: true } });
    expect(restored[2]!.content).not.toEqual(source[2]!.content);
    expect(restored[2]!.content).toContain('[fast-jev-compaction truncated');
  });

  it('refuses to mutate missing or duplicate native IDs', async () => {
    const source: HermesMessage[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'duplicate', function: { name: 'a', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'duplicate', function: { name: 'b', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'duplicate', content: 'result', opaque: true },
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'missing-id', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: 'unmappable', opaque: true },
    ];
    const projected = fromHermes(source);
    const dropEverything: JevAsker = {
      async ask(_state, questions) {
        return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0 }])) };
      },
    };
    const result = await compact(projected.messages, dropEverything, { preserveRecentMessages: 0 });
    expect(toHermes(result.messages, projected)).toEqual(source);
  });

  it('lossless controls reject opaque-field stripping and source-order movement', () => {
    const restored = toHermes(fromHermes(losslessTranscript).messages, fromHermes(losslessTranscript));
    const stripOpaque = (messages: HermesMessage[]) => messages.map(({ vendor_user, ...message }) => message);
    const moveMiddleSystem = (messages: HermesMessage[]) => [messages[2]!, messages[0]!, ...messages.slice(1, 2), ...messages.slice(3)];
    expect(stripOpaque(restored)).not.toEqual(losslessTranscript);
    expect(moveMiddleSystem(restored)).not.toEqual(losslessTranscript);
  });

  it.each(['array', 'container', 'jsonl'] as const)('CLI --dry-run preserves %s input and performs no request', (format) => {
    const directory = mkdtempSync(join(tmpdir(), 'hermes-lossless-'));
    const input = join(directory, `input.${format === 'jsonl' ? 'jsonl' : 'json'}`);
    const output = join(directory, 'out.json');
    const serialized =
      format === 'array'
        ? JSON.stringify(losslessTranscript)
        : format === 'container'
          ? JSON.stringify({ messages: losslessTranscript })
          : losslessTranscript.map((message) => JSON.stringify(message)).join('\n');
    try {
      writeFileSync(input, serialized);
      const run = spawnSync(process.execPath, [resolve('bin/hermes-compact.mjs'), input, '--dry-run', '--out', output], {
        encoding: 'utf8',
        env: { ...process.env, TYPESAFE_API_KEY: '' },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, 'utf8')).messages).toEqual(losslessTranscript);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['Infinity', 'NaN'])('CLI rejects malformed numeric flags: %s', (value) => {
    const run = spawnSync(process.execPath, [resolve('bin/hermes-compact.mjs'), 'missing.json', '--dry-run', '--truncate-head', value], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('not a number for --truncate-head');
  });
});
