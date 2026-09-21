"""hermes-jev-compaction — Jev context engine plugin for Hermes Agent.

Registers a ContextEngine that replaces lossy compaction summaries with Jev
decisions (TypeSafe System One API): every tool call is scored, stale calls
and results are dropped or truncated, everything kept stays verbatim.

Deploy: copy this directory to ~/.hermes/plugins/jev-context-engine/ and set
``context.engine: jev`` in config.yaml. Requires TYPESAFE_API_KEY in the
environment (the Hermes .env is loaded into os.environ at startup).
Config (optional, under ``context.jev``): model, keep_threshold,
max_state_tokens, max_request_tokens.

Known limitation (upstream, affects every engine incl. the built-in one):
live-config hot-apply (``tui_gateway/session_compression.py::
_apply_live_compression_config``) currently raises ``NameError:
is_truthy_value is not defined`` on line 88 — the helper is called but never
defined/imported in that module (NousResearch/hermes-agent issue #115572).
Practical effect: editing ``compression.*`` keys in config.yaml while a
session is live may not propagate to the running engine; the values are
picked up by the NEXT session start. This plugin carries the full attribute
surface the function pokes (``_coerce_threshold_tokens_cap`` and friends) so
the engine itself survives the call; the NameError fires on the host side
before reaching the engine.
"""
from __future__ import annotations

import json
import math
import re
import time
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

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
TRUNCATE_HEAD_CHARS = 300
REQUEST_OVERHEAD_TOKENS = 20
_ALLOWED_SCHEMES = ("https://", "http://")
_TOKEN_PIECES = re.compile(r"[A-Za-z]+|\d+|[^\sA-Za-z\d]")
_IDENTIFIER_RE = re.compile(
    r"([A-Za-z]:[\\/]|/(?:home|Users|var|tmp|etc)/)"
    r"|\b(?:error|exception|traceback|failed|exit code)\b"
    r"|\b[0-9a-f]{8,}\b",
    re.IGNORECASE)

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
    return f"{text[:head]}\n[… {len(text) - head - tail} chars omitted …]\n{text[-tail:]}"

def _http_post_json(url: str, body: bytes, headers: Dict[str, str], timeout: float) -> Dict[str, Any]:
    """POST JSON to an http(s) URL only; anything else is refused before any I/O."""
    if not url.startswith(_ALLOWED_SCHEMES):
        raise ValueError(f"unsupported base_url scheme: {url.split(':', 1)[0]}")
    req = urllib.request.Request(url, data=body, headers=headers)  # noqa: S310 — scheme-guarded above
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — scheme-guarded above
        return json.loads(resp.read())

