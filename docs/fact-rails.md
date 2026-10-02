# Fact rails (v0.5.0, refined in v0.6.0, v0.7.0, v0.7.2 and v0.8.0)

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

## Learned token value (v0.8.0)

A fact stub's lines are now chosen by how likely the agent is to use their tokens after the compaction
(`value_select.py`). A logistic regression on 13 token features (digits, path, extension, hex, length, repeats, in the
call's arguments, in the last user message, results left to the end, position, result length, already reused by the
agent) was fitted on 191 076 tokens of 85 transcripts (35 sessions; 7.7% used later). By session fold AUC 0.79; on
held-out sets AUC 0.74 (Claude) and 0.80 (Hermes), calibration error ≤ 0.03.

Within the chars the regex fact lines would take, a stub keeps the regex lines up to a third, then every error piece,
then pieces by greedy weighted coverage (most not-yet-kept value per char). Covered value is monotone submodular, so
the greedy keeps at least (1 − 1/e) of the best value a budget allows; the lazy evaluation it uses is exact. No stub
grows. `JEV_COMPACTION_VALUE_SELECT=0` restores the regex lines of v0.7.x.

Each variant was judged on a fresh set of Hermes sessions that played no part in building it, by a rule written before
the run (tokens used: lower bound > 0; error lines and experimenter-chosen facts: lower bound ≥ −2 pts). The first
three failed and never shipped: one cut long JSON lines, one lost error lines (−13 … −17), one lost experimenter facts
(−2.2 … −5.2). The fourth, on 80 fresh sessions:

| rail tier | tokens used after compaction | error lines | experimenter facts |
|---|---|---|---|
| 0–1 | +12.3 … +12.6 pts (≥ +8.7) | +11.7 (+8.7 … +14.3) | −0.6 (−1.8 … +0.2) |
| 2 | +16.0 … +16.3 (≥ +13.5) | +23.3 (+19.4 … +26.7) | +1.0 (−0.4 … +2.1) |
| 3 | +14.2 … +14.8 (≥ +12.2) | +28.7 (+25.0 … +32.0) | +1.1 (−1.1 … +3.4) |

95% CIs clustered by session; tokens at compactions at 50% and 75% of a session (3741 and 3167 tokens, 71–75
sessions); error lines 13 339 in 77 sessions. Stubs came out 0.2–0.9% shorter. Caveats: the experimenter facts
(1021 in 35 sessions) were the same set for every variant.

Elsewhere the regex lines stay. The fork's Codex sheet ran the same check on 86 fresh Codex rollouts and failed it
(tokens used +1.4 [−0.3, +3.3] at 50k, experimenter facts −2.0 [−4.3, +0.6]): a sheet gives each call at most 1200
chars of fact lines, too little room past the regex third and the error lines. The Claude Code hook waits for fresh
transcripts of its own.

## One fact budget per compaction (v0.9.0)

Until v0.8 each stub spent its own fact budget. Now the chars the stubs of one compaction spend on value-chosen lines
form one budget, filled by one lazy greedy over the pieces of all of them (`value_select.pool_lines`, `JevEngine._pool`):
a value-dense line of one result can take chars a weak line of another would have used. Heads, tails, the regex third
and error pieces stay in place, and every token any stub already keeps counts as covered, so nothing is bought twice.
The total stub size does not grow. `JEV_COMPACTION_POOL=0` restores per-stub budgets.

Two preregistered rounds on fresh Hermes sessions. The first (80 sessions) passed on tokens used but its guard on the
35-session experimenter-fact benchmark could not pass at tier 3 for any selector (its interval is about ±3 pts); the
second round kept that benchmark as a report and guarded with the experimenter-style facts of the fresh set itself:

| rail tier | tokens used after compaction (vs v0.8) | error lines | fresh-set facts |
|---|---|---|---|
| 0–1 | +2.0 (+1.2 … +3.0) | +0.1 (+0.0 … +0.4) | +1.8 (+0.8 … +2.9) |
| 2 | +5.5 (+4.3 … +6.7) | +0.3 (+0.1 … +0.5) | +3.2 (+1.9 … +4.6) |
| 3 | +11.3 (+9.4 … +13.3) | +0.7 (+0.4 … +1.1) | +3.2 (+2.3 … +4.2) |

80 fresh sessions (78 with compactions); 95% CIs clustered by session; stub size 0.998–1.000 of v0.8. The first round
on another 80 sessions gave +2.8 / +5.0 / +9.8 at tiers 0–1 / 2 / 3. Cost: one more greedy pass per compaction, up to
+4.6 s on the largest sessions tried (1.6–6.1M chars).

## Tokens visible inside longer ones (v0.10.0)

The pooled greedy now counts a token as covered wherever a reader can see it as a word: inside a longer token with no
letter or digit touching it (a short hash inside a path, an id inside a URL, a date inside a timestamp), in a piece or
anywhere in the stub text outside the greedy lines (`value_select.contained`). Before, it bought such a token again in
another piece. `JEV_COMPACTION_CONTAIN=0` restores the v0.9 coverage.

Preregistered on the last 50 fresh Hermes sessions, against v0.9, tokens counted as kept only where they stand as a
word:

| rail tier | tokens used after compaction | fresh-set facts | error lines |
|---|---|---|---|
| 0–1 | +0.75 (+0.48 … +1.04) | +1.16 (+0.83 … +1.47) | 0.00 |
| 2 | +1.23 (+0.70 … +1.77) | +2.15 (+1.71 … +2.53) | 0.00 (−0.08 … +0.08) |
| 3 | +1.72 (+1.32 … +2.17) | +2.39 (+1.96 … +2.77) | −0.07 (−0.19 … +0.03) |

Stub size 0.9995–1.0000 of v0.9; compaction time −0.16 … +0.09 s on the five largest sessions (1.4–6.1M chars). The
same check on four earlier, already used sets gave +0.4 … +2.4. A token kept only inside a longer one is now shown
once; the result's own stub keeps 1.6–2.9 pts fewer of its own tokens, because they are readable elsewhere.
