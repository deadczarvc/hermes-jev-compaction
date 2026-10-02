# hermes-jev-compaction — Hermes integration notes

Start with the [README](README.md). Languages: **English** · [Русский](HERMES.ru.md) · [中文](HERMES.zh-CN.md).

The fork runs Jev compaction inside Hermes Agent in two ways:

- **In session** — `hermes-plugin/` is a Hermes context engine plugin (`jev-context-engine`, the `ContextEngine`
  extension point). Hermes calls it whenever its context crosses the compression threshold; no core patch.
- **On demand** — `bin/hermes-compact.mjs` maps an OpenAI-chat transcript onto the library's `Message[]`, runs the
  Jev decision engine (TypeSafe System One API, `jev-1.13.0`) and maps the result back.

Both keep the fact rails of [docs/fact-rails.md](docs/fact-rails.md): a dropped call keeps its row, a reproducible read
shrinks to a note, any other result keeps its head, its fact lines and its tail, and the full output is saved to a
file named in the note.

## Install

```bash
git clone https://github.com/deadczarvc/hermes-jev-compaction
cd hermes-jev-compaction
npm install && npm run build
```

Requires Node >= 18 for the CLI and the library; the plugin needs only the Hermes Python environment.

## In-session plugin

1. Copy `hermes-plugin/` to `~/.hermes/plugins/jev-context-engine/`.
2. Set `context.engine: jev` in `config.yaml`.
3. Put `TYPESAFE_API_KEY` in the Hermes `.env` (it is loaded into the process environment at startup).

Optional settings under `context.jev`: `model` (default `jev-1.13.0`), `keep_threshold` (0.5), `max_state_tokens`
(25000), `max_request_tokens` (30000), `egress_mode` (`metadata` by default: no result text leaves the process;
also `redacted_text`, `full_text`, `off` — unknown values send nothing).

Switches, all on by default (`=0` turns one off):

| Variable | Off restores |
|---|---|
| `JEV_COMPACTION_SAVE_OUTPUTS` | no saved full outputs; the note points to `state.db` |
| `JEV_COMPACTION_VALUE_SELECT` | regex fact lines of v0.7.x instead of learned token value |
| `JEV_COMPACTION_POOL` | a separate fact budget per stub (v0.8) |
| `JEV_COMPACTION_CONTAIN` | v0.9 coverage, without tokens readable inside longer ones |

When Jev is unreachable the same rules run locally (`mode = "fallback"`): no HTTP, no summary.

## CLI: hermes-compact

```bash
export TYPESAFE_API_KEY=...   # your TypeSafe key (console.typesafe.ai)
node bin/hermes-compact.mjs transcript.json --out compacted.json
```

Input: JSON array of OpenAI-chat messages, `{"messages": [...]}` or JSONL.
Output: JSON `{"messages": [...], "stats": {...}}`.

Key options: `--model jev-1.13.0` (pin; default `jev-latest`), `--goal`, `--keep-threshold`, `--preserve-recent`,
`--max-state-tokens`, `--max-request-tokens`, `--truncate-head`, `--dry-run` (mapping report, no key needed).
Full list: `node bin/hermes-compact.mjs --help`.

## Library use

```ts
import { fromHermes, toHermes, hermesGoal } from './src/hermes.js';
import { compactMessages } from './dist/index.js';

const transcript = fromHermes(hermesMessages);
const result = await compactMessages(transcript.messages, {
  model: 'jev-1.13.0',
  goal: hermesGoal(transcript.systemTexts),
});
const compacted = toHermes(result.messages, transcript);
```

Passing the transcript back to `toHermes` keeps everything the mapping does not model (images, unknown roles,
opaque fields, raw arguments): an all-keep round trip equals the input. `HermesMessage.content` may be a string or a
content-part array; tool calls may be nested (`function: {name, arguments}`) or flat (`name`, `arguments`).

## Testing

```bash
npm run build                 # the CLI tests run dist/
npx vitest run                # 41/41 (library, adapter, CLI)
PYTHONPATH=<path-to-hermes-agent> python -m pytest tests/   # 99/99 (plugin; imports agent.context_engine)
```

Counts are those of v0.10.0.
