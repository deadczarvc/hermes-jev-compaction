"""Lifecycle telemetry: session_events must record the compress phases."""
from __future__ import annotations

import importlib.util
import pathlib
import sys

import pytest


@pytest.fixture
def plugin(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("jev_telemetry_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def _transcript() -> list[dict]:
    return [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "do it"},
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "c1", "type": "function",
            "function": {"name": "read", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "data"},
        {"role": "user", "content": "ok"},
    ]


def test_successful_compress_event_sequence(plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_http_post_json",
                        lambda *a: {"answers": {"call_t1": {"noul": 1.0}, "result_t1": {"noul": 1.0}}})
    eng = plugin.JevEngine()
    eng.egress_mode = "metadata"
    eng.protect_last_n = 0
    eng.api_key = "k"
    eng.compress(_transcript())
    status = eng.get_status()
    phases = [e["phase"] for e in status["session_events"]]
    assert phases == ["attempt", "committed"], f"got {phases}"


def test_transport_failure_event_sequence(plugin, monkeypatch):
    def fail(*a):
        raise ConnectionError("boom")
    monkeypatch.setattr(plugin, "_http_post_json", fail)
    eng = plugin.JevEngine()
    eng.egress_mode = "metadata"
    eng.protect_last_n = 0
    eng.api_key = "k"
    eng.compress(_transcript())
    status = eng.get_status()
    phases = [e["phase"] for e in status["session_events"]]
    assert phases[-1] == "preserve", f"expected preserve, got {phases}"
