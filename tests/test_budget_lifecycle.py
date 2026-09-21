"""Budget/lifecycle: cap without max_tokens, refresh on update_model,
protect_first_n, honest target_ratio removal."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

import pytest


@pytest.fixture
def plugin(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("jev_budget_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def test_cap_applies_without_max_tokens(plugin):
    """threshold_tokens_cap must clamp even when max_tokens is None (Task 4a)."""
    eng = plugin.JevEngine()
    eng.threshold_tokens_cap = 100_000
    eng.threshold_tokens = 500_000
    eng.max_tokens = None
    trigger = eng._effective_trigger()
    assert trigger <= 100_000, (
        f"cap not applied without max_tokens: trigger={trigger}"
    )


def test_max_tokens_refresh_on_update_model(plugin):
    """update_model must recompute the trigger when max_tokens changes (Task 4b)."""
    eng = plugin.JevEngine()
    eng.max_tokens = 8192
    eng.context_length = 500_000
    eng.threshold_percent = 0.95
    old_trigger = eng._effective_trigger()
    eng.update_model("test-model", 1_000_000)
    new_trigger = eng._effective_trigger()
    assert new_trigger > old_trigger, (
        f"trigger not refreshed after update_model: old={old_trigger}, new={new_trigger}"
    )


def test_protect_first_n_pins_early_messages(plugin, monkeypatch):
    """protect_first_n must pin the first N messages alongside protect_last_n (Task 4c)."""
    sent: list[bytes] = []

    def fake_post(url, body, headers, timeout):
        payload = json.loads(body.decode())
        sent.append(body)
        return {"answers": {k: {"noul": 0.0} for k in payload["questions"]}}

    monkeypatch.setattr(plugin, "_http_post_json", fake_post)
    eng = plugin.JevEngine()
    eng.egress_mode = "metadata"
    eng.protect_first_n = 2
    eng.protect_last_n = 1
    eng.api_key = "k"

    messages = [
        {"role": "system", "content": "system prompt"},
        {"role": "user", "content": "first instruction"},
        {"role": "user", "content": "mid context"},
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "c1", "type": "function",
            "function": {"name": "read", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "result"},
        {"role": "user", "content": "last"},
    ]
    out = eng.compress(messages)
    # First 2 messages must survive unchanged (pinned by protect_first_n)
    assert out[0]["content"] == "system prompt"
    assert out[1]["content"] == "first instruction"


def test_target_ratio_removed(plugin):
    """summary_target_ratio must not exist on the engine (Task 4d: honest removal)."""
    eng = plugin.JevEngine()
    assert not hasattr(eng, "summary_target_ratio"), (
        "summary_target_ratio still exists; it was never enforced — remove it"
    )
    status = eng.get_status()
    assert "summary_target_ratio" not in json.dumps(status), (
        "summary_target_ratio leaked into status"
    )
