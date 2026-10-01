"""hermes-jev-compaction — Jev context engine plugin for Hermes Agent.

Registers a ContextEngine that replaces lossy compaction summaries with Jev
decisions (TypeSafe System One API): every tool call is scored, stale calls
and results are dropped or truncated, everything kept stays verbatim.

Deploy: copy this directory to ~/.hermes/plugins/jev-context-engine/ and set
``context.engine: jev`` in config.yaml. Requires TYPESAFE_API_KEY in the
environment (the Hermes .env is loaded into os.environ at startup).
Config (optional, under ``context.jev``): model, keep_threshold,
max_state_tokens, max_request_tokens.

Note: editing ``compression.*`` keys in config.yaml while a session is live
may not propagate to the running engine; the values are picked up by the
NEXT session start (upstream #115572 was fixed; this note remains as a
caution for older Hermes versions).
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .egress import metadata_input, redact_export_value
from .settings import DEFAULT_MODEL as DEFAULT_MODEL
from .settings import FAILURE_BACKOFF_S as FAILURE_BACKOFF_S
from .settings import SYSTEM_ONE_URL as SYSTEM_ONE_URL
from .settings import EngineSettings

STATE_CONTEXT = (
    "A coding agent conversation is being compacted to free context. `history` is the whole "
    "conversation so far, oldest first; tool outputs are replaced by a short `result` note and "
    "long texts may be abridged. Each question asks whether one tool call, or the full output "
    "of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted "
    "permanently, but the assistant can always re-run a tool or re-read a file."
)
INPUT_CHARS = [1000, 200, 60]
TEXT_HEAD, TEXT_TAIL = 400, 150
REQUEST_OVERHEAD_TOKENS = 20
_ALLOWED_SCHEMES = ("https://", "http://")
_TOKEN_PIECES = re.compile(r"[A-Za-z]+|\d+|[^\sA-Za-z\d]")
_IDENTIFIER_RE = re.compile(
    r"([A-Za-z]:[\\/]|/(?:home|Users|var|tmp|etc)/)"
    r"|\b(?:error|exception|traceback|failed|exit code)\b"
    r"|\b[0-9a-f]{8,}\b",
    re.IGNORECASE,
)


def estimate_tokens(text: str) -> int:
    """Tokenizer-free estimate: 1 token per 6 letters, 0.5 per digit, 0.9 per symbol."""
    tokens = 0.0
    for m in _TOKEN_PIECES.finditer(text):
        piece = m.group(0)
        c = piece[0]
        if c.isdigit():
            tokens += len(piece) / 2
        elif c.isascii() and c.isalpha():
            tokens += 1 + (len(piece) - 1) // 6
        else:
            tokens += 0.9
    return int(tokens) + 1


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _parse_input(raw: Any) -> Any:
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, (dict, list)):
                return parsed
        except (ValueError, TypeError):
            pass
        return {"raw": raw}
    return {}


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: max(0, limit - 1)] + "…"


def _abridge(text: str, head: int, tail: int) -> str:
    if len(text) <= head + tail + 40:
        return text
    return (
        f"{text[:head]}\n[… {len(text) - head - tail} chars omitted …]\n{text[-tail:]}"
    )


# Port of the fact-keeping fork of fast-jev-compaction (deadczarvc-labs/jev-factkeep-compaction, src/compact.ts).
# The goal both engines state: drop what re-running the tool would give back, never an exact error, path or
# observation. Measured on one transcript (docs/fact-rails.md) the
# drop-everything rule kept 2/6 non-reproducible facts here and 0/6 in Claude; the fork kept 6/6 there.
_FACT_PATTERNS = [
    re.compile(p, re.IGNORECASE if i in (0, 2, 7, 8, 10, 11) else 0)
    for i, p in enumerate(
        [
            r"\b(error|errors|failed|failure|fail|exception|traceback|denied|refused|invalid|not found|timed? ?out|fatal|panic|warning)\b|invalid_\w+",
            r"✖|✗|\bFAIL\b|\bERR\b",
            r"\bHTTP\b[\s/\d.]*\d{3}\b|\bstatus[\s:=]+\d{3}\b",
            r"[A-Za-z]:[\\/][^\s\"'<>]+|(?:^|[\s\"'(=])/(?:[\w.@-]+/)+[\w.@-]+",
            r"\b\d+\.\d+\.\d+\b",
            r"\b[0-9a-f]{7,40}\b",
            r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\blocalhost:\d+\b",
            r"\b(pid|port|exit|rc|code|size|bytes|pass(?:ed)?|fail(?:ed)?|tests?|total|count)\b[\s:=]*\d",
            r"\b\d[\d,.]*\s?(ms|kb|mb|gb|bytes|%|tokens|lines?|files?)\b",
            r"\b\d{4,}\b",
            r"\b[\w.-]+\.(?:[cm]?[jt]sx?|py|json|ya?ml|md|toml|txt|log|rs|go|sh|ps1|cmd|lock|sql)\b",
            # receipts of non-idempotent calls (the old fallback's rule): a re-run would send or create again
            r"\b(?:message_id|ticket|confirm(?:ed)?|sent|delivered|created|updated|deleted|order|transaction|commit)\b[\s:=#]+[\w\-]+",
        ]
    )
]
FACT_HEAD_CHARS, FACT_TAIL_CHARS, FACT_BUDGET_CHARS, FACT_LINE_CHARS = (
    200,
    120,
    360,
    200,
)
ERROR_KEEP_CHARS, INPUT_BRIEF_CHARS, RERUN_INPUT_CHARS = 2000, 200, 160
_READ_TOOLS = {
    "read_file",
    "search_files",
    "list_files",
    "list_directory",
    "grep",
    "glob",
    "Read",
    "Grep",
    "Glob",
    "LS",
}
_SHELL_TOOLS = {"terminal", "shell", "bash", "Bash", "PowerShell"}
_READ_VERBS = {
    "cd",
    "echo",
    "printf",
    "true",
    "ls",
    "dir",
    "cat",
    "type",
    "head",
    "tail",
    "wc",
    "find",
    "fd",
    "rg",
    "grep",
    "egrep",
    "sha256sum",
    "sha1sum",
    "md5sum",
    "stat",
    "file",
    "tree",
    "cut",
    "tr",
    "sort",
    "uniq",
    "sed",
    "awk",
    "jq",
    "basename",
    "dirname",
    "realpath",
    "es",
    "es.exe",
    "get-content",
    "get-childitem",
    "select-string",
    "select-object",
    "measure-object",
    "get-filehash",
    "test-path",
    "resolve-path",
    "format-table",
    "out-string",
}
_GIT_READS = re.compile(
    r"^git\s+(log|show|diff|status|blame|ls-files|rev-parse|branch|remote|describe)\b"
)
_REDIRECT_NOISE = re.compile(r"2>&1|2>/dev/null|2>\$null|>\s*/dev/null|>\s*\$null")
_WRITES = re.compile(r"(^|[^>2&])>{1,2}(?!&)|\btee\b|\|\s*(sh|bash|pwsh|iex)\b")


# A log, a JSONL ledger or a followed stream changes under you: re-reading it later does not give this output
# back (held-out round 1: a `tail -c` of a log was shrunk to a re-run line and lost two ids). Same as the fork.
_MUTABLE_SOURCE = re.compile(
    r"\.(?:log|jsonl|out|err)\b|[\\/]logs?[\\/]|\bjournalctl\b|\b(?:docker|kubectl)\s+logs\b|-Tail\b|-Wait\b"
    r"|\btail\s+-[a-zA-Z]*[fF]",
    re.IGNORECASE,
)


# File metadata is a measurement taken at one moment: line counts, sizes and modification times change with every
# edit, and the agent quotes them as evidence. A read that reports metadata (wc, stat, du, df, a long listing) is an
# observation, alone or inside a compound command (held-out round 4: `wc -l f && sed -n 1,140p f` and
# `cat card; ls -la dir` were shrunk to re-run lines). Same as the fork.
_METADATA_VERBS = {
    "wc",
    "stat",
    "du",
    "df",
    "dir",
    "get-childitem",
    "gci",
    "measure-object",
}
_LONG_LISTING = re.compile(r"^ls\s+(?:\S+\s+)*-[a-zA-Z]*l")


def reproducible(tool: str, args: Any) -> bool:
    """True when re-running the call gives its output back: a read of files, not of the world."""
    if _MUTABLE_SOURCE.search(
        json.dumps(args if args is not None else {}, ensure_ascii=False, default=str)
    ):
        return False
    if tool in _READ_TOOLS:
        return True
    if tool not in _SHELL_TOOLS or not isinstance(args, dict):
        return False
    command = str(args.get("command") or "")
    if not command or _WRITES.search(_REDIRECT_NOISE.sub("", command)):
        return False
    for segment in re.split(r"\r?\n|;|&&|\|\||\|", command):
        words = re.sub(r"^(?:\w+=\S*\s+)+", "", segment.strip())
        words = re.sub(r"^timeout\s+\S+\s+", "", words)
        words = re.sub(r"^command\s+", "", words)
        if not words or _GIT_READS.match(words):
            continue
        if re.match(r"^sed\s+(-\w*i|--in-place)", words):
            return False
        verb = words.split()[0].strip("\"'").lower()
        if verb in _METADATA_VERBS or _LONG_LISTING.match(words):
            return False  # metadata is an observation
        if verb not in _READ_VERBS:
            return False
    return True


def _pieces(line: str) -> list[str]:
    """A line longer than FACT_LINE_CHARS (JSON with escaped newlines, a minified record, a wide row) is split into
    pieces rather than truncated, so a fact deep in a long line is still a candidate. Same as the fork."""
    out = []
    for rest in line.split("\\n"):
        rest = rest.strip()
        while len(rest) > FACT_LINE_CHARS:
            window = rest[:FACT_LINE_CHARS]
            cut = max(
                window.rfind(", "),
                window.rfind("; "),
                window.rfind(" | "),
                window.rfind(" "),
            )
            end = cut + 1 if cut > FACT_LINE_CHARS / 2 else FACT_LINE_CHARS
            out.append(rest[:end].strip())
            rest = rest[end:].strip()
        if rest:
            out.append(rest)
    return out


def fact_lines(text: str, budget: int) -> list[str]:
    """Lines of text carrying facts, most fact-dense first until budget chars, returned in text order."""
    scored = []
    for index, line in enumerate(p for raw in text.splitlines() for p in _pieces(raw)):
        score = sum(1 for p in _FACT_PATTERNS if line and p.search(line))
        if score:
            scored.append((-score, index, line))
    picked, seen, used = [], set(), 0
    for _, index, line in sorted(scored):
        if line in seen or used + len(line) + 1 > budget:
            continue
        seen.add(line)
        picked.append((index, line))
        used += len(line) + 1
    return [line for _, line in sorted(picked)]


# Hard rails for an observation, same as the fact-keeping fork (src/compact.ts, held-out round 0):
# a short result is never cut; head and tail end on line boundaries; the fact-line budget grows with the result;
# the note says where the full output still is (Hermes keeps every original tool message in state.db).
# Also: a dense dump (fact lines ≥ dense_share of it) up to dense_keep stays whole; a read becomes a re-run line only
# when longer than read_keep and free of failure / timeout / background markers. Tiers: the strictest tier whose
# reduction clears RAIL_FLOOR is used (same RAIL_TIERS as the fork). Swept on held-out rounds 0-2: 157/157 facts.
RAIL_TIERS = (
    {
        "small": 6000,
        "share": 0.3,
        "read_keep": 3000,
        "dense_keep": 32000,
        "dense_share": 0.5,
    },
    # v0.7.0 (fork astra.10): reads give way first (tier 1 = tier 0 without keeping reads), then observations
    {
        "small": 6000,
        "share": 0.3,
        "read_keep": 0,
        "dense_keep": 32000,
        "dense_share": 0.5,
    },
    {
        "small": 3000,
        "share": 0.2,
        "read_keep": 0,
        "dense_keep": 0,
        "dense_share": 1.0,
    },
    {"small": 0, "share": 0.1, "read_keep": 0, "dense_keep": 0, "dense_share": 1.0},
)
RAIL_FLOOR = 0.2  # default when the context's fill is unknown; otherwise _min_reduction() decides (no summary cliff in Hermes)
LAST_RESORT_TIER = len(RAIL_TIERS)  # reported when the oldest results had to give way
_COMPACTED_MARK = re.compile(r"\[jev-compaction (?:omitted|truncated) ")
# Fact-like tokens a result loses by going to a stricter tier: paths, hex ids, numbers (the greedy's risk).
_FACT_TOKEN = re.compile(
    r"[A-Za-z]:[\\/][^\s\"'<>]+|/(?:[\w.@-]+/)+[\w.@-]+|\b[0-9a-f]{7,40}\b|\b\d[\d.,:]*\d\b",
    re.IGNORECASE,
)


def full_output_note(tool_call_id: str) -> str:
    """The phrase a reduced result's note carries; the engine swaps it for a saved file's path (_offload)."""
    return f"the full output stays in this session's history (state.db) under {tool_call_id}"


_READ_OBSERVATION = re.compile(
    r"\b(?:errno|os error|timed? ?out|timeout|permission denied|access is denied|no such file|cannot find|not found"
    r"|running in background|background with id|exit code [1-9]|killed)\b",
    re.IGNORECASE,
)


def fact_stub(
    text: str,
    is_error: bool,
    tool_call_id: str | None = None,
    rails: dict | None = None,
) -> str:
    """A reduced result that keeps its head, its fact lines and its tail; an error keeps more."""
    rails = rails or RAIL_TIERS[0]
    head_keep = max(FACT_HEAD_CHARS, ERROR_KEEP_CHARS) if is_error else FACT_HEAD_CHARS
    if len(text) <= max(rails["small"], head_keep + FACT_TAIL_CHARS + 120):
        return text
    if (
        len(text) <= rails["dense_keep"]
        and sum(len(ln) + 1 for ln in fact_lines(text, 10**12))
        >= len(text) * rails["dense_share"]
    ):
        return text
    head_nl = text.rfind("\n", 0, head_keep + 1)
    head_end = head_nl if head_nl > head_keep / 2 else head_keep
    tail_nl = text.find("\n", len(text) - FACT_TAIL_CHARS)
    tail_start = (
        len(text) - FACT_TAIL_CHARS if tail_nl in (-1, len(text) - 1) else tail_nl + 1
    )
    facts = fact_lines(
        text[head_end:tail_start],
        max(FACT_BUDGET_CHARS, int(len(text) * rails["share"])),
    )
    where = (
        full_output_note(tool_call_id)
        if tool_call_id
        else "the full output stays in this session's history (state.db)"
    )
    note = (
        f"\n[jev-compaction omitted {tail_start - head_end} chars of this tool result{' (error)' if is_error else ''}"
        f"{f'; kept its {len(facts)} fact line(s)' if facts else ''}; {where}]\n"
    )
    return (
        text[:head_end]
        + note
        + ("\n".join(facts) + "\n…\n" if facts else "")
        + text[tail_start:]
    )


def rerun_note(text: str, tool_call_id: str | None = None) -> str:
    # The note also names where the full output is: a file can change after the read, and the engine saves it.
    where = f"; {full_output_note(tool_call_id)}" if tool_call_id else ""
    return (
        text
        if len(text) <= 160
        else (
            f"[jev-compaction omitted {len(text)} chars: a reproducible read, re-run the tool to see it{where}]"
        )
    )


def reduced_text(
    text: str, is_error: bool, tool_call_id: str, rails: dict, rerunnable: bool
) -> str:
    """One result under one rail tier. Idempotent: a result an earlier compaction reduced is final."""
    if _COMPACTED_MARK.search(text):
        return text
    if (
        rerunnable
        and not is_error
        and len(text) > rails["read_keep"]
        and not _READ_OBSERVATION.search(text)
    ):
        return rerun_note(text, tool_call_id)
    return fact_stub(text, is_error, tool_call_id, rails)


def _chars(messages: list[dict[str, Any]]) -> int:
    """Chars as the fork counts them: content plus tool-call arguments once, as sent (json.dumps of the tool_calls
    list would count the JSON string escaped twice)."""
    return sum(
        len(_content_text(m.get("content")))
        + sum(
            len(str((tc.get("function") or {}).get("arguments") or ""))
            for tc in m.get("tool_calls") or []
        )
        for m in messages
    )


def _message_tokens(messages: list[dict[str, Any]]) -> int:
    return sum(
        estimate_tokens(_content_text(m.get("content")))
        + sum(
            estimate_tokens(str((tc.get("function") or {}).get("arguments") or ""))
            for tc in m.get("tool_calls") or []
        )
        for m in messages
    )


def brief_args(value: Any, limit: int) -> Any:
    if isinstance(value, str):
        return (
            value
            if len(value) <= limit
            else f"{value[:limit]}…[{len(value) - limit} chars]"
        )
    if isinstance(value, list):
        return [brief_args(v, limit) for v in value]
    if isinstance(value, dict):
        return {k: brief_args(v, limit) for k, v in value.items()}
    return value


def _http_post_json(
    url: str, body: bytes, headers: dict[str, str], timeout: float
) -> dict[str, Any]:
    """POST JSON to an http(s) URL only; anything else is refused before any I/O."""
    if not url.startswith(_ALLOWED_SCHEMES):
        raise ValueError(f"unsupported base_url scheme: {url.split(':', 1)[0]}")
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


class JevEngine(EngineSettings):
    """Verbatim-keep compaction: Jev decides, nothing is summarized."""

    # -- host contract ----------------------------------------------------
    @property
    def name(self) -> str:
        return "jev"

    def update_from_response(self, usage: dict[str, Any]) -> None:
        self.last_prompt_tokens = int(
            usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        )
        self.last_completion_tokens = int(
            usage.get("completion_tokens") or usage.get("output_tokens") or 0
        )
        total = usage.get("total_tokens")
        self.last_total_tokens = (
            int(total)
            if total
            else self.last_prompt_tokens + self.last_completion_tokens
        )

    # Static fallback reservation (completion + vision expansion) for when the model's
    # max_tokens is unknown. Our own overflow death: 798866 input + 393216 completion
    # > 1048576 window — a bare percent threshold would have fired too late.
    _RESERVED_FRACTION = 0.30

    def _effective_trigger(self) -> int:
        """Trigger line in prompt-tokens. With a known max_tokens reservation the budget is
        exact: threshold_percent * (context_length - max_tokens). Without it, fall back to
        threshold_tokens shrunk by the static fraction. Either way, an explicit
        threshold_tokens_cap clamps the result."""
        if self.max_tokens and self.context_length > self.max_tokens:
            budget = self.context_length - self.max_tokens
            result = int(budget * self.threshold_percent)
        else:
            result = int(self.threshold_tokens * (1.0 - self._RESERVED_FRACTION))
        if self.threshold_tokens_cap:
            result = min(result, self.threshold_tokens_cap)
        return result

    def should_compress(self, prompt_tokens: int | None = None) -> bool:
        if self._cooling():
            return False
        tokens = prompt_tokens or self.last_prompt_tokens
        if not self.threshold_tokens:
            return False
        return tokens >= self._effective_trigger()

    def _pre_compress(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Pre-conversion seam: validate and normalize messages before compression.
        This is the plugin-side boundary where raw messages enter the pipeline,
        before any content extraction or state fitting. Non-dict entries are
        wrapped to prevent downstream crashes. Equivalent of a core pre-conversion
        hook, but entirely within the official plugin API."""
        if not isinstance(messages, list):
            return messages
        return [
            m if isinstance(m, dict) else {"role": "user", "content": str(m)}
            for m in messages
        ]

    # -- compaction --------------------------------------------------------
    def compress(
        self,
        messages: list[dict[str, Any]],
        current_tokens: int | None = None,
        focus_topic: str | None = None,
        force: bool = False,
        memory_context: str = "",
        bypass_cooldown: bool = False,
    ) -> list[dict[str, Any]]:
        messages = self._pre_compress(messages)
        if not isinstance(messages, list):
            return messages
        self.compression_count += 1
        self._messages_ref = messages
        self._memory_context = (memory_context or "").strip()[:2000]
        self._events = getattr(self, "_events", [])[-100:]
        self._events.append({"phase": "attempt", "ts": time.monotonic()})
        stats: dict[str, Any] = {"calls": 0, "candidates": 0, "mode": "jev"}
        self.last_stats = stats
        if self.egress_mode == "off":
            stats["mode"] = "off"
            return messages
        if self.egress_mode not in ("metadata", "redacted_text", "full_text"):
            stats.update({"mode": "preserve", "error": "invalid egress mode"})
            return messages
        calls = self._collect_calls(messages)
        candidates = [c for c in calls if not c["pinned"]]
        stats.update({"calls": len(calls), "candidates": len(candidates)})
        if not candidates:
            return messages
        floor = self._min_reduction(messages, current_tokens)
        hard = self._hard_reduction(messages, current_tokens)
        stats["min_reduction"] = round(floor, 3)
        try:
            state, state_tokens = self._fit_state(messages, calls)
            answers = self._ask_all(state, state_tokens, candidates)
        except Exception:  # noqa: BLE001 — Jev down: deterministic fallback, never a lossy summary
            stats["mode"] = "fallback"
            stats["error"] = "egress or Jev failure"
            self._events.append({"phase": "fallback", "reason": "transport_error"})
            self._last_failure_monotonic = time.monotonic()
            return self._offload(
                messages, self._fallback_prune(messages, calls, floor, hard)
            )  # user decision 2026-09-30: wire it, not fail open
        by_id = {}
        for c, a in zip(candidates, answers, strict=False):
            d = self._decide(a)
            # Research guard: failure history survives. An error result may lose verbatim bulk
            # (drop_result) but its call + bounded head must stay — retrying failed approaches
            # is the most expensive post-compaction bug class.
            if d == "drop_call" and c.get("is_error"):
                d = "drop_result"
            by_id[c["id"]] = d
        out = self._offload(messages, self._apply(messages, calls, by_id, floor, hard))
        dropped_calls = [c for c in calls if by_id.get(c["id"]) == "drop_call"]
        self._dropped_receipts = getattr(self, "_dropped_receipts", [])[-100:]
        for c in dropped_calls:
            original = next(
                (
                    m
                    for m in messages
                    if m.get("role") == "tool"
                    and m.get("tool_call_id") == c["tool_call_id"]
                ),
                None,
            )
            text = _content_text(original.get("content")) if original else ""
            self._dropped_receipts.append(
                {
                    "tool_call_id": c["tool_call_id"],
                    "tool": c.get("tool", "unknown"),
                    "preview": text[:80],
                    "full": text,
                }
            )
        stats.update(
            {
                "kept": sum(1 for d in by_id.values() if d == "keep"),
                "results_truncated": sum(
                    1 for d in by_id.values() if d == "drop_result"
                ),
                "calls_dropped": sum(1 for d in by_id.values() if d == "drop_call"),
                "state_tokens": state_tokens,
            }
        )
        self._events.append(
            {
                "phase": "committed",
                "kept": stats.get("kept", 0),
                "dropped": stats.get("calls_dropped", 0),
            }
        )
        return out

    # -- internals ---------------------------------------------------------

    def _collect_calls(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Pair assistant tool_calls with role:"tool" result messages by tool_call_id."""
        results: dict[str, dict[str, Any]] = {}
        for idx, msg in enumerate(messages):
            if msg.get("role") == "tool" and msg.get("tool_call_id"):
                results[msg["tool_call_id"]] = {
                    "index": idx,
                    "text": _content_text(msg.get("content")),
                    "is_error": bool(msg.get("is_error")),
                }
        calls: list[dict[str, Any]] = []
        for idx, msg in enumerate(messages):
            for tc in msg.get("tool_calls") or []:
                call_id = tc.get("id") or ""
                found = results.get(call_id)
                if found is None:
                    continue
                func = tc.get("function") or {}
                calls.append(
                    {
                        "id": f"t{len(calls) + 1}",
                        "tool_call_id": call_id,
                        "tool": func.get("name") or tc.get("name") or "unknown_tool",
                        "input": _parse_input(
                            func.get("arguments", tc.get("arguments"))
                        ),
                        "call_index": idx,
                        "result_index": found["index"],
                        "result_chars": len(found["text"]),
                        "is_error": bool(found.get("is_error")),
                        "has_identifier": self._has_identifier(found["text"]),
                        "pinned": self._pinned(idx) or self._pinned(found["index"]),
                    }
                )
        return calls

    def _pinned(self, index: int) -> bool:
        return index == 0 or index >= len(self._messages_ref) - self.protect_last_n

    def _fit_state(
        self,
        messages: list[dict[str, Any]],
        calls: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], int]:
        """Whole conversation as Jev state; staged shrink until it fits max_state_tokens."""
        by_call_idx: dict[int, list[dict[str, Any]]] = {}
        for c in calls:
            by_call_idx.setdefault(c["call_index"], []).append(c)

        def entries(input_chars: int) -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for i, msg in enumerate(messages):
                tool_calls = [
                    {
                        "id": c["id"],
                        "tool": c["tool"],
                        "input": metadata_input(c["input"])
                        if self.egress_mode == "metadata"
                        else _truncate(
                            c["input"]
                            if isinstance(c["input"], str)
                            else json.dumps(c["input"], ensure_ascii=False),
                            input_chars,
                        ),
                        "result": f"ok, {c['result_chars']} chars (omitted)",
                    }
                    for c in by_call_idx.get(i, [])
                ]
                text = _content_text(msg.get("content"))
                if msg.get("role") == "tool":
                    text = f"[{len(text)} chars omitted]" if text else ""
                elif self.egress_mode == "metadata":
                    text = f"[{len(text)} chars]" if text else ""
                if not text.strip() and not tool_calls:
                    continue
                entry: dict[str, Any] = {"i": i, "role": msg.get("role"), "text": text}
                if tool_calls:
                    entry["tool_calls"] = tool_calls
                out.append(entry)
            return out

        def pack(history: list[dict[str, Any]]) -> tuple[dict[str, Any], int]:
            context = STATE_CONTEXT
            memory_ctx = getattr(self, "_memory_context", "")
            if memory_ctx and self.egress_mode in ("redacted_text", "full_text"):
                context += (
                    "\nMemory provider flags these items as long-term relevant — weigh them "
                    "toward keeping calls/results that relate:\n" + memory_ctx
                )
            state = {"context": context, "goal": self._goal(), "history": history}
            return state, estimate_tokens(json.dumps(state, ensure_ascii=False))

        history = entries(INPUT_CHARS[0])
        for limit in INPUT_CHARS:
            history = entries(limit)
            state, tokens = pack(history)
            if tokens <= self.max_state_tokens:
                return state, tokens
        protected_min = max(0, len(messages) - self.protect_last_n)

        def old(e: dict[str, Any]) -> bool:
            return not (e["i"] == 0 or e["i"] >= protected_min)

        order = [e for e in history if old(e)] + [e for e in history if not old(e)]
        for e in order:
            if len(e["text"]) > TEXT_HEAD + TEXT_TAIL + 40:
                e["text"] = _abridge(e["text"], TEXT_HEAD, TEXT_TAIL)
            state, tokens = pack(history)
            if tokens <= self.max_state_tokens:
                return state, tokens
        for e in order:
            if e.get("tool_calls") and isinstance(e["tool_calls"][0], dict):
                e["tool_calls"] = [
                    f"{tc['id']} {tc['tool']} {_truncate(str(tc['input']), INPUT_CHARS[2])} → ok"
                    for tc in e["tool_calls"]
                ]
                state, tokens = pack(history)
                if tokens <= self.max_state_tokens:
                    return state, tokens
        kept = [e for e in history if not old(e) or e.get("tool_calls")]
        state, tokens = pack(kept)
        if tokens > self.max_state_tokens:
            raise ValueError(
                f"history too large for Jev (~{tokens} tokens, limit {self.max_state_tokens})"
            )
        return state, tokens

    def _goal(self) -> str:
        if self.egress_mode == "metadata":
            return ""  # metadata mode: no user text leaves the process
        prompts = [
            _content_text(m.get("content"))
            for m in self._messages_ref
            if m.get("role") == "user"
        ]
        prompts = [p for p in prompts if p.strip()]
        return "\n".join(_truncate(p, 500) for p in prompts[-3:])

    def _questions(self, call: dict[str, Any]) -> dict[str, Any]:
        error_note = (
            " This call FAILED and its error is part of what-was-tried-and-failed history; "
            "losing it makes the assistant retry failed approaches."
            if call.get("is_error")
            else ""
        )
        ident_note = (
            " Its output carries file paths, identifiers, or error strings the assistant may "
            "still reference; a paraphrase would be worse than the full text."
            if call.get("has_identifier")
            else ""
        )
        return {
            f"call_{call['id']}": {
                "type": "noul",
                "instructions": (
                    f"Tool call {call['id']} ({call['tool']}) should stay in the history: knowing this call "
                    f"was made, with its input, still matters for what the assistant does next"
                    + error_note
                ),
            },
            f"result_{call['id']}": {
                "type": "noul",
                "instructions": (
                    f"The full output of tool call {call['id']} ({call['tool']}, {call['result_chars']} chars) "
                    f"should stay in the history verbatim: the assistant still needs its contents and "
                    f"re-running the tool would not do" + error_note + ident_note
                ),
            },
        }

    def _ask_all(
        self,
        state: dict[str, Any],
        state_tokens: int,
        candidates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        budget = self.max_request_tokens - state_tokens - REQUEST_OVERHEAD_TOKENS
        batches: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        current_tokens = 0
        for call in candidates:
            q_tokens = estimate_tokens(
                json.dumps(self._questions(call), ensure_ascii=False)
            )
            if current and current_tokens + q_tokens > budget:
                batches.append(current)
                current, current_tokens = [], 0
            current.append(call)
            current_tokens += q_tokens
        if current:
            batches.append(current)

        # ponytail: parallel batches (upstream parity), max 4 workers — TypeSafe rate limits
        def ask_one(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
            questions: dict[str, Any] = {}
            for call in batch:
                questions.update(self._questions(call))
            return self._ask_jev(state, questions, batch)

        answers: list[dict[str, Any]] = []
        if len(batches) > 1:
            with ThreadPoolExecutor(max_workers=min(4, len(batches))) as pool:
                for part in pool.map(ask_one, batches):
                    answers.extend(part)
        else:
            answers = ask_one(batches[0]) if batches else []
        return answers

    def _ask_jev(
        self,
        state: dict[str, Any],
        questions: dict[str, Any],
        batch: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        key = self.api_key.strip() if isinstance(self.api_key, str) else ""
        if not key:
            key = self._resolve_key()
        self.api_key = key
        payload: dict[str, Any] = {
            "model": self.model,
            "state": state,
            "questions": questions,
        }
        if self.egress_mode == "redacted_text":
            payload = redact_export_value(payload)
        body = json.dumps(payload).encode()
        parsed = _http_post_json(
            self.base_url,
            body,
            {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            60.0,
        )
        answers = parsed.get("answers") or {}
        out: list[dict[str, Any]] = []
        for call in batch:

            def noul(key: str = "") -> float:
                a = answers.get(key) or {}
                v = a.get("noul")
                if (
                    not isinstance(v, (int, float))
                    or not math.isfinite(v)
                    or not 0.0 <= v <= 1.0
                ):
                    raise ValueError(f"invalid Jev answer for {key}")
                return float(v)

            out.append(
                {
                    "keepCall": noul(f"call_{call['id']}"),
                    "keepResult": noul(f"result_{call['id']}"),
                }
            )
        return out

    @staticmethod
    def _resolve_key() -> str:
        try:
            from agent.secret_scope import get_secret

            key = get_secret("TYPESAFE_API_KEY")
        except Exception:  # noqa: BLE001 — secret-scope failure must fail closed
            raise RuntimeError(
                "TYPESAFE_API_KEY unavailable from profile secret scope"
            ) from None
        if not isinstance(key, str) or not key.strip():
            raise RuntimeError("TYPESAFE_API_KEY is not configured")
        return key.strip()

    def _decide(self, answer: dict[str, Any]) -> str:
        if answer["keepResult"] >= self.keep_threshold:
            return "keep"
        if answer["keepCall"] >= self.keep_threshold:
            return "drop_result"
        return "drop_call"

    @staticmethod
    def _has_identifier(text: str) -> bool:
        """Research guard: paraphrased identifiers are worse than dropped ones. Rows carrying
        paths/errors/IDs are biased to keep — losing them makes the agent hallucinate plausible
        but wrong paths (top compaction failure in practitioner reports)."""
        pattern = (
            "([A-Za-z]:[\\/]|/(?:home|Users|var|tmp|etc)/)"  # drive or POSIX path
            "|\\b(?:error|exception|traceback|failed|exit code)\\b"  # error words
            "|\\b[0-9a-f]{8,}\\b"  # long hex ids
        )
        return bool(re.search(pattern, text, re.IGNORECASE))

    def _apply(
        self,
        messages: list[dict[str, Any]],
        calls: list[dict[str, Any]],
        decisions: dict[str, str],
        min_reduction: float | None = None,
        hard_reduction: float | None = None,
    ) -> list[dict[str, Any]]:
        """Decisions applied with as few rails given up as `min_reduction` (default RAIL_FLOOR) needs (fork astra.10).

        Result by result, the step to a stricter tier that frees the most chars per fact-like token lost goes first.
        Only when even the strictest tier misses `hard_reduction` do the oldest dropped results give way
        (_last_resort). Hermes has no summary cliff: missing the target just means another compaction next turn, so
        the hard line is above the trigger (_hard_reduction), not the target; evicting for the target lost facts.
        """
        floor = RAIL_FLOOR if min_reduction is None else min_reduction
        hard = floor if hard_reduction is None else hard_reduction
        before = _chars(messages)
        rerunnable = {
            c["tool_call_id"] for c in calls if reproducible(c["tool"], c["input"])
        }
        dropped = {
            c["tool_call_id"] for c in calls if decisions.get(c["id"], "keep") != "keep"
        }
        texts = {
            m["tool_call_id"]: (
                _content_text(m.get("content")),
                bool(m.get("is_error")),
            )
            for m in messages
            if m.get("role") == "tool" and m.get("tool_call_id") in dropped
        }
        reduced_cache: dict[tuple[str, int], str] = {}

        def reduced(tc_id: str, tier: int) -> str:
            if (tc_id, tier) not in reduced_cache:
                text, is_error = texts[tc_id]
                reduced_cache[tc_id, tier] = reduced_text(
                    text, is_error, tc_id, RAIL_TIERS[tier], tc_id in rerunnable
                )
            return reduced_cache[tc_id, tier]

        level: dict[str, int] = {}
        need = before * (1 - floor)
        after = _chars(
            self._apply_tier(
                messages, calls, decisions, lambda i: RAIL_TIERS[level.get(i, 0)]
            )
        )
        top = 0
        while after > need and before > 0:
            best: tuple[str, int, int, float] | None = None
            for tc_id in texts:
                cur = level.get(tc_id, 0)
                for tier in range(cur + 1, len(RAIL_TIERS)):
                    gain = len(reduced(tc_id, cur)) - len(reduced(tc_id, tier))
                    if gain <= 0:
                        continue  # a tier that does not touch this result: look further
                    lost = len(
                        set(_FACT_TOKEN.findall(reduced(tc_id, cur)))
                        - set(_FACT_TOKEN.findall(reduced(tc_id, tier)))
                    )
                    score = gain / (1 + lost)
                    if best is None or score > best[3]:
                        best = (tc_id, tier, gain, score)
                    break
            if best is None:
                break
            level[best[0]] = best[1]
            top = max(top, best[1])
            after -= best[2]
        out = self._apply_tier(
            messages, calls, decisions, lambda i: RAIL_TIERS[level.get(i, 0)]
        )
        self._rail_tier = top
        hard_need = before * (1 - hard)
        if before and hard > 0 and _chars(out) > hard_need:
            evicted = self._last_resort(out, calls, decisions, hard_need)
            if evicted is not out:
                self._rail_tier = LAST_RESORT_TIER
                out = evicted
        return out

    def _last_resort(
        self,
        out: list[dict[str, Any]],
        calls: list[dict[str, Any]],
        decisions: dict[str, str],
        need: float,
    ) -> list[dict[str, Any]]:
        """The oldest dropped results give way when even the strictest tier is too big: first only their fact lines
        stay, then they become one-line notes. Pinned calls and Jev keeps are never touched."""
        order = [
            c["tool_call_id"]
            for c in calls
            if not c.get("pinned") and decisions.get(c["id"], "keep") != "keep"
        ]
        where = {
            m.get("tool_call_id"): k
            for k, m in enumerate(out)
            if m.get("role") == "tool"
        }
        res = list(out)
        total = _chars(res)
        changed = False

        def put(tc_id: str, text: str) -> None:
            nonlocal total, changed
            k = where[tc_id]
            total -= len(_content_text(res[k].get("content"))) - len(text)
            res[k] = dict(res[k], content=text)
            changed = True

        for tc_id in order:
            if total <= need:
                break
            if tc_id not in where:
                continue
            text = _content_text(res[where[tc_id]].get("content"))
            notes = [ln for ln in text.split("\n") if _COMPACTED_MARK.search(ln)] or [
                f"[jev-compaction omitted {len(text)} chars: only fact lines kept under context pressure; {full_output_note(tc_id)}]"
            ]
            nxt = "\n".join(fact_lines(text, len(text) // 4) + notes)
            if len(nxt) < len(text):
                put(tc_id, nxt)
        for tc_id in order:
            if total <= need:
                break
            if tc_id not in where:
                continue
            text = _content_text(res[where[tc_id]].get("content"))
            nxt = f"[jev-compaction omitted {len(text)} chars: evicted under context pressure, oldest first; {full_output_note(tc_id)}]"
            if len(nxt) < len(text):
                put(tc_id, nxt)
        return res if changed else out

    def _apply_tier(
        self,
        messages: list[dict[str, Any]],
        calls: list[dict[str, Any]],
        decisions: dict[str, str],
        rails: dict,
    ) -> list[dict[str, Any]]:
        # Fork port (fact-keeping fast-jev-compaction): nothing Jev drops is erased. A reproducible read of files
        # shrinks to its call plus one line; any other call (network, processes, logs, tests, side effects,
        # MCP) keeps a fact stub: head, fact lines (errors, paths, versions, ids, endpoints, codes), tail.
        # Errors keep 2000 chars (the failure-history guard in compress() already keeps their call).
        # `rails` is one tier for every result, or a function of the tool_call_id (the greedy in _apply).
        rails_for = rails if callable(rails) else (lambda _tc_id: rails)
        action_by_tool_call_id = {
            c["tool_call_id"]: decisions.get(c["id"], "keep") for c in calls
        }
        rerunnable = {
            c["tool_call_id"] for c in calls if reproducible(c["tool"], c["input"])
        }
        out: list[dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role")
            if role == "tool":
                tc_id = msg.get("tool_call_id")
                if action_by_tool_call_id.get(tc_id, "keep") != "keep":
                    text = _content_text(msg.get("content"))
                    is_error = bool(msg.get("is_error"))
                    reduced = reduced_text(
                        text, is_error, tc_id, rails_for(tc_id), tc_id in rerunnable
                    )
                    if reduced != text:
                        msg = dict(msg, content=reduced)
                out.append(msg)
                continue
            if role == "assistant" and msg.get("tool_calls"):
                # Tool pairing stays intact: a reduced call keeps its id, name and brief arguments.
                kept_calls = []
                for tc in msg["tool_calls"]:
                    action = action_by_tool_call_id.get(tc.get("id"), "keep")
                    if action == "drop_call" or (
                        action != "keep" and tc.get("id") in rerunnable
                    ):
                        func = tc.get("function") or {}
                        limit = (
                            RERUN_INPUT_CHARS
                            if tc.get("id") in rerunnable
                            else INPUT_BRIEF_CHARS
                        )
                        args = brief_args(
                            _parse_input(func.get("arguments", tc.get("arguments"))),
                            limit,
                        )
                        kept_calls.append(
                            {
                                "id": tc["id"],
                                "type": "function",
                                "function": {
                                    "name": func.get("name") or "unknown_tool",
                                    "arguments": json.dumps(args, ensure_ascii=False),
                                },
                            }
                        )
                    else:
                        kept_calls.append(tc)
                msg = dict(msg, tool_calls=kept_calls)
                out.append(msg)
                continue
            out.append(msg)
        return out

    def _min_reduction(
        self, messages: list[dict[str, Any]], current_tokens: int | None
    ) -> float:
        """What this compaction must free (fork astra.10's pressure): enough to bring the prompt back to 5/6 of the
        trigger. The part of the prompt outside the messages (system prompt, tools) does not shrink: it is the prompt's
        token count minus the messages' own estimate. Without figures, RAIL_FLOOR."""
        trigger = self._effective_trigger() if self.threshold_tokens else 0
        tokens = current_tokens or self.last_prompt_tokens
        est = _message_tokens(messages)
        if not trigger or not tokens or est <= 0:
            return RAIL_FLOOR
        overhead = max(0, tokens - est)
        return min(0.9, max(0.05, 1 - (trigger * 5 / 6 - overhead) / est))

    def _hard_reduction(
        self, messages: list[dict[str, Any]], current_tokens: int | None
    ) -> float:
        """What the prompt must lose to get under the hard line, 1.25x the trigger but at most 90% of the window's
        budget: below it the oldest results never give way (Hermes compacts again next turn instead). In the session
        model a line at the trigger itself lost facts against v0.6.0 (blind, 1.5 windows: 44 vs 50 of 56); at 1.25x it
        keeps 51. 0 when there is nothing to force or no figures."""
        trigger = self._effective_trigger() if self.threshold_tokens else 0
        tokens = current_tokens or self.last_prompt_tokens
        est = _message_tokens(messages)
        if not trigger or not tokens or est <= 0:
            return 0.0
        if self.max_tokens and self.context_length > self.max_tokens:
            budget = self.context_length - self.max_tokens
        else:
            budget = int((self.context_length or 0) * (1.0 - self._RESERVED_FRACTION))
        line = min(trigger * 1.25, 0.9 * budget) if budget else trigger * 1.25
        overhead = max(0, tokens - est)
        return min(0.9, max(0.0, 1 - (line - overhead) / est))

    # Save the full output of every reduced result (fork astra.11): what a stub does not keep stays one read away.
    save_full_outputs = os.environ.get("JEV_COMPACTION_SAVE_OUTPUTS", "1") != "0"

    def _outputs_dir(self) -> Path:
        try:
            from hermes_constants import get_hermes_home

            home = Path(get_hermes_home())
        except Exception:  # noqa: BLE001 — outside Hermes (tests, offline runs)
            home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
        session = re.sub(r"[^\w.-]", "_", self._snapshot_session_id or "session")
        # Under cache/: the station's restic backup (**/cache) and indexers skip it; state.db is not backed up either.
        return home / "cache" / "jev-compaction" / session

    # Saved outputs live as long as a Claude Code transcript by default; expired files are deleted once a day.
    OUTPUT_MAX_AGE_S = 30 * 24 * 3600
    _last_expiry = 0.0

    @classmethod
    def _expire_outputs(cls, root: Path, now: float | None = None) -> int:
        """Deletes saved outputs older than OUTPUT_MAX_AGE_S under `root` and the session folders left empty."""
        now = time.time() if now is None else now
        removed = 0
        try:
            sessions = [d for d in root.iterdir() if d.is_dir()]
        except OSError:
            return 0
        for session in sessions:
            try:
                for f in session.glob("*.txt"):
                    if now - f.stat().st_mtime > cls.OUTPUT_MAX_AGE_S:
                        f.unlink()
                        removed += 1
                if not any(session.iterdir()):
                    session.rmdir()
            except OSError:
                continue
        return removed

    @staticmethod
    def _redact(text: str) -> str | None:
        """Hermes' shared redactor (the one egress uses) on a copy about to be saved; None when it is unavailable,
        so nothing unredacted is written (fail closed)."""
        try:
            from agent.redact import redact_sensitive_text

            return redact_sensitive_text(text, force=True, redact_url_credentials=True)
        except Exception:  # noqa: BLE001 — no redactor, no file
            return None

    def _offload(
        self, original: list[dict[str, Any]], out: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Writes the full output of every result the compaction reduced to <hermes home>/jev-compaction/outputs/
        <session>/<tool_call_id>.txt and points its note there; a write that fails leaves the note as it was."""
        if not self.save_full_outputs:
            return out
        full = {
            m.get("tool_call_id"): _content_text(m.get("content"))
            for m in original
            if m.get("role") == "tool"
        }
        base: Path | None = None
        res = []
        for m in out:
            tc_id = m.get("tool_call_id") if m.get("role") == "tool" else None
            text = _content_text(m.get("content")) if tc_id else ""
            note = full_output_note(tc_id) if tc_id else ""
            if not tc_id or note not in text or tc_id not in full:
                res.append(m)
                continue
            redacted = self._redact(full[tc_id])
            if redacted is None:
                res.append(m)
                continue
            try:
                if base is None:
                    base = self._outputs_dir()
                    now = time.time()
                    if now - JevEngine._last_expiry > 24 * 3600:
                        JevEngine._last_expiry = now
                        self._expire_outputs(base.parent, now)
                path = base / f"{re.sub(r'[^\w.-]', '_', tc_id)}.txt"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(redacted.encode("utf-8"))
                saved = f"the full output is saved at {path.as_posix()}; read it for anything not kept here"
                res.append(dict(m, content=text.replace(note, saved)))
            except OSError:
                res.append(m)
        return res

    def _fallback_prune(
        self,
        messages: list[dict[str, Any]],
        calls: list[dict[str, Any]] | None = None,
        min_reduction: float | None = None,
        hard_reduction: float | None = None,
    ) -> list[dict[str, Any]]:
        """Deterministic degrade when Jev is unreachable: every old unpinned call is reduced by the same
        rules as a Jev "drop_result" — a reproducible read shrinks to a line, anything else keeps a
        fact stub (head, fact lines with errors / paths / ids / codes, tail; errors keep 2000 chars).
        Nothing is erased and no summary is written, so no fact is paraphrased away."""
        calls = self._collect_calls(messages) if calls is None else calls
        return self._apply(
            messages,
            calls,
            {c["id"]: "drop_result" for c in calls if not c["pinned"]},
            min_reduction,
            hard_reduction,
        )


def register(ctx: Any) -> None:
    """Plugin entry: register the single context engine."""
    engine = JevEngine()
    try:
        from hermes_cli.config import load_config_readonly

        cfg = load_config_readonly() or {}
        compression = cfg.get("compression") or {}
        engine.threshold_percent = float(compression.get("threshold", 0.9))
        engine.max_tokens = (cfg.get("agent") or {}).get("max_tokens") or None
        engine.egress_mode = ((cfg.get("context") or {}).get("jev") or {}).get(
            "egress_mode", "metadata"
        )
        jev_cfg = (cfg.get("context") or {}).get("jev") or {}
        engine.model = jev_cfg.get("model", engine.model)
        engine.keep_threshold = float(
            jev_cfg.get("keep_threshold", engine.keep_threshold)
        )
        engine.max_state_tokens = int(
            jev_cfg.get("max_state_tokens", engine.max_state_tokens)
        )
        engine.max_request_tokens = int(
            jev_cfg.get("max_request_tokens", engine.max_request_tokens)
        )
    except Exception:  # defaults survive any config problem
        logging.getLogger(__name__).debug(
            "jev-context-engine: config not read, defaults kept", exc_info=True
        )
    ctx.register_context_engine(engine)
