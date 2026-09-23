"""History fidelity: receipts deeper than the kept head must survive compaction.

A send_email / place_order / fill_form result often carries a confirmation ID
deep in the body (after a progress preamble). The current _apply truncation
keeps a head-only slice, losing the receipt. These tests force that path.
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
from typing import Any

import pytest


@pytest.fixture
def plugin(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("jev_history_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def _transcript(tool_content: str) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "do it"},
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call-1", "type": "function",
            "function": {"name": "send_email", "arguments": "{\"to\":\"x@y\"}"}}]},
        {"role": "tool", "tool_call_id": "call-1", "content": tool_content},
        {"role": "user", "content": "ok"},
    ]


_DEEP_RECEIPT = "working on it..." + "x" * 500 + "\nMessage-ID: <abc@relay>\nStatus: sent delivered"
_NO_RECEIPT = "working on it..." + "x" * 500 + "\n(done, nothing special)"


def _engine(plugin: Any, mode: str = "metadata") -> Any:
    eng = plugin.JevEngine()
    eng.egress_mode = mode
    eng.protect_last_n = 0
    eng.api_key = "synthetic"
    return eng


def _drop_result_asker(plugin: Any, monkeypatch: pytest.MonkeyPatch) -> list[bytes]:
    sent: list[bytes] = []
    def fake_post(url: str, body: bytes, headers: dict, timeout: float) -> dict:
        payload = json.loads(body.decode())
        sent.append(body)
        return {"answers": {
            k: {"noul": 0.9 if k.startswith("call_") else 0.0}
            for k in payload["questions"]}}
    monkeypatch.setattr(plugin, "_http_post_json", fake_post)
    return sent


def test_deep_receipt_survives_result_drop(plugin, monkeypatch):
    sent = _drop_result_asker(plugin, monkeypatch)
    eng = _engine(plugin)
    out = eng.compress(_transcript(_DEEP_RECEIPT))
    assert len(sent) == 1, "expected exactly one Jev request"
    text = out[3]["content"]
    assert "Message-ID: <abc@relay>" in text, f"receipt lost in head-only truncation: {text[:120]!r}"
    assert "Status: sent delivered" in text, "tail confirmation lost"


def test_no_receipt_still_truncates(plugin, monkeypatch):
    _drop_result_asker(plugin, monkeypatch)
    eng = _engine(plugin)
    out = eng.compress(_transcript(_NO_RECEIPT))
    text = out[3]["content"]
    assert len(text) < len(_NO_RECEIPT), "without receipt markers the result should still be truncated"
    assert "nothing special" not in text, "tail should not be kept when no receipt exists"


def test_dropped_call_recoverable_via_status(plugin, monkeypatch):
    """A drop_call decision must leave a verifiable recovery record in status."""
    sent: list[bytes] = []

    def fake_post(url: str, body: bytes, headers: dict, timeout: float) -> dict:
        payload = json.loads(body.decode())
        sent.append(body)
        # Score everything low => drop_call
        return {"answers": {k: {"noul": 0.0} for k in payload["questions"]}}

    monkeypatch.setattr(plugin, "_http_post_json", fake_post)
    eng = _engine(plugin)
    msgs = _transcript("important result data")
    out = eng.compress(msgs)

    # The tool row was stubbed
    assert "dropped by jev-compaction" in out[3]["content"]
    # But status exposes the full original for recovery
    status = eng.get_status()
    assert status["dropped_recent"], "no recovery record in status"
    rec = status["dropped_recent"][-1]
    assert rec["tool_call_id"] == "call-1"
    assert rec["tool"] == "send_email"
    assert rec["full"] == "important result data"


def test_pre_compress_wraps_non_dict(plugin):
    """Pre-conversion seam wraps non-dict entries to prevent downstream crashes."""
    eng = plugin.JevEngine()
    messages = [{"role": "user", "content": "hi"}, "not a dict", 42]
    result = eng._pre_compress(messages)
    assert len(result) == 3
    assert isinstance(result[0], dict)
    assert isinstance(result[1], dict)
    assert result[1]["role"] == "user"
    assert result[1]["content"] == "not a dict"
    assert isinstance(result[2], dict)
    assert result[2]["role"] == "user"
    assert result[2]["content"] == "42"


def test_pre_compress_non_list_passthrough(plugin):
    """Pre-conversion seam returns non-list input unchanged (fail-open)."""
    eng = plugin.JevEngine()
    assert eng._pre_compress(None) is None
    assert eng._pre_compress("hello") == "hello"
    assert eng._pre_compress(42) == 42
