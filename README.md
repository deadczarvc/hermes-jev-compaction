# hermes-jev-compaction

> [!NOTE]
> **Security advisory resolved at [`4a55bef`](https://github.com/deadczarvc/hermes-jev-compaction/commit/4a55bef69033ae357ccc6eaff7da76582f14abf9).** The four audit findings from 2026-09-21 have been fixed and verified. See [SECURITY_ADVISORY.md](SECURITY_ADVISORY.md) for the resolution table and evidence.

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

## Fact rails (v0.5.0, refined in v0.6.0, v0.7.0 and v0.8.0)

Nothing Jev drops is erased any more. A reproducible read longer than 3000 chars shrinks to a one-line note;
any other result keeps its head, its fact lines (errors, HTTP codes, paths, versions, ids, counts, receipts)
and its tail, and results up to 6000 chars stay whole. When Jev is unreachable, the same rules run locally
(`mode = "fallback"`) instead of leaving the history untouched. On the latest blind held-out round (v0.6.0)
the engine kept 50/50 preregistered facts (v0.4.x: 4/50) at a 45% token reduction (v0.4.x: 88%). Rules and evidence:
[docs/fact-rails.md](docs/fact-rails.md). Since v0.7.0 a compaction frees what the prompt needs rather than a fixed
share, cuts where the fewest facts are lost, and saves the full output of every reduced result to a file named in
its note, so across repeated compactions every preregistered fact stays in the context or one read away. Since v0.8.0 a stub's fact lines are
chosen by how likely the agent is to use their tokens (a model checked on sessions it never saw: +12 … +16 pts of the
tokens used later, +12 … +29 of error lines, no stub longer).
The same rules run in Claude Code:
[deadczarvc-labs/jev-factkeep-compaction](https://github.com/deadczarvc-labs/jev-factkeep-compaction).

## What the port adds (vs upstream)

| File | Purpose |
|---|---|
| `src/hermes.ts` | Bidirectional adapter: OpenAI-chat messages (`role/content/tool_calls` + `role:"tool"`) ↔ library `Message[]`. Handles nested and flat tool-call spellings, content-part arrays, grouped tool results. |
| `bin/hermes-compact.mjs` | On-demand CLI: reads a transcript (JSON array / `{"messages":[...]}` / JSONL), runs Jev, writes the compacted transcript + stats. `--dry-run` maps without any API call. |
| `tests/` | TypeScript adapter tests + Python engine tests. Green: 32/32 vitest, 97/97 pytest. |
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
# Python engine tests need the Hermes core on PYTHONPATH (plugin imports agent.context_engine):
PYTHONPATH=<path-to-hermes-agent-repo> python -m pytest tests/   # 83/83
```

## Hermes integration status

In-session: `hermes-plugin/` is a Hermes **context engine plugin** (the
`ContextEngine` extension point). Copy it to `~/.hermes/plugins/jev-context-engine/`
and set `context.engine: jev` in config.yaml; compaction then runs inside the
session without core patches. The CLI above stays for on-demand use. See
`HERMES.md` for the running notes.

## Threshold calibration

See [docs/threshold-analysis.md](docs/threshold-analysis.md) for the mathematical
model behind `keep_threshold: 0.5` — flip-rate measurements across 5 tool
fixtures × 5 repeats, and a 250-tool context-loss simulation at various
thresholds.

## Credits & license

Thanks to [@MaximkaE](https://t.me/MaximkaE) for spotting three issues in the
Hermes adapter (system-message loss, receipt-data truncation, tool-input
privacy gap) — fixed in v0.3.2.

Thanks to [litshing](https://github.com/litshing) for the
[usage envelope](https://github.com/litshing/jevcore/blob/main/docs/specs/2026-09-19-jev-usage-envelope.md)
defining where Jev judgements are safe to use, and for identifying the
IndexError invariant (Hermes captures message count before the prune seam).


Library and Claude Code plugin by the upstream authors (MIT). Hermes adapter,
CLI, and docs in this fork: MIT.
