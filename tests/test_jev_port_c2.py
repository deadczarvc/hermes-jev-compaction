"""JEV-PORT-C2 regressions: plugin parity for fork features F1-F5.

F1 retries (compact.ts askJobWithRetry): 429/5xx/network retried with capped
backoff honoring Retry-After; 4xx terminal.
F2 contract + round deadline (readBatchAnswers / runRoundJobs): envelope and
answer violations fatal, one deadline for the whole round.
F3 partial answers ('unscored'): a batch lost to deadline/retries keeps its
pairs verbatim; rollback degrades to the deterministic fallback.
F4 known-value masking (messages.ts:23): the API key never survives into a
text-mode payload.
F5 checkBaseUrl (request.ts): https anywhere, http loopback-only, no userinfo.
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import time
import urllib.error

import pytest


@pytest.fixture
def plugin(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("jev_port_c2_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def transcript(n_calls: int = 2) -> list[dict]:
    msgs = [{"role": "system", "content": "sys"}]
    for i in range(n_calls):
        msgs.append({"role": "assistant", "content": None,
                     "tool_calls": [{"id": f"c{i}", "type": "function",
                                     "function": {"name": "read",
                                                  "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": "data"})
    msgs.append({"role": "user", "content": "tail"})
    return msgs


def make_engine(plugin, **kw):
    eng = plugin.JevEngine()
    eng.threshold_tokens = 0
    eng.protect_last_n = kw.get("protect_last_n", 0)
    eng.keep_threshold = kw.get("keep_threshold", 0.5)
    eng.api_key = kw.get("api_key", "k")
    eng._round_deadline = time.monotonic() + kw.get("deadline", 30.0)
    return eng


def _answers_for(payload, value: float = 1.0) -> dict:
    return {"answers": {k: {"noul": value} for k in payload["questions"]}}


def _http_error(code: int, retry_after: str | None = None) -> urllib.error.HTTPError:
    hdrs = {"Retry-After": retry_after} if retry_after else {}
    return urllib.error.HTTPError("http://x", code, "e", hdrs, None)


# ---------- F1: retry 429/5xx/network, Retry-After, capped backoff ----------

def test_f1_retry_on_429_then_success(plugin, monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(plugin.time, "sleep", sleeps.append)
    attempts = []

    def post(url, body, headers, timeout):
        attempts.append(1)
        if len(attempts) < 2:
            raise _http_error(429, "1.5")
        return _answers_for(json.loads(body.decode()))

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    out = eng.compress(transcript())
    assert len(attempts) == 2, "429 must be retried"
    assert out[2]["content"] == "data", "retry recovers, message unchanged"
    assert sleeps and sleeps[0] == 1.5, "Retry-After honored as the first backoff"
    assert eng.last_stats.get("mode") == "jev"


def test_f1_retry_5xx_exhaustion_returns_unscored(plugin, monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(plugin.time, "sleep", sleeps.append)
    attempts = []

    def post(url, body, headers, timeout):
        attempts.append(1)
        raise _http_error(503)

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    out = eng.compress(transcript(n_calls=2))
    assert len(attempts) == plugin.JEV_MAX_ATTEMPTS, "exhausts the attempt budget"
    assert len(sleeps) == plugin.JEV_MAX_ATTEMPTS - 1, "backoff between attempts"
    assert [round(s) for s in sleeps] == [1, 2], "capped exponential backoff"
    assert out[2]["content"] == "data", "unscored pairs stay verbatim (F3)"
    assert "unscored" not in eng.last_stats, "a fallback round leaves no unscored bookkeeping"
    assert eng.last_stats["mode"] == "fallback"


def test_f1_http_403_is_terminal_not_retried(plugin, monkeypatch):
    attempts = []

    def post(url, body, headers, timeout):
        attempts.append(1)
        raise _http_error(403)

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    eng.compress(transcript())
    assert len(attempts) == 1, "a 4xx contract status is terminal at once"
    assert eng.last_stats["mode"] == "fallback"


def test_f1_network_error_retried_then_unscored(plugin, monkeypatch):
    monkeypatch.setattr(plugin.time, "sleep", lambda s: None)
    attempts = []

    def post(url, body, headers, timeout):
        attempts.append(1)
        raise ConnectionError("reset")

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    out = eng.compress(transcript())
    assert len(attempts) == plugin.JEV_MAX_ATTEMPTS
    assert out[2]["content"] == "data"


def test_f1_retry_delay_cap(plugin):
    assert plugin._retry_delay(1) == 1.0
    assert plugin._retry_delay(2) == 2.0
    assert plugin._retry_delay(10) == plugin.JEV_RETRY_MAX_DELAY_S
    assert plugin._retry_delay(1, retry_after=7.5) == 7.5
    # fork jevRetryDelay: the exponent is capped, the server hint is NOT — a hint above
    # the cap comes back as-is and the caller gives the job up instead of sleeping
    assert plugin._retry_delay(3, retry_after=999.0) == 999.0


def test_f1_retry_after_header_parsing(plugin):
    assert plugin._retry_after_from(_http_error(429, "3")) == 3.0
    assert plugin._retry_after_from(_http_error(429)) == 0.0
    assert plugin._retry_after_from(_http_error(429, "soon")) == 0.0
    assert plugin._retry_after_from(ConnectionError()) == 0.0


# ---------- F2: contract taxonomy + one round deadline ----------

def test_f2_envelope_violation_is_fatal(plugin, monkeypatch):
    def post(url, body, headers, timeout):
        return {"unexpected": True}

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    out = eng.compress(transcript())
    assert eng.last_stats["mode"] == "fallback"
    assert out[2]["content"] == "data"


def test_f2_invalid_answer_value_is_contract_error(plugin, monkeypatch):
    def post(url, body, headers, timeout):
        payload = json.loads(body.decode())
        return {"answers": {k: {"noul": 1.0 if k.startswith("call_") else "high"}
                            for k in payload["questions"]}}

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    eng.compress(transcript())
    assert eng.last_stats["mode"] == "fallback"


def test_f2_answer_out_of_range_rejected(plugin):
    eng = make_engine(plugin)
    parsed = {"answers": {"call_c0": {"noul": 1.5}, "result_c0": {"noul": 0.5}}}
    with pytest.raises(plugin.JevContractError) as err:
        eng._answer_pairs(parsed, [{"id": "c0"}])
    assert err.value.kind == "answer"


def test_f2_missing_half_is_unscored_only_with_partial_success(plugin):
    """Fork readBatchAnswers: with ANY complete pair in the batch a missing half is
    unscored; with zero complete pairs the batch contract fails (no_complete_pair)."""
    eng = make_engine(plugin)
    parsed = {"answers": {
        "call_c0": {"noul": 0.4}, "result_c0": {"noul": 0.6},
        "call_c1": {"noul": 0.4},  # result_c1 missing
    }}
    pairs, missing = eng._answer_pairs(parsed, [{"id": "c0"}, {"id": "c1"}])
    assert pairs[0] == {"keepCall": 0.4, "keepResult": 0.6}
    assert pairs[1] is None and missing == ["c1"]


def test_f2_no_complete_pair_in_batch_is_fatal(plugin):
    eng = make_engine(plugin)
    parsed = {"answers": {"other": {"noul": 0.5}}}
    with pytest.raises(plugin.JevContractError) as err:
        eng._answer_pairs(parsed, [{"id": "c0"}])
    assert err.value.kind == "no_complete_pair"


def test_f2_round_deadline_stops_late_batch(plugin, monkeypatch):
    monkeypatch.setattr(plugin.time, "sleep", lambda s: None)
    attempts = []

    def post(url, body, headers, timeout):
        attempts.append(1)
        raise _http_error(503)

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    eng.compaction_timeout_s = 0.0  # the whole round budget is already spent
    out = eng.compress(transcript())
    assert attempts == [], "no HTTP after the shared deadline passed"
    assert out[2]["content"] == "data"


def test_f2_partial_round_is_not_fallback(plugin, monkeypatch):
    """One batch unscored, one scored: mode stays 'jev', scored calls decide."""
    monkeypatch.setattr(plugin.time, "sleep", lambda s: None)

    def post(url, body, headers, timeout):
        payload = json.loads(body.decode())
        # The first batch (candidates are id'ed tN; it asks about t1) fails EVERY
        # attempt; the other batches answer — a deterministic partial round regardless
        # of worker interleaving.
        if "call_t1" in payload["questions"]:
            raise _http_error(500)
        return _answers_for(payload, 0.0)

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin, protect_last_n=0)
    # State fits (2425 tokens) but not in one budget with all questions: the 40
    # candidates split into 2+ batches (3555 budget / ~120 per question).
    eng.max_state_tokens = 3000
    eng.max_request_tokens = 6000
    big = transcript(n_calls=40)
    out = eng.compress(big)
    assert eng.last_stats["mode"] == "jev", "partial round is committed, not fallback"
    assert eng.last_stats["unscored"] > 0
    assert eng.last_stats["candidates"] - eng.last_stats["unscored"] > 0
    assert len(out) == len(big), "rows preserved under partial scoring"


# ---------- F3: retain-unscored default, rollback opt-in ----------

def test_f3_retain_unscored_default_keeps_pairs(plugin, monkeypatch):
    monkeypatch.setattr(plugin.time, "sleep", lambda s: None)

    def post(url, body, headers, timeout):
        raise ConnectionError("down")

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    msgs = transcript(n_calls=2)
    out = eng.compress(msgs)
    assert eng.partial_answers == "retain-unscored"
    assert out == msgs, "unscored pairs are kept exactly as they were"
    assert "jev-compaction omitted" not in out[2]["content"]


def test_f3_rollback_degrades_to_fallback(plugin, monkeypatch):
    monkeypatch.setattr(plugin.time, "sleep", lambda s: None)

    def post(url, body, headers, timeout):
        raise ConnectionError("down")

    monkeypatch.setattr(plugin, "_http_post_json", post)
    eng = make_engine(plugin)
    eng.partial_answers = "rollback"
    msgs = transcript(n_calls=2)
    for m in msgs:
        if m.get("role") == "tool":
            m["content"] = "row " + "z" * 3000  # long enough for the rails to cut
    out = eng.compress(msgs)
    assert eng.last_stats["mode"] == "fallback"
    # The deterministic fallback reduces the (reproducible) reads to re-run notes
    assert any("jev-compaction omitted" in m["content"]
               for m in out if m.get("role") == "tool")


def test_f3_new_policy_fields_survive_clone(plugin):
    import copy

    eng = make_engine(plugin)
    clone = copy.deepcopy(eng)
    assert clone.compaction_timeout_s == eng.compaction_timeout_s
    assert clone.partial_answers == eng.partial_answers


# ---------- F4: the API key never rides into a text-mode payload ----------

def test_f4_key_masked_in_redacted_text_payload(plugin, monkeypatch):
    from agent import redact

    monkeypatch.setattr(redact, "redact_sensitive_text",
                        lambda text, **kw: text)
    sent: list[bytes] = []

    def post(url, body, headers, timeout):
        sent.append(body)
        return _answers_for(json.loads(body.decode()))

    monkeypatch.setattr(plugin, "_http_post_json", post)
    marker = "synthetic-" + "x" * 24  # fake credential shape, no real value
    eng = make_engine(plugin, api_key=marker)
    eng.egress_mode = "redacted_text"
    msgs = transcript()
    msgs[1] = dict(msgs[1], content=f"please use {marker} now")
    eng.compress(msgs)
    wire = sent[0]
    assert marker.encode() not in wire
    assert b"[REDACTED:known]" in wire


def test_f4_key_masked_in_full_text_payload(plugin, monkeypatch):
    sent: list[bytes] = []

    def post(url, body, headers, timeout):
        sent.append(body)
        return _answers_for(json.loads(body.decode()))

    monkeypatch.setattr(plugin, "_http_post_json", post)
    marker = "synthetic-" + "y" * 24  # fake credential shape, no real value
    eng = make_engine(plugin, api_key=marker)
    eng.egress_mode = "full_text"
    msgs = transcript()
    msgs[1] = dict(msgs[1], content=f"the key is {marker} ok")
    eng.compress(msgs)
    assert marker.encode() not in sent[0]
    assert b"[REDACTED:known]" in sent[0]


# ---------- F5: checkBaseUrl hardening ----------

def test_f5_https_and_loopback_allowed(plugin):
    for url in (
        "https://api.typesafe.ai/v1/systemone",
        "http://127.0.0.1:8080/v1",
        "http://localhost:9000/v1",
        "http://[::1]:9000/v1",
    ):
        plugin._validate_base_url(url)  # must not raise


@pytest.mark.parametrize("url", [
    "http://api.typesafe.ai/v1/systemone",      # plain http off loopback
    "https://user:pass@api.typesafe.ai/v1",     # userinfo
    "https://evil@example.com/v1",              # @ inside the authority
    "ftp://api.typesafe.ai/v1",                 # scheme
    "api.typesafe.ai/v1",                       # no scheme
    "",
])
def test_f5_bad_base_urls_refused(plugin, url):
    with pytest.raises(ValueError):
        plugin._validate_base_url(url)


def test_f5_http_post_json_refuses_before_io(plugin):
    with pytest.raises(ValueError):
        plugin._http_post_json("http://evil.example.com/x", b"{}", {}, 1.0)


# ---------- F10: empty option string selects the default ----------

def test_f10_empty_string_selects_default(plugin):
    eng = plugin.JevEngine()
    assert eng._coerce_text("", "jev-1.13.0") == "jev-1.13.0"
    assert eng._coerce_text("   ", "jev-1.13.0") == "jev-1.13.0"
    assert eng._coerce_text("custom-model", "jev-1.13.0") == "custom-model"
    assert eng._coerce_text(None, "jev-1.13.0") == "jev-1.13.0"
    assert eng._coerce_text(42, "jev-1.13.0") == "jev-1.13.0"


def test_f10_number_coercion_empty_or_invalid_gives_default(plugin):
    eng = plugin.JevEngine()
    assert eng._coerce_number("", 120.0, float) == 120.0
    assert eng._coerce_number("  ", 120.0, float) == 120.0
    assert eng._coerce_number(None, 120.0, float) == 120.0
    assert eng._coerce_number("abc", 120.0, float) == 120.0
    assert eng._coerce_number("45.5", 120.0, float) == 45.5
