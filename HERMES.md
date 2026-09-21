# hermes-jev-compaction — Hermes integration notes

Start with the [README](README.md). Languages: [English](README.md) · [Русский](HERMES.ru.md) · [中文](HERMES.zh-CN.md).

This fork adds a Hermes Agent port of fast-jev-compaction: map an OpenAI-chat
transcript onto the library's `Message[]`, run the Jev decision engine
(TypeSafe System One API, `jev-1.13.0`), and map the result back.

Nothing else from upstream is changed: same library, same tests, same
semantics. The upstream Claude Code hooks are irrelevant for Hermes
(Hermes has no compaction hook event; compression lives in core) — so this
port ships a **library adapter + on-demand CLI** instead.

## Install

```bash
git clone https://github.com/deadczarvc/hermes-jev-compaction
cd fast-jev-compaction
npm install && npm run build
```

Requires Node >= 18.

## CLI: hermes-compact

```bash
export TYPESAFE_API_KEY=...   # your TypeSafe key (console.typesafe.ai)
node bin/hermes-compact.mjs transcript.json --out compacted.json
```

Input: JSON array of OpenAI-chat messages, `{"messages": [...]}` or JSONL.
Output: JSON `{"messages": [...], "stats": {...}}`.

Key options: `--model jev-1.13.0` (pin; default `jev-latest`), `--goal`,
`--keep-threshold`, `--preserve-recent`, `--max-state-tokens`,
`--max-request-tokens`, `--truncate-head`, `--dry-run` (mapping report, no
key needed). Full list: `node bin/hermes-compact.mjs --help`.

## Library use

```ts
import { fromHermes, toHermes, hermesGoal } from './src/hermes.js';
import { compactMessages } from './dist/index.js';

const { messages, systemTexts } = fromHermes(hermesTranscript);
const result = await compactMessages(messages, {
  model: 'jev-1.13.0',
  goal: hermesGoal(systemTexts),
});
const compacted = toHermes(result.messages);
```

Semantics are identical to the library: kept messages stay verbatim (original
objects), dropped results keep a bounded head + note, dropped calls disappear
with their results. `HermesMessage.content` may be a string or a content-part
array; tool calls may be nested (`function: {name, arguments}`) or flat
(`name`, `arguments`). Non-text content parts (e.g. images) are ignored by
the text mapping — tool inputs keep their full structured content.

## Testing

```bash
npx vitest run   # 41/41 vitest + 69/69 pytest tests
```

## Why on-demand, not a hook

Hermes 0.21.x exposes shell hooks on `pre_tool_call`, `post_tool_call`,
`pre_llm_call`, `on_session_start` — no compaction event, and compression
lives in `agent/conversation_compression.py` (core). Patching core dies on the
next update. An issue proposing a compaction hook/extension point is filed
upstream of the agent; until then the supported integration is this CLI +
library adapter, invoked on demand from a session or a scheduled job.
