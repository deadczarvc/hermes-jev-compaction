# hermes-jev-compaction

Jev-powered compaction for **[Hermes Agent](https://github.com/NousResearch/hermes-agent)**.
A Hermes-specialized fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction): every tool call in a session transcript is scored by the
Jev decision model (TypeSafe System One API, `jev-1.13.0`); stale calls and
results are dropped or truncated, everything kept stays **verbatim** — no
lossy summaries. File paths, exact errors, and command outputs survive.

Languages: **English** · [Русский](HERMES.ru.md) · [中文](HERMES.zh-CN.md)

Deep dive: [HERMES.md](HERMES.md) · Upstream reference: [README-UPSTREAM.md](README-UPSTREAM.md)

## Why

Hermes compacts long sessions with an LLM summary. Summaries are lossy: a
path, an error line, or a constraint can vanish while still mattering. This
port replaces that with decisions: Jev sees the whole conversation (results
omitted, nothing rewritten) and answers two yes/no questions per tool call —
should the call stay, and should its result stay verbatim. Text is never
rewritten; only tool calls and results are deleted or truncated.

## What the port adds (vs upstream)

| File | Purpose |
|---|---|
| `src/hermes.ts` | Bidirectional adapter: OpenAI-chat messages (`role/content/tool_calls` + `role:"tool"`) ↔ library `Message[]`. Handles nested and flat tool-call spellings, content-part arrays, grouped tool results. |
| `bin/hermes-compact.mjs` | On-demand CLI: reads a transcript (JSON array / `{"messages":[...]}` / JSONL), runs Jev, writes the compacted transcript + stats. `--dry-run` maps without any API call. |
| `tests/` | 9 adapter tests (TypeScript) + 18 Python engine tests. Green: 32/32 vitest, 18/18 pytest. |
| `HERMES.md` | Integration details for Hermes users and agent-operated workflows. |


## Quick start

```bash
git clone https://github.com/deadczarvc/hermes-jev-compaction
cd hermes-jev-compaction
npm install && npm run build

export TYPESAFE_API_KEY=...        # your TypeSafe key (console.typesafe.ai)
node bin/hermes-compact.mjs transcript.json --model jev-1.13.0 --out compacted.json
```

Output: JSON `{"messages": [...], "stats": {...}}`.

Useful flags: `--goal <text>` (current task; default: system texts then last
user prompts), `--preserve-recent 6`, `--keep-threshold 0.5`,
`--dry-run`. Full list: `node bin/hermes-compact.mjs --help`.

## Library use

```ts
import { fromHermes, toHermes, hermesGoal } from './src/hermes.js';
import { compactMessages } from './dist/index.js';

const { messages, systemTexts } = fromHermes(hermesTranscript);
const result = await compactMessages(messages, {
  model: 'jev-1.13.0',          // jev-latest resolves here today; pin for reproducibility
  goal: hermesGoal(systemTexts),
});
const compacted = toHermes(result.messages);
```

## Tests

```bash
npx vitest run            # 32/32 (library + adapter)
python -m pytest tests/test_jev_engine.py   # 18/18 (Python engine)
```

## Hermes integration status

Today: on-demand — the agent or a session script runs the CLI over a
transcript when context pressure grows. In progress: a proper integration as a
Hermes **context engine plugin** (Hermes exposes a `ContextEngine`
extension point, `context.engine` in config.yaml), so compaction runs
in-session without core patches. See `HERMES.md` for the running notes.

## Credits & license

Thanks to [@MaximkaE](https://t.me/MaximkaE) for spotting three issues in the
Hermes adapter (system-message loss, receipt-data truncation, tool-input
privacy gap) — fixed in v0.3.2.


Library and Claude Code plugin by the upstream authors (MIT). Hermes adapter,
CLI, and docs in this fork: MIT.
