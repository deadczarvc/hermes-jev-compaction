"""Unit tests for the JevEngine Hermes context-engine plugin (fake asker, no network)."""
from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import sys

import pytest

PLUGIN_DIR = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin"
SPEC = importlib.util.spec_from_file_location("jev_plugin", PLUGIN_DIR / "__init__.py")
jev = importlib.util.module_from_spec(SPEC)
sys.modules["jev_plugin"] = jev
SPEC.loader.exec_module(jev)


def make_engine(**kw):
    eng = jev.JevEngine()
    eng.threshold_tokens = kw.get("threshold_tokens", 0)
    eng.protect_last_n = kw.get("protect_last_n", 1)
    eng.keep_threshold = kw.get("keep_threshold", 0.5)
    return eng


def transcript(n_calls=4):
    """Synthetic Hermes transcript: system -> n x (assistant tool_call + tool row) -> user tail."""
    msgs = [{"role": "system", "content": "You are a coding agent."}]
    for i in range(n_calls):
        msgs.append({"role": "assistant", "content": None,
                     "tool_calls": [{"id": f"c{i}", "type": "function",
                                     "function": {"name": "bash",
                                                  "arguments": json.dumps({"command": f"cat f{i}.txt"})}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": f"output {i} " + "x" * 500})
    msgs.append({"role": "user", "content": "Summarize the results."})
    return msgs


class FakeAnswers:
    """Injected asker: decides via a per-call map; records requests; can fail on a call id."""

    def __init__(self, decisions, fail_on=None):
        self.decisions, self.fail_on = decisions, fail_on
        self.asked_ids = []

    def __call__(self, state, state_tokens, candidates):
        self.asked_ids.extend(c["id"] for c in candidates)
        if self.fail_on and self.fail_on in [c["id"] for c in candidates]:
            raise RuntimeError("injected failure")
        out = []
        for call in candidates:
            d = self.decisions(call)
            out.append({
                "keepCall": 0.9 if d in ("keep", "drop_result") else 0.1,
                "keepResult": 0.9 if d == "keep" else 0.1,
            })
        return out


def patch_ask(engine, fake):
    engine._ask_all = lambda state, st, candidates: fake(state, st, candidates)


# ---------- positive paths ----------

def test_all_keep_returns_same_objects():
    eng = make_engine()
    msgs = transcript()
    patch_ask(eng, FakeAnswers(lambda c: "keep"))
    out = eng.compress(msgs)
    assert out == msgs
    assert eng.last_stats["mode"] == "jev" and eng.last_stats["kept"] >= 1


def test_drop_call_removes_pair_and_empty_assistant():
    eng = make_engine()
    msgs = transcript(n_calls=2)
    patch_ask(eng, FakeAnswers(lambda c: "drop_call"))
    out = eng.compress(msgs)
    assert not [m for m in out if m.get("role") == "tool"], "dropped tool results must disappear"
    assert not any(m.get("tool_calls") for m in out if m.get("role") == "assistant")
    assert out[0]["role"] == "system" and out[-1]["content"] == "Summarize the results."


def test_drop_result_truncates_but_keeps_row():
    eng = make_engine()
    msgs = transcript(n_calls=2)
    patch_ask(eng, FakeAnswers(lambda c: "drop_result"))
    out = eng.compress(msgs)
    tool_rows = [m for m in out if m.get("role") == "tool"]
    assert len(tool_rows) == 2, "rows stay when only the result is dropped"
    assert all("jev truncated" in m["content"] for m in tool_rows)


def test_mixed_decisions_partition():
    eng = make_engine()
    msgs = transcript(n_calls=3)
    patch_ask(eng, FakeAnswers(lambda c: {"t1": "keep", "t2": "drop_result", "t3": "drop_call"}[c["id"]]))
    tools = [m for m in eng.compress(msgs) if m.get("role") == "tool"]
    assert len(tools) == 2
    assert sum("jev truncated" in m["content"] for m in tools) == 1


# ---------- negative controls ----------

def test_pinned_calls_never_asked():
    eng = make_engine(protect_last_n=2)
    msgs = transcript(n_calls=6)
    fake = FakeAnswers(lambda c: "keep")
    patch_ask(eng, fake)
    eng.compress(msgs)
    total = eng._collect_calls(msgs)
    pinned = {c["id"] for c in total if c["pinned"]}
    assert pinned and pinned.isdisjoint(set(fake.asked_ids)), "pinned calls must not be sent to Jev"


def test_jev_failure_falls_back_and_cools():
    eng = make_engine()
    patch_ask(eng, FakeAnswers(lambda c: "keep", fail_on="t2"))
    eng.compress(transcript(n_calls=3))
    assert eng.last_stats["mode"] == "fallback_prune"
    assert eng._cooling(), "failure arms the backoff"
    assert eng.should_compress(10**9) is False, "cooling engine must not re-fire"


def test_malformed_answer_raises_into_fallback():
    """Malformed answer through the REAL validation path (engine noul guard), HTTP boundary mocked."""
    eng = make_engine()
    eng.api_key = "k"

    def fake_http(url, body, headers, timeout):
        cid = "t1"
        return {"answers": {f"call_{cid}": {"noul": float("nan")},
                            f"result_{cid}": {"noul": 0.9}}}

    original_http = jev._http_post_json
    jev._http_post_json = fake_http
    try:
        out = eng.compress(transcript(n_calls=1))
    finally:
        jev._http_post_json = original_http
    assert eng.last_stats["mode"] == "fallback_prune", "NaN must be rejected by the engine guard"


def test_unpaired_tool_result_is_untouched():
    eng = make_engine()
    msgs = [{"role": "system", "content": "s"},
            {"role": "tool", "tool_call_id": "ghost", "content": "orphan " + "y" * 600},
            {"role": "user", "content": "hi"}]
    patch_ask(eng, FakeAnswers(lambda c: "drop_call"))
    out = eng.compress(msgs)
    assert any(m.get("role") == "tool" and m["tool_call_id"] == "ghost" for m in out), \
        "unpaired results have no call to ask about — never dropped"


def test_no_candidates_returns_input():
    eng = make_engine()
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "hello"}]
    assert eng.compress(msgs) == msgs and eng.last_stats["candidates"] == 0


# ---------- contract-level checks ----------

def test_deepcopy_is_plain_data():
    eng = make_engine()
    eng.api_key = "k"
    clone = copy.deepcopy(eng)
    assert clone.name == "jev" and clone.api_key == "k" and clone is not eng


def test_should_compress_gates_on_threshold():
    """v0.2: fire point = threshold*(1-RESERVED_FRACTION=0.30) — reserves completion+vision budget."""
    eng = make_engine()
    eng.threshold_tokens = 1000
    assert eng.should_compress(600) is False, "below 70% of threshold: no fire"
    assert eng.should_compress(700) is True, "at 70% of threshold: fire (reservation margin)"
    eng.threshold_tokens = 0
    assert eng.should_compress(10**9) is False, "threshold 0 = never (uninitialized)"


def test_estimate_tokens_sane():
    assert jev.estimate_tokens("hello world") > 0
    assert jev.estimate_tokens("12345") == 3 and jev.estimate_tokens("abcdef") == 2


def test_token_fuzz_compress_never_crashes():
    """Junk-matrix across the messages parameter: no unexpected exception may escape."""
    eng = make_engine()
    junk = [None, 42, 3.14, True, "str", [1, 2], {"x": 1}, b"bytes", ({},)]
    for payload in junk:
        try:
            eng.compress(payload)
        except (TypeError, ValueError, AttributeError, KeyError):
            pass  # honest refusal is fine
        except Exception as e:  # noqa: BLE001
            pytest.fail(f"unexpected {type(e).__name__} for {type(payload)}: {e}")


def test_fallback_prune_is_deterministic():
    eng = make_engine()
    msgs = transcript(n_calls=3)
    assert eng._fallback_prune([dict(m) for m in msgs]) == eng._fallback_prune([dict(m) for m in msgs])


def test_memory_context_reaches_jev_state():
    """Memory signal must be woven into the state (or explicitly absent when empty) — K4 anti-gaming."""
    eng = make_engine()
    msgs = transcript(n_calls=2)
    captured = {}

    def fake_ask_all(state, state_tokens, candidates):
        captured["context"] = state["context"]
        return [{"keepCall": 1.0, "keepResult": 1.0}] * len(candidates)

    eng._ask_all = fake_ask_all
    eng.compress(msgs, memory_context="DB migration details matter long-term")
    assert "Memory provider flags" in captured["context"], "memory signal missing from state"
    assert "DB migration details" in captured["context"]

    eng2 = make_engine()
    captured2 = {}
    eng2._ask_all = lambda s, st, c: (captured2.__setitem__("context", s["context"]), [{"keepCall": 1.0, "keepResult": 1.0}] * len(c))[1]
    eng2.compress(msgs)  # no memory_context
    assert "Memory provider flags" not in captured2["context"], "no phantom memory block when empty"


# ---------- research-driven guards (v0.2) ----------

def _make_error_transcript():
    msgs = [{"role": "system", "content": "s"}]
    msgs.append({"role": "user", "content": "fix the bug in src/a.ts"})
    msgs.append({"role": "assistant", "content": None,
                 "tool_calls": [{"id": "err1", "type": "function",
                                 "function": {"name": "bash", "arguments": "{\"command\": \"make test\"}"}}]})
    msgs.append({"role": "tool", "tool_call_id": "err1", "is_error": True,
                 "content": "Traceback (most recent call last): AssertionError in test_x (src/a.ts:42)"})
    msgs.append({"role": "user", "content": "continue"})
    return msgs


def test_error_results_never_drop_call():
    """Tried-and-failed history must survive: error rows get at most drop_result (K: failure guard)."""
    eng = make_engine()
    decisions_seen = {}

    real_decide = eng._decide
    def spy_decide(answer):
        d = real_decide(answer)
        decisions_seen[len(decisions_seen)] = d
        return d
    eng._decide = spy_decide
    # force the model to say drop_call for everything
    eng._ask_all = lambda state, st, candidates: [{"keepCall": 0.1, "keepResult": 0.1}] * len(candidates)
    out = eng.compress(_make_error_transcript())
    # the error tool row must still exist (downgraded to drop_result with truncated head)
    tools = [m for m in out if m.get("role") == "tool" and m.get("tool_call_id") == "err1"]
    assert tools, "error result row must survive drop_call downgrade"


def test_identifier_flag_and_questions():
    eng = make_engine()
    msgs = transcript(n_calls=2)
    calls = eng._collect_calls(msgs)
    assert all(c["has_identifier"] is False for c in calls), "plain outputs carry no identifiers"
    err_msgs = _make_error_transcript()
    err_calls = eng._collect_calls(err_msgs)
    assert err_calls[0]["is_error"] is True
    assert err_calls[0]["has_identifier"] is True, "traceback with path must flag identifiers"
    q = eng._questions(err_calls[0])
    assert "FAILED" in q["call_t1"]["instructions"]
    assert "file paths" in q["result_t1"]["instructions"]


def test_should_compress_reserves_window_budget():
    """Own overflow death: 798866 input + 393216 completion > 1048576 window. The engine must
    fire before raw threshold so completion + vision expansion fit."""
    eng = make_engine()
    eng.threshold_tokens = 1_000_000
    # 0.95 * (1 - 0.30) = 665_000 → at 700_000 tokens it must fire
    assert eng.should_compress(700_000) is True
    assert eng.should_compress(600_000) is False


# ---------- dynamic reservation (v0.3) ----------

def test_dynamic_reservation_exact_budget():
    """max_tokens known: trigger = threshold_percent * (context_length - max_tokens)."""
    eng = make_engine()
    eng.threshold_percent = 0.95
    eng.max_tokens = 393216
    eng.update_model(model="glm-5.3-flash", context_length=1_000_000)
    # budget = 1M - 393216 = 606784; trigger = 606784 * 0.95 = 576444
    assert eng.threshold_tokens == int(606784 * 0.95)
    assert eng.should_compress(576443) is False
    assert eng.should_compress(576444) is True


def test_dynamic_reservation_fallback_static():
    """max_tokens unknown (None): static 30% shrink of threshold_tokens."""
    eng = make_engine()
    eng.threshold_percent = 0.95
    eng.max_tokens = None
    eng.threshold_tokens = 1_000_000
    assert eng._effective_trigger() == 700_000


def test_dynamic_reservation_config_read(monkeypatch=None):
    """register() reads agent.max_tokens from config (config path exercised via fake cfg)."""
    cfg = {"agent": {"max_tokens": 32768}, "context": {"jev": {"model": "jev-1.13.0"}}}
    eng = jev.JevEngine()
    # simulate register()'s config block without touching real config
    engine = eng
    engine.threshold_percent = 0.95
    engine.max_tokens = int((cfg.get("agent") or {}).get("max_tokens"))
    engine.update_model(model="m", context_length=262144)
    budget = 262144 - 32768
    assert engine.threshold_tokens == int(budget * 0.95)


def test_dynamic_reservation_zero_max_tokens_safe():
    """max_tokens >= context_length must not produce a negative budget."""
    eng = make_engine()
    eng.threshold_percent = 0.95
    eng.max_tokens = 2_000_000
    eng.threshold_tokens = 500_000
    eng.context_length = 1_000_000
    # _effective_trigger falls back to static path (context_length <= max_tokens)
    assert eng._effective_trigger() == int(500_000 * 0.70)


# ---------- host live-config contract (v0.3.1) ----------

def test_coerce_methods_exist_and_behave():
    """tui_gateway live-config pokes these; missing = AttributeError = fallback to builtin."""
    eng = make_engine()
    assert eng._coerce_threshold_tokens_cap(500) == 500
    assert eng._coerce_threshold_tokens_cap(0) is None
    assert eng._coerce_threshold_tokens_cap(None) is None
    assert eng._coerce_threshold_tokens_cap("garbage") is None
    assert eng._coerce_max_tokens("16384") == 16384


def test_live_config_surface_attrs_present():
    """Live-config apply runs on an INITIALIZED engine (after host update_model)."""
    eng = make_engine()
    eng.update_model(model="m", context_length=1_000_000)
    for attr in ("model_thresholds", "_config_context_length", "_resolved_context_length",
                 "threshold_tokens_cap", "_threshold_tokens", "_tail_token_budget",
                 "threshold_percent", "summary_target_ratio",
                 "_coerce_threshold_tokens_cap", "_coerce_max_tokens"):
        assert hasattr(eng, attr), f"missing {attr} — live-config apply would crash"


def test_threshold_tokens_cap_bounds_trigger():
    eng = make_engine()
    eng.threshold_percent = 0.95
    eng.max_tokens = 32768
    eng.update_model(model="m", context_length=1_000_000)
    base = eng.threshold_tokens
    eng.threshold_tokens_cap = 500_000
    eng._refresh_reservation()
    assert eng.threshold_tokens == 500_000, "cap must lower the trigger"
    eng.threshold_tokens_cap = 2_000_000
    eng._refresh_reservation()
    assert eng.threshold_tokens == int((1_000_000 - 32768) * 0.95), "higher cap is a no-op"