class JevEngine(EngineSettings):
    """Verbatim-keep compaction: Jev decides, nothing is summarized."""

    # -- host contract ----------------------------------------------------
    @property
    def name(self) -> str:
        return "jev"

    def update_from_response(self, usage: Dict[str, Any]) -> None:
        self.last_prompt_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        self.last_completion_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
        total = usage.get("total_tokens")
        self.last_total_tokens = int(total) if total else self.last_prompt_tokens + self.last_completion_tokens

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

    def should_compress(self, prompt_tokens: int = None) -> bool:
        if self._cooling():
            return False
        tokens = prompt_tokens or self.last_prompt_tokens
        if not self.threshold_tokens:
            return False
        return tokens >= self._effective_trigger()

    # -- compaction --------------------------------------------------------
    def compress(
        self, messages: List[Dict[str, Any]], current_tokens: Optional[int] = None,
        focus_topic: Optional[str] = None, force: bool = False, memory_context: str = "",
        bypass_cooldown: bool = False,
    ) -> List[Dict[str, Any]]:
        self.compression_count += 1
        self._messages_ref = messages
        self._memory_context = (memory_context or "").strip()[:2000]
        stats: Dict[str, Any] = {"calls": 0, "candidates": 0, "mode": "jev"}
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
        try:
            state, state_tokens = self._fit_state(messages, calls)
            answers = self._ask_all(state, state_tokens, candidates)
        except Exception:  # noqa: BLE001 — fail-open preserves original
            stats["mode"] = "preserve"
            stats["error"] = "egress or Jev failure"
            self._last_failure_monotonic = time.monotonic()
            return messages  # fail-open: Jev failure never mutates history
        by_id = {}
        for c, a in zip(candidates, answers, strict=False):
            d = self._decide(a)
            # Research guard: failure history survives. An error result may lose verbatim bulk
            # (drop_result) but its call + bounded head must stay — retrying failed approaches
            # is the most expensive post-compaction bug class.
            if d == "drop_call" and c.get("is_error"):
                d = "drop_result"
            by_id[c["id"]] = d
        out = self._apply(messages, calls, by_id)
        dropped_calls = [c for c in calls if by_id.get(c["id"]) == "drop_call"]
        self._dropped_receipts = getattr(self, "_dropped_receipts", [])[-100:]
        for c in dropped_calls:
            original = next(
                (m for m in messages if m.get("role") == "tool" and m.get("tool_call_id") == c["tool_call_id"]),
                None)
            text = _content_text(original.get("content")) if original else ""
            self._dropped_receipts.append({
                "tool_call_id": c["tool_call_id"],
                "tool": c.get("tool", "unknown"),
                "preview": text[:80],
                "full": text,
            })
        stats.update({
            "kept": sum(1 for d in by_id.values() if d == "keep"),
            "results_truncated": sum(1 for d in by_id.values() if d == "drop_result"),
            "calls_dropped": sum(1 for d in by_id.values() if d == "drop_call"),
            "state_tokens": state_tokens,
        })
        return out

    # -- internals ---------------------------------------------------------

    def _collect_calls(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Pair assistant tool_calls with role:"tool" result messages by tool_call_id."""
        results: Dict[str, Dict[str, Any]] = {}
        for idx, msg in enumerate(messages):
            if msg.get("role") == "tool" and msg.get("tool_call_id"):
                results[msg["tool_call_id"]] = {
                    "index": idx, "text": _content_text(msg.get("content")),
                    "is_error": bool(msg.get("is_error"))}
        calls: List[Dict[str, Any]] = []
        for idx, msg in enumerate(messages):
            for tc in msg.get("tool_calls") or []:
                call_id = tc.get("id") or ""
                found = results.get(call_id)
                if found is None:
                    continue
                func = tc.get("function") or {}
                calls.append({
                    "id": f"t{len(calls) + 1}", "tool_call_id": call_id,
                    "tool": func.get("name") or tc.get("name") or "unknown_tool",
                    "input": _parse_input(func.get("arguments", tc.get("arguments"))),
                    "call_index": idx, "result_index": found["index"],
                    "result_chars": len(found["text"]),
                    "is_error": bool(found.get("is_error")),
                    "has_identifier": self._has_identifier(found["text"]),
                    "pinned": self._pinned(idx) or self._pinned(found["index"]),
                })
        return calls

    def _pinned(self, index: int) -> bool:
        return index == 0 or index >= len(self._messages_ref) - self.protect_last_n

    def _fit_state(
        self, messages: List[Dict[str, Any]], calls: List[Dict[str, Any]],
    ) -> Tuple[Dict[str, Any], int]:
        """Whole conversation as Jev state; staged shrink until it fits max_state_tokens."""
        by_call_idx: Dict[int, List[Dict[str, Any]]] = {}
        for c in calls:
            by_call_idx.setdefault(c["call_index"], []).append(c)

        def entries(input_chars: int) -> List[Dict[str, Any]]:
            out: List[Dict[str, Any]] = []
            for i, msg in enumerate(messages):
                tool_calls = [{
                    "id": c["id"], "tool": c["tool"],
                    "input": metadata_input(c["input"]) if self.egress_mode == "metadata" else _truncate(
                        c["input"] if isinstance(c["input"], str) else json.dumps(c["input"], ensure_ascii=False),
                        input_chars),
                    "result": f"ok, {c['result_chars']} chars (omitted)",
                } for c in by_call_idx.get(i, [])]
                text = _content_text(msg.get("content"))
                if msg.get("role") == "tool":
                    text = f"[{len(text)} chars omitted]" if text else ""
                elif self.egress_mode == "metadata":
                    text = f"[{len(text)} chars]" if text else ""
                if not text.strip() and not tool_calls:
                    continue
                entry: Dict[str, Any] = {"i": i, "role": msg.get("role"), "text": text}
                if tool_calls:
                    entry["tool_calls"] = tool_calls
                out.append(entry)
            return out

        def pack(history: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], int]:
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

        def old(e: Dict[str, Any]) -> bool:
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
                    for tc in e["tool_calls"]]
                state, tokens = pack(history)
                if tokens <= self.max_state_tokens:
                    return state, tokens
        kept = [e for e in history if not old(e) or e.get("tool_calls")]
        state, tokens = pack(kept)
        if tokens > self.max_state_tokens:
            raise ValueError(f"history too large for Jev (~{tokens} tokens, limit {self.max_state_tokens})")
        return state, tokens

    def _goal(self) -> str:
        if self.egress_mode == "metadata":
            return ""  # metadata mode: no user text leaves the process
        prompts = [_content_text(m.get("content")) for m in self._messages_ref if m.get("role") == "user"]
        prompts = [p for p in prompts if p.strip()]
        return "\n".join(_truncate(p, 500) for p in prompts[-3:])

    def _questions(self, call: Dict[str, Any]) -> Dict[str, Any]:
        error_note = (
            " This call FAILED and its error is part of what-was-tried-and-failed history; "
            "losing it makes the assistant retry failed approaches." if call.get("is_error") else "")
        ident_note = (
            " Its output carries file paths, identifiers, or error strings the assistant may "
            "still reference; a paraphrase would be worse than the full text." if call.get("has_identifier") else "")
        return {
            f"call_{call['id']}": {"type": "noul", "instructions": (
                f"Tool call {call['id']} ({call['tool']}) should stay in the history: knowing this call "
                f"was made, with its input, still matters for what the assistant does next"
                + error_note)},
            f"result_{call['id']}": {"type": "noul", "instructions": (
                f"The full output of tool call {call['id']} ({call['tool']}, {call['result_chars']} chars) "
                f"should stay in the history verbatim: the assistant still needs its contents and "
                f"re-running the tool would not do" + error_note + ident_note)},
        }

    def _ask_all(
        self, state: Dict[str, Any], state_tokens: int, candidates: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        budget = self.max_request_tokens - state_tokens - REQUEST_OVERHEAD_TOKENS
        batches: List[List[Dict[str, Any]]] = []
        current: List[Dict[str, Any]] = []
        current_tokens = 0
        for call in candidates:
            q_tokens = estimate_tokens(json.dumps(self._questions(call), ensure_ascii=False))
            if current and current_tokens + q_tokens > budget:
                batches.append(current)
                current, current_tokens = [], 0
            current.append(call)
            current_tokens += q_tokens
        if current:
            batches.append(current)
        answers: List[Dict[str, Any]] = []
        for batch in batches:
            questions: Dict[str, Any] = {}
            for call in batch:
                questions.update(self._questions(call))
            answers.extend(self._ask_jev(state, questions, batch))
        return answers

    def _ask_jev(
        self, state: Dict[str, Any], questions: Dict[str, Any], batch: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        key = self.api_key.strip() if isinstance(self.api_key, str) else ""
        if not key:
            key = self._resolve_key()
        self.api_key = key
        payload: Dict[str, Any] = {"model": self.model, "state": state, "questions": questions}
        if self.egress_mode == "redacted_text":
            payload = redact_export_value(payload)
        body = json.dumps(payload).encode()
        parsed = _http_post_json(self.base_url, body, {
            "Authorization": f"Bearer {key}", "Content-Type": "application/json"}, 60.0)
        answers = parsed.get("answers") or {}
        out: List[Dict[str, Any]] = []
        for call in batch:

            def noul(key: str = "") -> float:
                a = answers.get(key) or {}
                v = a.get("noul")
                if not isinstance(v, (int, float)) or not math.isfinite(v) or not 0.0 <= v <= 1.0:
                    raise ValueError(f"invalid Jev answer for {key}")
                return float(v)

            out.append({"keepCall": noul(f"call_{call['id']}"), "keepResult": noul(f"result_{call['id']}")})
        return out

    @staticmethod
    def _resolve_key() -> str:
        try:
            from agent.secret_scope import get_secret
            key = get_secret("TYPESAFE_API_KEY")
        except Exception:  # noqa: BLE001 — secret-scope failure must fail closed
            raise RuntimeError("TYPESAFE_API_KEY unavailable from profile secret scope") from None
        if not isinstance(key, str) or not key.strip():
            raise RuntimeError("TYPESAFE_API_KEY is not configured")
        return key.strip()

    def _decide(self, answer: Dict[str, Any]) -> str:
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
            "([A-Za-z]:[\\/]|/(?:home|Users|var|tmp|etc)/)"      # drive or POSIX path
            "|\\b(?:error|exception|traceback|failed|exit code)\\b"  # error words
            "|\\b[0-9a-f]{8,}\\b"                               # long hex ids
        )
        return bool(re.search(pattern, text, re.IGNORECASE))

    def _apply(
        self, messages: List[Dict[str, Any]], calls: List[Dict[str, Any]], decisions: Dict[str, str],
    ) -> List[Dict[str, Any]]:
        action_by_tool_call_id = {c["tool_call_id"]: decisions.get(c["id"], "keep") for c in calls}
        dropped = {tc_id for tc_id, a in action_by_tool_call_id.items() if a == "drop_call"}
        out: List[Dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role")
            if role == "tool":
                tc_id = msg.get("tool_call_id")
                if tc_id in dropped:
                    # Keep the row (Hermes indexes messages by position after the seam);
                    # blank the payload so the provider ignores it.
                    out.append({"role": "tool", "tool_call_id": tc_id,
                                "content": "[dropped by jev-compaction: judged no longer relevant]"})
                    continue
                if action_by_tool_call_id.get(tc_id) == "drop_result":
                    text = _content_text(msg.get("content"))
                    if len(text) > TRUNCATE_HEAD_CHARS + 120:
                        if self._RECEIPT_RE.search(text):
                            # Receipt (confirmation ID) lives deeper than the kept
                            # head — keep head + tail so non-idempotent tool
                            # confirmations survive compaction.
                            keep = TRUNCATE_HEAD_CHARS // 2
                            msg = dict(msg, content=(
                                text[:keep]
                                + f"\n[jev truncated {len(text) - keep - keep} middle chars; "
                                  f"receipt markers preserved]\n"
                                + text[-keep:]))
                        else:
                            msg = dict(msg, content=(
                                text[:TRUNCATE_HEAD_CHARS]
                                + f"\n[jev truncated {len(text) - TRUNCATE_HEAD_CHARS} chars of this tool result; "
                                  f"re-run the tool if needed]"))
                out.append(msg)
                continue
            if role == "assistant" and msg.get("tool_calls"):
                # Preserve tool pairing: dropped calls become stub entries with
                # same id/name/empty args so the tool-result stub still pairs.
                kept_calls = []
                for tc in msg["tool_calls"]:
                    if tc.get("id") in dropped:
                        func = tc.get("function") or {}
                        kept_calls.append({
                            "id": tc["id"], "type": "function",
                            "function": {"name": func.get("name") or "unknown_tool",
                                         "arguments": "{}"}})
                    else:
                        kept_calls.append(tc)
                msg = dict(msg, tool_calls=kept_calls)
                out.append(msg)
                continue
            out.append(msg)
        return out

    # Receipt markers: losing a confirmation id is worse than keeping the bulk.
    _RECEIPT_RE = re.compile(
        r"\b(?:id|message_id|commit|sha|hash|ticket|confirm(?:ed)?|sent|delivered|"
        r"created|updated|deleted|order|transaction)\b[\s:=]*[\w\-]+", re.IGNORECASE)

    def _fallback_prune(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Deterministic degrade when Jev is unreachable. Old unprotected results are
        truncated head+tail (tail kept: confirmations live at the end); results matching
        receipt markers are never truncated — non-idempotent tools can't be re-run."""
        out: List[Dict[str, Any]] = []
        threshold_idx = max(0, len(messages) - self.protect_last_n)
        for idx, msg in enumerate(messages):
            if msg.get("role") == "tool" and idx != 0 and idx < threshold_idx:
                text = _content_text(msg.get("content"))
                if len(text) > TRUNCATE_HEAD_CHARS + 120:
                    if self._RECEIPT_RE.search(text):
                        # Keep tail (confirmations) + head marker, drop the bulky middle.
                        keep = TRUNCATE_HEAD_CHARS // 2
                        msg = dict(msg, content=(
                            text[:keep]
                            + f"\n[jev fallback: {len(text) - keep - keep} middle chars truncated; "
                              f"receipt markers preserved]\n"
                            + text[-keep:]))
                    else:
                        msg = dict(msg, content=(
                            text[:TRUNCATE_HEAD_CHARS]
                            + f"\n[jev fallback truncated {len(text) - TRUNCATE_HEAD_CHARS} chars; "
                              f"re-run the tool if needed]"))
            out.append(msg)
        return out


def register(ctx: Any) -> None:
    """Plugin entry: register the single context engine."""
    engine = JevEngine()
    try:
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly() or {}
        compression = cfg.get("compression") or {}
        engine.threshold_percent = float(compression.get("threshold", 0.9))
        engine.max_tokens = (cfg.get("agent") or {}).get("max_tokens") or None
        engine.egress_mode = ((cfg.get("context") or {}).get("jev") or {}).get("egress_mode", "metadata")
        jev_cfg = (cfg.get("context") or {}).get("jev") or {}
        engine.model = jev_cfg.get("model", engine.model)
        engine.keep_threshold = float(jev_cfg.get("keep_threshold", engine.keep_threshold))
        engine.max_state_tokens = int(jev_cfg.get("max_state_tokens", engine.max_state_tokens))
        engine.max_request_tokens = int(jev_cfg.get("max_request_tokens", engine.max_request_tokens))
    except Exception:  # noqa: BLE001 — defaults survive any config problem
        pass
    ctx.register_context_engine(engine)
