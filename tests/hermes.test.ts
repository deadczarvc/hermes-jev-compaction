import { describe, expect, it } from 'vitest';
import { fromHermes, hermesGoal, toHermes } from '../src/hermes.js';
import { collectToolCalls } from '../src/index.js';
import type { HermesMessage } from '../src/hermes.js';
import type { Message } from '../src/types.js';

const transcript: HermesMessage[] = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: [{ type: 'text', text: 'list files' }] },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: 'a.ts\nb.ts' },
  { role: 'assistant', content: 'two files' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ name: 'read', arguments: 'not-json' }],
  },
];

describe('fromHermes', () => {
  it('splits system texts out of the transcript', () => {
    const { messages, systemTexts } = fromHermes(transcript);
    expect(systemTexts).toEqual(['You are a coding agent.']);
    expect(messages.every((m) => m.role !== 'system' || false)).toBe(true);
  });

  it('maps flat tool results into one user message with toolResults', () => {
    const { messages } = fromHermes(transcript);
    const withResults = messages.filter((m) => m.toolResults && m.toolResults.length > 0);
    expect(withResults).toHaveLength(1);
    expect(withResults[0]!.toolResults![0]).toEqual({ tool_use_id: 'c1', text: 'a.ts\nb.ts' });
  });

  it('parses both nested and flat tool call spellings', () => {
    const { messages } = fromHermes(transcript);
    const first = messages[1]!.toolUses[0]!;
    expect(first).toMatchObject({ tool_use_id: 'c1', tool: 'bash', input: { command: 'ls' } });
    const second = messages[4]!.toolUses[0]!;
    expect(second.tool).toBe('read');
    expect(second.input).toEqual({ raw: 'not-json' });
  });

  it('joins content-array parts into text', () => {
    const { messages } = fromHermes(transcript);
    expect(messages[0]!.text).toBe('list files');
  });
});

describe('toHermes', () => {
  it('round-trips untouched messages to equivalent objects', () => {
    const { messages } = fromHermes(transcript);
    const back = toHermes(messages);
    const toolMsgs = back.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    const assistants = back.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(3);
    expect(assistants[0]!.tool_calls?.[0]).toMatchObject({
      id: 'c1',
      function: { name: 'bash', arguments: '{"command":"ls"}' },
    });
  });

  it('drops empty assistant messages (all calls removed)', () => {
    const empty: Message[] = [
      { role: 'assistant', text: '', toolUses: [] },
      { role: 'user', text: 'hi', toolUses: [] },
    ];
    expect(toHermes(empty)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps result-only and call+result pairs consistent', () => {
    const pair: Message = {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'x1', tool: 't', input: {} }],
      toolResults: [{ tool_use_id: 'x1', text: 'out' }],
    };
    const back = toHermes([pair]);
    expect(back).toHaveLength(2);
    expect(back[0]!.tool_calls).toHaveLength(1);
    expect(back[1]).toEqual({ role: 'tool', tool_call_id: 'x1', content: 'out' });
  });
});

describe('hermesGoal', () => {
  it('prefers explicit goal over system texts', () => {
    expect(hermesGoal(['sys'], 'goal text')).toBe('goal text');
    expect(hermesGoal(['sys a', 'sys b'])).toBe('sys a\nsys b');
    expect(hermesGoal([])).toBe('');
  });
});

describe('pairing sanity', () => {
  it('collectToolCalls pairs every mapped call with its result', () => {
    const { messages } = fromHermes(transcript);
    const calls = collectToolCalls(messages, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resultChars).toBe('a.ts\nb.ts'.length);
  });
});
