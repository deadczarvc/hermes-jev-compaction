"""Offline egress regressions for the Jev plugin's explicit export boundary."""
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
    """Load an isolated plugin and make every outbound request observable."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("jev_egress_policy_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def transcript() -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "SYSTEM_SENTINEL"},
        {"role": "user", "content": "USER_SENTINEL"},
        {
            "role": "assistant",
            "content": "ASSISTANT_SENTINEL",
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {
                    "name": "read_file",
                    "arguments": json.dumps({
                        "path": "ARGUMENT_SENTINEL",
                        "nested": {"value": "NESTED_ARGUMENT_SENTINEL"},
                    }),
                },
            }],
        },
        {"role": "tool", "tool_call_id": "call-1", "content": "RESULT_SENTINEL"},
        {"role": "user", "content": "TAIL_SENTINEL"},
    ]


def engine(plugin: ModuleType, mode: str) -> Any:
    value = plugin.JevEngine()
    value.egress_mode = mode
    value.protect_last_n = 0
    value.api_key = "synthetic-test-key"
    return value


def capture_http(plugin: ModuleType, monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    def fake_post(url: str, body: bytes, headers: dict[str, str], timeout: float) -> dict[str, Any]:
        payload = json.loads(body.decode("utf-8"))
        sent.append({"url": url, "body": body, "headers": headers, "timeout": timeout, "payload": payload})
        return {"answers": {key: {"noul": 1.0} for key in payload["questions"]}}

    monkeypatch.setattr(plugin, "_http_post_json", fake_post)
    return sent


def assert_preserved(value: Any, messages: list[dict[str, Any]], original: list[dict[str, Any]]) -> None:
    assert value == messages
    assert messages == original


def test_off_is_a_zero_http_history_preserving_guard(plugin: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    sent = capture_http(plugin, monkeypatch)
    value = engine(plugin, "off")
    messages = transcript()
    original = copy.deepcopy(messages)

    out = value.compress(messages, memory_context="MEMORY_SENTINEL")

    assert_preserved(out, messages, original)
    assert sent == []
    assert value.last_stats["mode"] == "off"


def test_unknown_mode_fails_closed_without_text_export(plugin: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    sent = capture_http(plugin, monkeypatch)
    value = engine(plugin, "typo-mode")
    messages = transcript()
    original = copy.deepcopy(messages)

    out = value.compress(messages, memory_context="MEMORY_SENTINEL")

    assert_preserved(out, messages, original)
    assert sent == []
    assert value.last_stats["mode"] == "preserve"
    assert value.last_stats["error"] == "invalid egress mode"


def test_metadata_serialized_bytes_exclude_all_raw_transcript_surfaces(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent = capture_http(plugin, monkeypatch)
    value = engine(plugin, "metadata")

    out = value.compress(transcript(), memory_context="MEMORY_SENTINEL")

    assert len(sent) == 1
    assert out[0]["content"] == "SYSTEM_SENTINEL"
    wire = sent[0]["body"]
    for marker in (
        b"SYSTEM_SENTINEL", b"USER_SENTINEL", b"ASSISTANT_SENTINEL", b"RESULT_SENTINEL",
        b"ARGUMENT_SENTINEL", b"NESTED_ARGUMENT_SENTINEL", b"MEMORY_SENTINEL", b"TAIL_SENTINEL",
    ):
        assert marker not in wire
    state = sent[0]["payload"]["state"]
    assert state["goal"] == ""
    assert "MEMORY_SENTINEL" not in json.dumps(state)
    tool_call = next(entry["tool_calls"][0] for entry in state["history"] if entry.get("tool_calls"))
    assert tool_call["tool"] == "read_file"
    assert "ARGUMENT_SENTINEL" not in json.dumps(tool_call)


def test_redacted_text_redacts_every_exported_text_surface_or_sends_nothing(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent import redact

    sent = capture_http(plugin, monkeypatch)
    seen: list[str] = []

    def redact_for_test(text: str, **kwargs: Any) -> str:
        assert kwargs["force"] is True
        assert kwargs["redact_url_credentials"] is True
        seen.append(text)
        return text.replace("SENTINEL", "REDACTED")

    monkeypatch.setattr(redact, "redact_sensitive_text", redact_for_test)
    value = engine(plugin, "redacted_text")

    value.compress(transcript(), memory_context="MEMORY_SENTINEL")

    assert len(sent) == 1
    wire = sent[0]["body"]
    for marker in (
        b"SYSTEM_SENTINEL", b"USER_SENTINEL", b"ASSISTANT_SENTINEL", b"ARGUMENT_SENTINEL",
        b"NESTED_ARGUMENT_SENTINEL", b"MEMORY_SENTINEL", b"TAIL_SENTINEL",
    ):
        assert marker not in wire
    assert b"RESULT_SENTINEL" not in wire, "tool results are never exported in text modes"
    assert b"REDACTED" in wire
    assert any("ARGUMENT_SENTINEL" in text for text in seen)
    assert any("MEMORY_SENTINEL" in text for text in seen)


def test_redacted_text_aborts_without_http_when_shared_redactor_fails(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent import redact

    sent = capture_http(plugin, monkeypatch)
    monkeypatch.setattr(redact, "redact_sensitive_text", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))
    value = engine(plugin, "redacted_text")
    messages = transcript()
    original = copy.deepcopy(messages)

    out = value.compress(messages, memory_context="MEMORY_SENTINEL")

    assert_preserved(out, messages, original)
    assert sent == []
    assert value.last_stats["mode"] == "preserve"


def test_full_text_is_explicit_and_still_omits_tool_results(plugin: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    sent = capture_http(plugin, monkeypatch)
    value = engine(plugin, "full_text")

    value.compress(transcript(), memory_context="MEMORY_SENTINEL")

    assert len(sent) == 1
    wire = sent[0]["body"]
    assert b"USER_SENTINEL" in wire
    assert b"ARGUMENT_SENTINEL" in wire
    assert b"MEMORY_SENTINEL" in wire
    assert b"RESULT_SENTINEL" not in wire


def test_scoped_secret_error_cannot_fall_back_to_process_env(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent import secret_scope

    sent = capture_http(plugin, monkeypatch)
    monkeypatch.setenv("TYPESAFE_API_KEY", "PROCESS_ENV_FALLBACK_SENTINEL")
    monkeypatch.setattr(secret_scope, "get_secret", lambda name: (_ for _ in ()).throw(secret_scope.UnscopedSecretError(name)))
    value = engine(plugin, "metadata")
    value.api_key = ""
    messages = transcript()
    original = copy.deepcopy(messages)

    out = value.compress(messages)

    assert_preserved(out, messages, original)
    assert sent == []
    assert "PROCESS_ENV_FALLBACK_SENTINEL" not in json.dumps(value.last_stats)


def test_empty_or_whitespace_scoped_key_prohibits_http(plugin: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    from agent import secret_scope

    sent = capture_http(plugin, monkeypatch)
    monkeypatch.setattr(secret_scope, "get_secret", lambda name: "   ")
    value = engine(plugin, "metadata")
    value.api_key = " \t "
    messages = transcript()
    original = copy.deepcopy(messages)

    out = value.compress(messages)

    assert_preserved(out, messages, original)
    assert sent == []
    assert "synthetic-test-key" not in json.dumps(value.last_stats)
