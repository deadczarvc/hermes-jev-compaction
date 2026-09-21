"""Session policy snapshots must survive live changes without rewriting history."""
from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import sys
from types import ModuleType
from typing import Any

import pytest


@pytest.fixture
def plugin(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path) -> ModuleType:
    """Load the real package; isolate config and make unexpected HTTP a hard failure."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("jev_session_settings_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    def no_http(*args: Any, **kwargs: Any) -> None:
        pytest.fail("session settings tests must not perform HTTP")

    monkeypatch.setattr(module, "_http_post_json", no_http)
    return module


def configured(plugin: ModuleType) -> Any:
    engine = plugin.JevEngine()
    engine.model = "jev-test"
    engine.egress_mode = "off"
    engine.threshold_percent = 0.95
    engine.threshold_tokens_cap = 500_000
    engine.protect_first_n = 4
    engine.protect_last_n = 50
    engine.model_thresholds = {"host-a": 0.91}
    engine.max_tokens = 32768
    engine.keep_threshold = 0.3
    engine.max_state_tokens = 12000
    engine.max_request_tokens = 15000
    engine.tail_mode = "lean"
    engine.summary_target_ratio = 0.4
    return engine


def test_session_clone_keeps_policy_but_not_session_state(plugin: ModuleType) -> None:
    parent = configured(plugin)
    parent.api_key = "k"
    parent._messages_ref = [{"role": "user", "content": "private history"}]
    parent.last_stats = {"calls": 10}
    parent._last_failure_monotonic = 123.0
    parent.last_prompt_tokens = 1000
    parent.compression_count = 2
    clone = copy.deepcopy(parent)
    for name in (
        "model", "egress_mode", "threshold_percent", "threshold_tokens_cap",
        "protect_first_n", "protect_last_n", "model_thresholds", "max_tokens",
        "keep_threshold", "max_state_tokens", "max_request_tokens", "tail_mode",
        "summary_target_ratio",
    ):
        assert getattr(clone, name) == getattr(parent, name), name
    assert clone.model_thresholds is not parent.model_thresholds
    clone.model_thresholds["host-a"] = 0.2
    assert parent.model_thresholds["host-a"] == 0.91
    assert clone.api_key == ""
    assert clone._messages_ref == []
    assert clone.last_stats == {}
    assert clone._last_failure_monotonic == 0
    assert clone.last_prompt_tokens == clone.compression_count == 0


def test_session_snapshot_is_detached_from_live_settings(plugin: ModuleType) -> None:
    engine = configured(plugin)
    engine.on_session_start("session-a")
    historical = engine.get_status()
    assert "session_settings" in historical
    original = copy.deepcopy(historical)
    engine.threshold_percent = 0.4
    engine.protect_last_n = 2
    engine.egress_mode = "full_text"
    engine.model_thresholds["host-a"] = 0.2
    engine.on_session_start("session-a", boundary_reason="compression")
    assert historical == original
    assert engine.get_status()["session_settings"] == original["session_settings"]
    exposed = engine.get_status()["session_settings"]
    exposed["model_thresholds"]["host-a"] = 0.1
    assert engine.get_status()["session_settings"]["model_thresholds"]["host-a"] == 0.91
    assert engine.egress_mode == "full_text", "snapshot must not freeze live policy"


def test_session_creation_snapshot_does_not_follow_another_session(plugin: ModuleType) -> None:
    first = configured(plugin)
    first.on_session_start("first")
    historical = first.get_status()
    first.egress_mode = "full_text"
    second = copy.deepcopy(first)
    second.on_session_start("second")
    assert "session_settings" in historical
    assert historical["session_settings"]["egress_mode"] == "off"
    assert second.get_status()["session_settings"]["egress_mode"] == "full_text"
    assert first.get_status()["session_settings"]["egress_mode"] == "off"


def test_status_records_and_transcript_do_not_alias_live_state(plugin: ModuleType) -> None:
    engine = configured(plugin)
    engine.on_session_start("session-a")
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "history"}]
    transcript_before = copy.deepcopy(messages)
    engine.compress(messages)
    record = engine.get_status()
    recorded_json = json.dumps(record, sort_keys=True)
    engine.last_stats["calls"] = 99
    engine.model_thresholds["host-a"] = 0.1
    engine.protect_last_n = 1
    assert json.dumps(record, sort_keys=True) == recorded_json
    assert messages == transcript_before
    record["last_stats"]["calls"] = -1
    assert engine.last_stats["calls"] == 99


def test_reset_creates_new_snapshot_without_changing_old_record(plugin: ModuleType) -> None:
    engine = configured(plugin)
    engine.on_session_start("first")
    old = engine.get_status()
    engine.egress_mode = "full_text"
    engine.on_session_reset()
    engine.on_session_start("second")
    assert "session_settings" in old
    assert old["session_settings"]["egress_mode"] == "off"
    assert engine.get_status()["session_settings"]["egress_mode"] == "full_text"


def test_snapshot_excludes_credentials_and_endpoint(plugin: ModuleType) -> None:
    engine = configured(plugin)
    engine.api_key = "k"
    engine.base_url = "https://example.invalid/?credential=synthetic-endpoint-marker"
    engine.on_session_start("session-a")
    status = engine.get_status()
    assert "session_settings" in status
    text = json.dumps(status["session_settings"])
    assert "api_key" not in status["session_settings"]
    assert "synthetic-endpoint-marker" not in text
