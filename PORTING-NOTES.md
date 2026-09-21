# Porting note: fast-jev-compaction on Hermes Agent

I ported this library to [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(Nous Research) — an open-source personal agent with a Python core, OpenAI-chat
message storage, and a similar lossy-summarization problem in its context
compression. Fork: https://github.com/deadczarvc/hermes-jev-compaction (see
`HERMES.md` there).

## What the port adds

- `src/hermes.ts` — a bidirectional adapter between the OpenAI-chat message
  format (what Hermes persists: `role/content/tool_calls` + `role:"tool"`
  messages) and this library's `Message[]`. Handles nested and flat tool-call
  spellings, content-part arrays, and grouped tool results. 9 adapter vitest tests (plus a 69-test Python engine suite),
  upstream suite untouched (41/41 vitest green (plus a 69/69 Python engine suite) in the fork).
- `bin/hermes-compact.mjs` — a CLI that reads a transcript (JSON array,
  `{"messages":[...]}`, or JSONL), runs `compact`, writes the compacted
  transcript plus stats. Runs against the real TypeSafe API; a `--dry-run`
  mode does the mapping report without any API call.
- Pinning: `--model jev-1.13.0` works against the live API (verified; the
  shorter `jev-1.13` is rejected with "Unknown model").

## Why it fits Hermes

Hermes currently has no compaction hook event (its shell hooks cover
`pre_tool_call`/`post_tool_call`/`pre_llm_call`/`on_session_start`), and its
compression lives in the agent core. So the supported integration today is
on-demand: the agent (or a session script) runs the CLI over a transcript when
context pressure grows. The verbatim-keep semantics matter a lot for agent
work — file paths, exact errors, and command outputs survive compaction, which
lossy summaries routinely destroy.

Two things I would have loved: (1) a documented stable alias policy for model
IDs (`jev-latest` resolving to a specific `1.13.0` is nice for upgrades but
makes reproducibility harder), and (2) a batch answer field mapping in the
docs for the `noul` type — the two-question-per-call pattern scales well
beyond 10 calls per request and is worth documenting as a recipe.

## Sharing

- Fork with the port: https://github.com/deadczarvc/hermes-jev-compaction
- Notes for Hermes users: `HERMES.md` in the fork

Happy to upstream anything useful — the adapter is MIT like the rest.
