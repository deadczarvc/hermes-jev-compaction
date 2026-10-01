"""Fact lines by learned token value (v0.8.0): what the agent is likely to use after the compaction stays in the stub.

A token's value is P(the agent uses it after the compaction), from a logistic regression on 13 token features fitted by
IRLS on 85 Claude Code / Codex transcripts (191 076 tokens, 35 sessions; AUC 0.79 by session fold, ECE ≤ 0.03 on
held-out Claude and Hermes sets). Within the chars the regex fact lines would use, a stub keeps:
regex fact lines up to a third, then error pieces, then pieces by lazy greedy weighted coverage (marginal value per char;
coverage is monotone submodular, so the greedy is sound and lazy evaluation is exact).
Held-out check on 80 fresh Hermes sessions: tokens used +12…+16 pts, error lines +12…+29, experimenter facts −0.6…+1.1.
"""

from __future__ import annotations

import heapq
import math
import re
from collections.abc import Callable
from typing import Any

# Standardised logistic model; "seen_before" is left out: constant in training (candidates exclude seen tokens), β = 0.
FEATS = (
    "digit",
    "path",
    "ext",
    "hex",
    "loglen",
    "digshare",
    "logcount",
    "in_input",
    "in_user",
    "logdist",
    "linepos",
    "logoutlen",
    "reused",
)
MU = (
    0.400888,
    0.240747,
    0.240281,
    0.016752,
    2.832681,
    0.13081,
    0.871874,
    0.004401,
    0.007997,
    3.024303,
    0.478259,
    9.281838,
    0.050729,
)
SD = (
    0.490078,
    0.427537,
    0.427254,
    0.128343,
    0.642327,
    0.239112,
    0.385938,
    0.066197,
    0.089067,
    0.954716,
    0.292466,
    1.062772,
    0.219443,
)
INTERCEPT = -2.884622
BETA = (
    -0.227483,
    0.122111,
    -0.003107,
    0.097325,
    -0.170036,
    -0.058623,
    0.360508,
    0.183316,
    0.152196,
    -0.008517,
    -0.118614,
    -0.332467,
    0.520239,
)

_DIG = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/@#-]{5,}")
_WRD = re.compile(r"[A-Za-z_][A-Za-z0-9_./-]{7,}")
_HEX = re.compile(r"^[0-9a-f]{8,}$", re.IGNORECASE)
_EXT = re.compile(r"\.[A-Za-z]{1,5}$")
ERROR_PIECE = re.compile(
    r"error|failed|exception|traceback|denied|not found|timed out", re.IGNORECASE
)


def toks(s: str) -> set[str]:
    """Candidate fact tokens: digit-bearing runs, and digit-free words of ≥ 8 chars with a / _ or ."""
    out = {t.rstrip(".:,") for t in _DIG.findall(s) if any(c.isdigit() for c in t)}
    out |= {
        t.rstrip(".:,")
        for t in _WRD.findall(s)
        if any(c in "/_." for c in t)
        and not any(c.isdigit() for c in t)
        and len(t.rstrip(".:,")) >= 8
    }
    return out


def token_values(text: str, ctx: dict[str, Any]) -> dict[str, float]:
    values = {}
    for t in toks(text):
        x = (
            float(any(c.isdigit() for c in t)),
            float("/" in t or "\\" in t),
            float(bool(_EXT.search(t))),
            float(bool(_HEX.match(t))),
            math.log(len(t)),
            sum(c.isdigit() for c in t) / len(t),
            math.log1p(text.count(t)),
            float(t in ctx["input"]),
            float(t in ctx["user"]),
            math.log1p(ctx["dist"]),
            text.find(t) / max(1, len(text)),
            math.log(max(1, len(text))),
            float(t in ctx["reused"]),
        )
        z = INTERCEPT + sum(b * (v - m) / s for v, m, s, b in zip(x, MU, SD, BETA))
        values[t] = 1.0 / (1.0 + math.exp(-z))
    return values


def message_contexts(
    messages: list[dict[str, Any]], content_text: Callable[[Any], str]
) -> dict[str, dict[str, Any]]:
    """Per tool result (by tool_call_id): the arguments of the last call before it, the last user text, how many
    results are left from it to the end, and the tokens the agent reused (named in a call or a reply after a result
    introduced them). "Last call before it", not its own call, is what the model was fitted and checked on: with
    parallel calls every result of the batch sees the batch's last arguments."""
    events: list[tuple[str, str, str | None]] = []
    for m in messages:
        role = m.get("role")
        if role == "user":
            events.append(("user", content_text(m.get("content")), None))
        elif role == "assistant":
            events.append(("asst", content_text(m.get("content")), None))
            for tc in m.get("tool_calls") or []:
                args = (tc.get("function") or {}).get(
                    "arguments", tc.get("arguments", "")
                )
                events.append(
                    ("in", args if isinstance(args, str) else str(args), tc.get("id"))
                )
        elif role == "tool":
            events.append(
                ("out", content_text(m.get("content")), m.get("tool_call_id"))
            )
    user = next((t for k, t, _ in reversed(events) if k == "user"), "")
    intro: dict[str, int] = {}
    reused: set[str] = set()
    for i, (k, t, _) in enumerate(events):
        if k in ("in", "asst"):
            reused |= {x for x in toks(t) if intro.get(x, len(events)) < i}
        elif k == "out":
            for x in toks(t):
                intro.setdefault(x, i)
    outs: list[tuple[str | None, str]] = []
    last_in = ""
    for k, t, tc_id in events:
        if k == "in":
            last_in = t
        elif k == "out":
            outs.append((tc_id, last_in))
    return {
        tc_id: {
            "input": last_in,
            "user": user,
            "dist": len(outs) - n,
            "reused": reused,
        }
        for n, (tc_id, last_in) in enumerate(outs)
        if tc_id
    }


def value_lines(
    text: str,
    budget: int,
    values: dict[str, float],
    fact_lines: Callable[[str, int], list[str]],
    pieces: Callable[[str], list[str]],
) -> list[str]:
    """Within the chars the regex fact lines use: regex lines up to a third, error pieces, then lazy greedy coverage."""
    cap = sum(len(x) + 1 for x in fact_lines(text, budget))
    units = [p for raw in text.splitlines() for p in pieces(raw)]
    index = {u: i for i, u in enumerate(units)}
    taken: set[int] = set()
    covered: set[str] = set()
    used = 0

    def take(i: int) -> None:
        nonlocal used
        taken.add(i)
        used += len(units[i]) + 1
        covered.update(toks(units[i]))

    for line in fact_lines(text, cap // 3):
        i = index.get(line)
        if i is not None and i not in taken and used + len(line) + 1 <= cap:
            take(i)
    for i, u in enumerate(units):
        if i not in taken and ERROR_PIECE.search(u) and used + len(u) + 1 <= cap:
            take(i)
    unit_toks = [toks(u) for u in units]
    heap = [
        (-sum(values.get(t, 0.0) for t in ut) / (len(units[i]) + 1), i)
        for i, ut in enumerate(unit_toks)
        if ut and i not in taken
    ]
    heapq.heapify(heap)
    while heap:
        _, i = heapq.heappop(heap)
        gain = sum(values.get(t, 0.0) for t in unit_toks[i] - covered) / (
            len(units[i]) + 1
        )
        if gain <= 0:
            continue
        if heap and gain < -heap[0][0] - 1e-12:
            heapq.heappush(
                heap, (-gain, i)
            )  # lazy: a stale bound goes back with its true gain
            continue
        if used + len(units[i]) + 1 <= cap:
            take(i)
    return [units[i] for i in sorted(taken)]
