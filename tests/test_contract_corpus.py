"""Golden corpus: standard cases (9) drive compress() with stubbed Jev.
Adversarial/negative-control cases (5) are tested separately below."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
from typing import Any

import pytest

CORPUS = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "contract-corpus.json")
    .read_text(encoding="utf-8"))

STANDARD = [c for c in CORPUS if isinstance(c.get("input"), list) and "decisions" in c and c["id"] != "unpaired_result"]


@pytest.fixture
def plugin(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("jev_corpus_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def _fake_asker(plugin, monkeypatch, decisions: dict[str, str]):
    def fake_post(url, body, headers, timeout):
        payload = json.loads(body.decode())
        answers = {}
        for key in payload["questions"]:
            call_id = key.split("_", 1)[1]
            action = decisions.get(call_id, "keep")
            if key.startswith("call_"):
                noul = 1.0 if action in ("keep", "drop_result") else 0.0
            else:
                noul = 1.0 if action == "keep" else 0.0
            answers[key] = {"noul": noul}
        return {"answers": answers}
    monkeypatch.setattr(plugin, "_http_post_json", fake_post)


@pytest.mark.parametrize("case", STANDARD, ids=lambda c: c["id"])
def test_corpus_invariants(plugin, monkeypatch, case: dict[str, Any]):
    _fake_asker(plugin, monkeypatch, case["decisions"])
    eng = plugin.JevEngine()
    eng.egress_mode = "metadata"
    eng.protect_last_n = 0
    eng.protect_first_n = 0
    eng.api_key = "corpus"

    original = case["input"]
    out = eng.compress([dict(m) for m in original])

    for inv in case["expected_invariants"]:
        if inv == "I01_same_length":
            assert len(out) == len(original), f"{case['id']}: length changed"
        elif inv == "I02_valid_pairs":
            call_ids = set()
            result_ids = set()
            for m in out:
                for tc in m.get("tool_calls") or []:
                    call_ids.add(tc["id"])
                if m.get("role") == "tool" and m.get("tool_call_id"):
                    result_ids.add(m["tool_call_id"])
            assert result_ids <= call_ids, f"{case['id']}: orphan tool results"
        elif inv == "I04_system_unchanged":
            assert out[0]["role"] == "system" and out[0]["content"] == original[0]["content"], (
                f"{case['id']}: system message altered"
            )
        elif inv == "I07_receipt_kept":
            for orig_msg, out_msg in zip(original, out, strict=False):
                if orig_msg.get("role") == "tool" and orig_msg.get("tool_call_id") in case["decisions"]:
                    if case["decisions"][orig_msg["tool_call_id"]] in ("keep", "drop_result"):
                        orig_text = orig_msg["content"] if isinstance(orig_msg["content"], str) else ""
                        out_text = out_msg["content"] if isinstance(out_msg["content"], str) else ""
                        for marker in ("Message-ID", "Status:", "confirm", "sent", "delivered"):
                            if marker.lower() in orig_text.lower():
                                assert marker.lower() in out_text.lower(), (
                                    f"{case['id']}: receipt marker '{marker}' lost"
                                )


def test_unpaired_result_preserved(plugin, monkeypatch):
    """Unpaired tool result (no matching call) must survive unchanged."""
    case = next(c for c in CORPUS if c["id"] == "unpaired_result")
    _fake_asker(plugin, monkeypatch, case["decisions"])
    eng = plugin.JevEngine()
    eng.egress_mode = "metadata"
    eng.protect_last_n = 0
    eng.protect_first_n = 0
    eng.api_key = "corpus"
    out = eng.compress([dict(m) for m in case["input"]])
    assert len(out) == len(case["input"]), "unpaired_result: length changed"
    ghost = next(m for m in out if m.get("tool_call_id") == "ghost")
    assert ghost is not None, "unpaired tool result lost"


def test_receipt_fallback_on_jev_failure(plugin, monkeypatch):
    """When Jev fails, _fallback_prune preserves receipt tail (not head-only)."""
    case = next(c for c in CORPUS if c["id"] == "receipt_fallback")

    def failing_post(url, body, headers, timeout):
        raise ConnectionError("simulated Jev failure")

    monkeypatch.setattr(plugin, "_http_post_json", failing_post)
    eng = plugin.JevEngine()
    eng.egress_mode = "metadata"
    eng.protect_last_n = 0
    eng.api_key = "corpus"
    original = case["input"]
    out = eng.compress([dict(m) for m in original])
    assert len(out) == len(original), "fallback changed message count"
    for orig_msg, out_msg in zip(original, out, strict=False):
        if orig_msg.get("role") == "tool":
            orig_text = orig_msg["content"] if isinstance(orig_msg["content"], str) else ""
            out_text = out_msg["content"] if isinstance(out_msg["content"], str) else ""
            if "Status:" in orig_text:
                assert "Status:" in out_text, "receipt tail lost in fallback"


@pytest.mark.parametrize("junk", [None, 42, "not a list"], ids=["none", "int", "str"])
def test_junk_input_returns_unchanged(plugin, monkeypatch, junk):
    """T6 negative control: junk input must be returned unchanged, not crash."""
    eng = plugin.JevEngine()
    eng.egress_mode = "metadata"
    eng.api_key = "corpus"
    result = eng.compress(junk)
    assert result is junk or result == junk
