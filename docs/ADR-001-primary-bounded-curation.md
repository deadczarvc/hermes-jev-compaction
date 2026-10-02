# ADR-001: Jev as the primary bounded-curation stage in Hermes compaction

## Decision

Jev (TypeSafe System One) is the **primary bounded-curation stage** of Hermes
context compaction. It decides which tool calls and results to keep, drop, or
truncate. The Hermes built-in summarizer is **removed from the hot path** when
`context.engine: jev` is active.

## Context

Hermes compacts context when it exceeds a threshold. The default engine uses
an LLM to write a summary, which loses identifiers, receipts, and failure
history. Jev replaces this with per-tool-call keep/drop decisions: kept rows
stay verbatim, dropped rows are stubbed or truncated, and the decision is
made by a dedicated decision network (not a generative LLM), producing
minimal hallucination on the keep/drop boundary.

## Consequences

- **What Jev does**: scores each non-pinned tool call/result pair via
  `keepCall`/`keepResult` noul scores; applies decisions via `_apply()`.
- **What Jev does NOT do**: rewrite user/assistant prose, summarize code,
  or generate new text. Non-tool messages always stay verbatim.
- **Safety nets**: `_RECEIPT_RE` preserves confirmation IDs deeper than the
  truncation head; `_has_identifier` biases toward keeping paths/IDs;
  `_fallback_prune` is the deterministic degrade path on Jev failure (since v0.5.0 it applies the
  fact rails of `docs/fact-rails.md`, `mode = "fallback"`, with no HTTP).
- **Recovery**: `get_status()["dropped_recent"]` exposes the last 20 dropped
  calls with full content; `session_events` records the lifecycle phase.

## Acceptance criteria (machine-checkable)

1. `context.engine == "jev"` in config.yaml.
2. `pytest tests/ -q` → all passed (71 when this record was written, 99 at v0.10.0; includes egress, fidelity,
   budget, corpus, telemetry and fact-rails suites).
3. `npm run build && vitest run --no-cache` → all passed (41; includes lossless adapter + golden corpus + CLI).
4. `tsc --noEmit` → exit 0.
5. `SECURITY_ADVISORY.md` — all findings marked RESOLVED with fixing commits.
6. `get_status()` returns non-null `session_settings` after `on_session_start`.
7. `_effective_trigger()` accounts for `threshold_tokens_cap` even without `max_tokens`.
8. `compress(non-list)` returns the input unchanged (fail-open on junk).
9. No machine-local absolute paths or `sk-` strings in any tracked file (`git grep`).
