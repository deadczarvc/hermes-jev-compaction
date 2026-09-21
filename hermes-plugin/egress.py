"""Fail-closed projections and redaction for Jev's remote scoring request."""
from __future__ import annotations

import json
from typing import Any


class EgressPolicyError(RuntimeError):
    """Raised before transport when the configured export policy cannot be honored."""


def metadata_input(value: Any) -> dict[str, Any]:
    """Describe arguments without serializing their values into the remote request."""
    try:
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        rendered = ""
    if isinstance(value, dict):
        return {"kind": "object", "keys": sorted(str(key) for key in value), "chars": len(rendered)}
    if isinstance(value, list):
        return {"kind": "array", "items": len(value), "chars": len(rendered)}
    return {"kind": type(value).__name__, "chars": len(rendered)}


def redact_export_value(value: Any) -> Any:
    """Use Hermes' established egress redactor for every string sent to Jev."""
    try:
        from agent.redact import redact_sensitive_text
    except Exception:  # noqa: BLE001 -- unavailable redaction must fail closed
        raise EgressPolicyError("shared redaction unavailable") from None
    if isinstance(value, str):
        try:
            redacted = redact_sensitive_text(value, force=True, redact_url_credentials=True)
        except Exception:  # noqa: BLE001 -- unavailable redaction must fail closed
            raise EgressPolicyError("shared redaction unavailable") from None
        if not isinstance(redacted, str):
            raise EgressPolicyError("shared redaction unavailable")
        return redacted
    if isinstance(value, list):
        return [redact_export_value(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_export_value(item) for key, item in value.items()}
    return value
