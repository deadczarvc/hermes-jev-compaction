"""Session-local settings for the Hermes Jev engine.

Hermes deep-copies its registered engine before binding a session. Copy policy,
not conversation state or a resolved credential. The creation snapshot is stored
as immutable JSON text; status readers receive detached dictionaries. Live policy
may change, but neither the creation snapshot nor previously returned records do.
"""
from __future__ import annotations

import copy
import json
import time
from typing import Any, Self, cast

from agent.context_engine import ContextEngine

SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone"
DEFAULT_MODEL = "jev-1.13.0"
FAILURE_BACKOFF_S = 300

# Explicit policy boundary: never clone __dict__ (it can hold messages or keys).
_POLICY_FIELDS = (
    "model", "base_url", "keep_threshold", "max_state_tokens", "max_request_tokens",
    "max_tokens", "egress_mode", "model_thresholds", "threshold_percent",
    "threshold_tokens_cap", "protect_first_n", "protect_last_n", "tail_mode",
    "emit_automatic_compaction_status",
    "_config_threshold_percent", "_configured_threshold_percent", "_config_context_length",
)


class EngineSettings(ContextEngine):
    """Policy/lifecycle portion of JevEngine; compaction remains in the plugin."""

    def __init__(self) -> None:
        self.api_key = ""
        self.model = DEFAULT_MODEL
        self.base_url = SYSTEM_ONE_URL
        self.keep_threshold = 0.5
        self.max_state_tokens = 25_000
        self.max_request_tokens = 30_000
        self.max_tokens: int | None = None
        self.egress_mode = "metadata"
        self.model_thresholds: dict[str, float] = {}
        self.threshold_tokens_cap: int | None = None
        self.tail_mode = "ratio"
        self._configured_threshold_percent: float | None = None
        self._config_context_length: int | None = None
        self._resolved_context_length: int | None = None
        self._threshold_tokens: int | None = None
        self._tail_token_budget: int | None = None
        self._last_failure_monotonic = 0.0
        self._messages_ref: list[dict[str, Any]] = []
        self.last_stats: dict[str, Any] = {}
        self._session_settings_json: str | None = None
        self._snapshot_session_id: str | None = None

    def __deepcopy__(self, memo: dict[int, Any]) -> Self:
        """Copy policy for a new session, with fresh runtime state and key lookup."""
        clone = type(self)()
        memo[id(self)] = clone
        for field in _POLICY_FIELDS:
            if hasattr(self, field):
                setattr(clone, field, copy.deepcopy(getattr(self, field), memo))
        return clone

    def on_session_start(self, session_id: str, **kwargs: Any) -> None:
        """Capture policy once; compression notifications must not rewrite it.

        The host calls this after update_model. An unrelated session or /reset
        captures a new snapshot. Endpoints are omitted because custom URLs can
        contain credentials; the API key and message content are never recorded.
        """
        if self._session_settings_json is not None and (
            kwargs.get("boundary_reason") == "compression" or session_id == self._snapshot_session_id
        ):
            return
        settings = {
            field: getattr(self, field)
            for field in _POLICY_FIELDS
            if not field.startswith("_") and field != "base_url"
        }
        settings.update(context_length=self.context_length, threshold_tokens=self.threshold_tokens)
        self._session_settings_json = json.dumps(settings, sort_keys=True, allow_nan=False)
        self._snapshot_session_id = session_id

    def on_session_reset(self) -> None:
        """Reset per-session records, without altering records held by callers."""
        super().on_session_reset()
        self._session_settings_json = None
        self._snapshot_session_id = None
        self._messages_ref = []
        self.last_stats = {}
        self._last_failure_monotonic = 0.0

    def get_status(self) -> dict[str, Any]:
        """Return a detached record, including immutable creation-time settings."""
        last_prompt = max(self.last_prompt_tokens, 0)
        dropped = getattr(self, "_dropped_receipts", [])[-20:]
        return {
            "last_prompt_tokens": last_prompt,
            "threshold_tokens": self.threshold_tokens,
            "context_length": self.context_length,
            "usage_percent": min(100, last_prompt / self.context_length * 100) if self.context_length else 0,
            "compression_count": self.compression_count,
            "model": self.model,
            "cooling": self._cooling(),
            "last_stats": copy.deepcopy(self.last_stats),
            "session_settings": json.loads(self._session_settings_json) if self._session_settings_json is not None else None,
            "dropped_recent": copy.deepcopy(dropped),
        }

    def _cooling(self) -> bool:
        return (time.monotonic() - self._last_failure_monotonic) < FAILURE_BACKOFF_S

    @staticmethod
    def _coerce_threshold_tokens_cap(value: object) -> int | None:
        """Host live-config surface: positive cap, or None for no cap."""
        try:
            ivalue = int(cast(Any, value)) if value is not None else 0
        except (TypeError, ValueError):
            return None
        return ivalue if ivalue > 0 else None

    @staticmethod
    def _coerce_max_tokens(value: object) -> int | None:
        try:
            ivalue = int(cast(Any, value)) if value is not None else 0
        except (TypeError, ValueError):
            return None
        return ivalue if ivalue > 0 else None

    def update_model(
        self, model: str, context_length: int, base_url: str = "", api_key: str = "",
        provider: str = "", api_mode: str = "",
    ) -> None:
        """Update active model budget without replacing the creation snapshot."""
        super().update_model(model, context_length, base_url=base_url, api_key=api_key,
                             provider=provider, api_mode=api_mode)
        self._refresh_reservation()

    def _refresh_reservation(self) -> None:
        """Existing reservation policy; changing it is outside the snapshot fix."""
        if self.max_tokens is None:
            try:
                from hermes_cli.config import load_config_readonly
                cfg = load_config_readonly() or {}
                mt = (cfg.get("agent") or {}).get("max_tokens")
                self.max_tokens = int(mt) if mt else None
            except Exception:  # noqa: BLE001, S110 — preserve existing fallback during extraction
                pass
        if self.max_tokens and self.context_length > self.max_tokens:
            budget = self.context_length - self.max_tokens
            self.threshold_tokens = int(budget * self.threshold_percent)
        if self.threshold_tokens_cap:
            self.threshold_tokens = min(self.threshold_tokens, self.threshold_tokens_cap)
