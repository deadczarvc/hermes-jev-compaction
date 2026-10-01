# Fact rails (v0.5.0, refined in v0.6.0, v0.7.0 and v0.7.2)

Before v0.5.0 a call Jev scored as stale was stubbed: its arguments emptied, its result replaced by
`dropped by jev-compaction`, or cut to a head. On real transcripts that lost most non-reproducible facts:
HTTP codes, errors, pids, ids, counters. A re-run of the tool does not bring them back.

v0.5.0 ports the rules of the fact-keeping Claude Code fork
([deadczarvc-labs/jev-factkeep-compaction](https://github.com/deadczarvc-labs/jev-factkeep-compaction)). Both engines
run the same rules and kept the same facts in every measurement.

## Rules

- **Nothing is erased.** A dropped call keeps its row and its `tool_call_id`. Its argument fields are cut to
  200 chars.
- **Reproducible read** (`read_file`, `search_files`, `ls`, `cat`, `rg`, `git log`…): shrinks to a one-line
  note. It must be longer than 3000 chars and carry no failure, timeout or background-job marker. Logs, JSONL
  ledgers, `journalctl`, `docker logs`, `-Tail` / `-Wait` and `tail -f` never count as reproducible. Since v0.6.0 a
  read that reports file metadata (`wc`, `stat`, `du`, `df`, `ls -l`, `Get-ChildItem`), alone or inside a compound
  command, is an observation too: counts, sizes and times are measurements taken at one moment.
- **Observation** (anything else) keeps:
  - its head, cut on a line boundary;
  - its fact lines, up to 30% of its size: errors, HTTP codes, paths, versions, ids, endpoints, counts,
    receipts of non-idempotent calls. Since v0.6.0 a line longer than 200 chars (a JSON string with escaped
    newlines, a minified record) is split into pieces instead of being cut at 200 chars;
  - its tail;
  - a note that the full output stays in the session history (`state.db`) under its `tool_call_id`.
- **Never cut:**
  - observations of 6000 chars or less;
  - dense dumps up to 32k chars (20k before v0.6.0), where fact lines are at least half the text;
  - the first 2000 chars of an error.
- **Rail tiers** (`RAIL_TIERS`): tier 1 is tier 0 without keeping reads; tiers 2–3 cut observations further.
- **How much to free** (v0.7.0): enough to bring the prompt back to 5/6 of the trigger (`_min_reduction`); the part
  of the prompt outside the messages (system prompt, tools) is subtracted, since it does not shrink. Without figures,
  `RAIL_FLOOR = 0.2`.
- **Result by result** (v0.7.0): the step to a stricter tier that frees the most chars per fact-like token lost
  (numbers, hex ids, paths) goes first, until the reduction is reached. A result an earlier compaction reduced is
  final. `_rail_tier` reports the strictest tier used.
- **Oldest first, only under real pressure** (v0.7.0): when even the strictest tier leaves the prompt above
  1.25× the trigger (at most 90% of the window's budget), the oldest dropped results keep only their fact lines,
  then become one-line notes. Below that line Hermes simply compacts again on the next turn: there is no summary
  cliff, and evicting for the target lost facts in the session model.
- **Saved outputs** (v0.7.0, hardened in v0.7.1): the full output of every reduced result is written to
  `<hermes home>/cache/jev-compaction/<session>/<tool_call_id>.txt`, and the note says where
  (`the full output is saved at <path>; read it for anything not kept here`). A failed write leaves the note
  pointing to `state.db`. `JEV_COMPACTION_SAVE_OUTPUTS=0` turns it off. Since v0.7.1:
  - the copy passes through Hermes' shared redactor (the one egress uses) first; without the redactor nothing is
    written (fail closed);
  - the folder is under `cache/`, which the station's backups and indexers skip (`state.db` is not backed up
    either);
  - saved outputs older than 30 days are deleted, once a day;
  - ids keep only `[\w.-]`, so no id writes outside the session folder.
  Measured on 5995 tool outputs of the evaluation transcripts: 0 values of a known secret family; masking removed
  none of the 392 preregistered facts. The threat model is in the Claude fork's
  [docs/security.md](https://github.com/deadczarvc-labs/jev-factkeep-compaction/blob/main/docs/security.md).
- **Jev unreachable** (transport error, malformed answer, redactor failure): `mode = "fallback"`. Every old
  unpinned call is reduced by the same rules as a `drop_result`, with no HTTP and no summary. Before v0.5.0
  the engine returned the history unchanged (`mode = "preserve"`).
- Egress is unchanged: fact stubs are computed locally, and in `metadata` mode no result text leaves the
  process.

## Evidence

The method is the same as in the Claude fork's
[docs/evidence.md](https://github.com/deadczarvc-labs/jev-factkeep-compaction/blob/main/docs/evidence.md):

- real Claude Code subagent transcripts, replayed through the Hermes engine;
- facts preregistered with sha256 before any run;
- real Jev (`jev-1.13.0`), `egress_mode = metadata`.

| round | facts | v0.4.x | fact rails | token reduction v0.4.x → fact rails |
|---|---|---|---|---|
| held-out round 5 (4 new transcripts, v0.6.0, blind) | 50 | 4/50 | **50/50** | 0.876 → 0.445 |
| held-out round 4 (5 new transcripts, v0.5.0, blind) | 75 | 13/75 | 70/75 | 0.920 → 0.583 |
| rounds 0–4 with v0.6.0 (21 transcripts, in-sample) | 286 | 53/286 | 286/286 | → 0.519 |

- Round 5 (v0.6.0): the preregistered bar was 47/50 with a reduction ≥ 0.20 on every transcript.
  - Kept: 50/50, 95% CI 0.929–1.000.
  - Reduction: minimum 0.253.
  - Exact McNemar b = 46, c = 0, p = 2.8e-14.
  - Jev dropped every unpinned call, so the round measures the keeping rules.
- Round 4 (v0.5.0): 70/75, b = 57, c = 0, p = 1.4e-17. It missed the 94% bar by one fact. The five losses are the class that v0.6.0 fixes:
  - metadata inside compound reads;
  - facts deep in very long lines;
  - a 29k dense table.
- No fact kept by v0.4.x was lost in any round.

## Repeated compactions (v0.7.0)

Session model (the Claude fork's `docs/data/sim_v2.mts`, ported as a Python harness): messages arrive one by one,
the engine compacts at 60% of the window with Jev's recorded decisions, and the window is the transcript's size
divided by the session's length in windows. Facts kept in the context:

| session length | v0.6.0, blind 56 | v0.7.0, blind 56 | v0.6.0, in-sample 336 | v0.7.0, in-sample 336 |
|---|---|---|---|---|
| 0.8 window | 56 | 56 | 334 | 335 |
| 1 window | 54 | 55 | 320 | 327 |
| 1.2 windows | 54 | 52 | 307 | 307 |
| 1.5 windows | 50 | 51 | 281 | 292 |

- Counting the saved outputs too, v0.7.0 keeps 56/56 and 336/336 at every length.
- At 1.5 windows v0.6.0 let the prompt grow to 79% of the window; v0.7.0 stays at or under 65%.
- The blind facts are those of the fork's round 6; the eviction line (1.25× the trigger) was chosen on the same
  simulation, so this table is not a fresh blind round.

## Past use first (v0.7.2)

A fact stub's lines now start with the lines that hold a token the agent already used: a token with a digit that a tool
result introduced and a later tool call's arguments repeated (`reused_tokens`, `reuse_first_lines`). The regex fact
lines fill the rest of the same budget, so no stub grows.

Scored on what agents act on — tokens with a digit first introduced by an output and used by the agent after a
compaction at 50% or 75% of the session (85 transcripts, 35 sessions; the fork's `goal/g08` label):

| rail tier | change | 95% CI (clustered by session) |
|---|---|---|
| 0–1 | +1.7 … +1.8 pts | above 0 |
| 2 | +6.8 … +7.6 | above 0 |
| 3 | +7.9 … +9.1 | above 0 |

On tokens without digits (paths, identifiers) it changes −0.7 … +0.6 pts, and on both kinds together +0.5 … +2.0 with
every lower bound above −0.5. Pinning a quota of digit-token lines does about as well, so the fair reading is that the
regex fact lines underweight lines with ids, versions and numbers. A compressibility selector tried on the way kept more
experimenter-chosen facts but fewer of these tokens (−1.6 … −6.7) and was reverted before release. The data are
in-sample; the rules were written before each run.

## Price

About 42–56% of the tokens remain after compaction, against 8–12% before. The floor keeps every compaction
at a reduction of 0.2 or more.

### Withdrawn after a held-out check

On 80 Hermes sessions that played no part in finding the rule, it changed the stubs by −0.1 … +0.3 pts (every lower
bound ≥ −0.4; tier 2 −0.0 / −0.1): few tool calls there repeat a token from an earlier result, so the rule rarely acts.
The rule written before that check required a gain; the engine is back on the regex fact lines.
