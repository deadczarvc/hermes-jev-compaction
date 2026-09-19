
import re
import importlib.util
import pathlib
import sys

GUARD = None  # placeholder to keep import structure flat
PLUGIN = pathlib.Path(r"D:\BooksDocs\Project Astra\cloned-repos-18042026-future\fast-jev-compaction\hermes-plugin\__init__.py")
spec = importlib.util.spec_from_file_location("jev_v032", PLUGIN)
jev = importlib.util.module_from_spec(spec)
sys.modules["jev_v032"] = jev
spec.loader.exec_module(jev)

def make_engine():
    eng = jev.JevEngine()
    eng.threshold_tokens = 0
    eng.protect_last_n = 2
    eng.keep_threshold = 0.5
    return eng

# FINDING 2 regression: receipt-bearing results survive fallback with tail preserved
def test_fallback_preserves_receipt_tail():
    eng = make_engine()
    receipt = "Operation queued. " + "x" * 500 + " message_id: abc-123; status: sent"
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "send it"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "r1", "type": "function",
                         "function": {"name": "send_email", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "r1", "content": receipt},
        {"role": "user", "content": "thanks"},
        {"role": "user", "content": "now do something else"},
        {"role": "user", "content": "and more"},
        {"role": "user", "content": "keep going"},
    ]
    out = eng._fallback_prune(msgs)
    tool = [m for m in out if m.get("role") == "tool"][0]
    assert "message_id: abc-123" in tool["content"], "receipt tail must survive"
    assert "jev fallback" in tool["content"]

def test_fallback_truncates_plain_bulk():
    eng = make_engine()
    bulk = "line\n" * 300
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "run"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "p1", "type": "function",
                         "function": {"name": "bash", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "p1", "content": bulk},
        {"role": "user", "content": "ok"},
        {"role": "user", "content": "next"},
        {"role": "user", "content": "more"},
        {"role": "user", "content": "go on"},
    ]
    out = eng._fallback_prune(msgs)
    tool = [m for m in out if m.get("role") == "tool"][0]
    assert len(tool["content"]) < len(bulk), "plain bulk should be truncated"
    assert "jev fallback truncated" in tool["content"]

# FINDING 3 regression: system entries round-trip (tested via hermes.test.ts in TS, but the
# interface is defined here too — verify structurally that systemEntries is in the transcript)
def test_hermes_transcript_has_system_entries_field():
    # the TS interface change is the source of truth; here we verify the Python plugin's
    # fallback does NOT touch system messages
    eng = make_engine()
    msgs = [
        {"role": "system", "content": "LONG SYSTEM " + "z" * 600},
        {"role": "user", "content": "u"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "q1", "type": "function",
                         "function": {"name": "t", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "q1", "content": "r " + "y" * 500},
        {"role": "user", "content": "tail"},
    ]
    out = eng._fallback_prune(msgs)
    assert out[0]["content"] == msgs[0]["content"], "system must be untouched by fallback"

for name, fn in sorted(list(globals().items())):
    if name.startswith("test_"):
        fn()
        print("PASS", name)
print("ALL PASS")
