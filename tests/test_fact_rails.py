"""jev-context-engine keeps facts when compacting (port of the fact-keeping fast-jev-compaction fork).

The goal both engines state: drop what re-running the tool gives back, never an exact error, path or
observation. Run: python -B -m pytest tests/test_fact_rails.py -q
"""

import importlib.util
import json
import os
import pathlib
import re
import sys
import time

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "jev_context_engine",
    PLUGIN / "__init__.py",
    submodule_search_locations=[str(PLUGIN)],
)
engine = importlib.util.module_from_spec(spec)
sys.modules["jev_context_engine"] = engine
spec.loader.exec_module(engine)


def test_reproducible_reads_versus_observations_and_side_effects():
    assert engine.reproducible("read_file", {"path": "a.py"})
    assert engine.reproducible(
        "terminal", {"command": "ls F:/Temp 2>&1 | head -40; find F:/Temp -type d"}
    )  # a long listing (ls -la) reports metadata: see the metadata test below
    assert engine.reproducible("terminal", {"command": "git log --oneline | head -5"})
    for tool, args in [
        ("terminal", {"command": "curl -s https://x.org"}),
        ("terminal", {"command": "netstat -ano | grep 3845"}),
        ("terminal", {"command": "ls > out.txt"}),
        ("terminal", {"command": "sed -i 's/a/b/' f"}),
        ("write_file", {"path": "a.py", "content": "x"}),
        ("web_extract", {"urls": ["https://x.org"]}),
    ]:
        assert not engine.reproducible(tool, args), (tool, args)


def test_fact_stub_keeps_deep_fact_lines_head_and_tail():
    middle = (
        "plain filler line without anything\n"
        "GET https://mcp.unframer.co/.well-known/oauth-authorization-server HTTP 404\n"
        "@codex-codegraph | live | node.exe | pid 43748\n"
        "figma-desktop err=Failed to connect to 127.0.0.1:3845"
    )
    text = (
        "h" * 300
        + "\n"
        + "filler\n" * 500  # past SMALL_KEEP_CHARS (6000)
        + middle
        + "\n"
        + "filler\n" * 500
        + "t" * 120
    )
    stub = engine.fact_stub(text, False)
    for fact in ("HTTP 404", "pid 43748", "127.0.0.1:3845"):
        assert fact in stub
    assert "plain filler line" not in stub
    assert stub.endswith("t" * 120) and len(stub) < len(text) / 2
    error = "Traceback\n" + "e" * 1900
    assert engine.fact_stub(error, True) == error


def test_apply_shrinks_reads_keeps_observation_stubs_and_pairing():
    big = (
        "x" * 1000 + "\nGET https://a.example/.well-known/oauth HTTP 404\n" + "x" * 1000
    )
    messages = [
        {"role": "user", "content": "audit"},
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "r1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": json.dumps({"path": "src/a.py"}),
                    },
                },
                {
                    "id": "c1",
                    "type": "function",
                    "function": {
                        "name": "terminal",
                        "arguments": json.dumps(
                            {"command": "curl -s https://a.example/.well-known/oauth"}
                        ),
                    },
                },
            ],
        },
        {"role": "tool", "tool_call_id": "r1", "content": big},
        {"role": "tool", "tool_call_id": "c1", "content": big},
    ]
    calls = [
        {
            "id": "t1",
            "tool_call_id": "r1",
            "tool": "read_file",
            "input": {"path": "src/a.py"},
        },
        {
            "id": "t2",
            "tool_call_id": "c1",
            "tool": "terminal",
            "input": {"command": "curl -s https://a.example/.well-known/oauth"},
        },
    ]
    out = engine.JevEngine._apply(
        engine.JevEngine(), messages, calls, {"t1": "drop_call", "t2": "drop_call"}, 0.5
    )
    assert (
        out[2]["content"].startswith("[jev-compaction omitted")
        and "reproducible read" in out[2]["content"]
    )
    assert "HTTP 404" in out[3]["content"]
    ids = [tc["id"] for tc in out[1]["tool_calls"]]
    assert ids == ["r1", "c1"]  # pairing intact, nothing erased
    assert json.loads(out[1]["tool_calls"][0]["function"]["arguments"]) == {
        "path": "src/a.py"
    }


def _history():
    # past SMALL_KEEP_CHARS (3000): shorter observations are kept whole by the hard rails
    big = (
        "x" * 3500 + "\nGET https://a.example/.well-known/oauth HTTP 404\n" + "x" * 3500
    )
    receipt = (
        "y" * 3500 + "\nmessage_id: 8f3e2a-ticket sent to 3 recipients\n" + "y" * 3500
    )
    calls = [
        ("r1", "read_file", {"path": "src/a.py"}),
        ("c1", "terminal", {"command": "curl -s https://a.example/.well-known/oauth"}),
        ("s1", "send_message", {"to": "team", "text": "x"}),
    ]
    messages = [{"role": "user", "content": "audit"}]
    for cid, name, args in calls:
        messages.append(
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": cid,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)},
                    }
                ],
            }
        )
        messages.append(
            {
                "role": "tool",
                "tool_call_id": cid,
                "content": receipt if cid == "s1" else big,
            }
        )
    messages.append({"role": "user", "content": "go on"})
    return messages


def test_jev_failure_falls_back_to_the_same_fact_rules_not_fail_open():
    e = engine.JevEngine()
    e.protect_last_n = 1
    e.egress_mode = "metadata"

    def down(*_a, **_k):
        raise RuntimeError("TypeSafe unreachable")

    e._fit_state = down
    messages = _history()
    out = e.compress(messages)
    assert e.last_stats["mode"] == "fallback"
    assert len(out) == len(messages)  # nothing erased, pairing kept
    assert "reproducible read" in out[2]["content"]  # read_file shrinks to a line
    assert "HTTP 404" in out[4]["content"] and len(out[4]["content"]) < len(
        messages[4]["content"]
    )
    assert (
        "message_id: 8f3e2a-ticket sent" in out[6]["content"]
    )  # receipt of a non-idempotent call survives
    assert out[-1] == messages[-1]


def test_hard_rails_short_kept_whole_tail_line_intact_pointer_named():
    short = "a" * 1200 + "\ntable vec_episodes no such module: vec0\n" + "b" * 1200
    assert (
        engine.fact_stub(short, False) == short
    )  # under SMALL_KEEP_CHARS (6000): kept whole
    body = "\n".join(f"row {i} ok" for i in range(800))
    stub = engine.fact_stub(body + "\n36220 32.02000\nend", False, "call_X")
    assert "36220 32.02000" in stub  # the line at the tail boundary is not split
    assert "under call_X" in stub and "re-run the tool" not in stub
    dump = "\n".join(
        f"pid {10000 + i} port {3000 + i} status failed" for i in range(300)
    )
    kept = [
        ln for ln in engine.fact_stub(dump, False).split("\n") if ln.startswith("pid ")
    ]
    assert len(kept) > 40  # budget proportional to size, not 360 chars


def test_logs_are_observations_not_reproducible_reads():
    assert not engine.reproducible(
        "terminal", {"command": "tail -c 1500 C:/ops/app/restic.log"}
    )
    assert not engine.reproducible(
        "read_file", {"path": "C:/ops/jev-net/ledger/screen.jsonl"}
    )
    assert not engine.reproducible("terminal", {"command": "tail -f /var/log/syslog"})
    assert engine.reproducible(
        "read_file", {"path": "C:/src/app.py"}
    )  # source files still re-read


def test_rails_dense_table_failed_read_and_tiers():
    table = "\n".join(
        f"F:/Projects/p{i} {3000 + i} {19602045188 + i}" for i in range(300)
    )
    assert (
        engine.fact_stub(table, False, "t", engine.RAIL_TIERS[0]) == table
    )  # dense dump kept whole
    assert (
        engine.fact_stub(table, False, "t", engine.RAIL_TIERS[2]) != table
    )  # a lower tier cuts it (tier 1 only gives up reads)
    failed = "find: '/c/nope': No such file or directory\nCommand did not complete within its 120s timeout"
    assert engine._READ_OBSERVATION.search(
        failed
    )  # a failed read is an observation, not a re-run line
    assert engine.RAIL_FLOOR <= 0.25 and len(engine.RAIL_TIERS) == 4


def test_metadata_reads_are_observations_even_in_compound_commands():
    for command in (
        "cd /x && wc -l pin.mjs && sed -n 1,140p pin.mjs",
        "cat card.xtml; echo; ls -la /x /x/reports 2>&1",
        "stat a.txt",
        "du -sh /x",
    ):
        assert not engine.reproducible("terminal", {"command": command}), command
    assert not engine.reproducible(
        "PowerShell", {"command": "Get-ChildItem C:/x | Select-Object -First 5"}
    )
    assert engine.reproducible("terminal", {"command": "cat a.txt | head -40"})


def test_long_line_is_split_into_pieces_not_truncated():
    sep = "\\n"  # an escaped newline inside a JSON string: the line has no real line break
    filler = sep.join('\\"content\\": \\"note ' + "y" * 120 + '\\"' for _ in range(60))
    line = (
        '{"text": "'
        + filler
        + sep
        + '  \\"id\\": \\"f46101ab4a1ecfd2\\"'
        + sep
        + filler
        + '"}'
    )
    assert "\n" not in line and len(line) > 10_000
    assert any("f46101ab4a1ecfd2" in piece for piece in engine.fact_lines(line, 3000))


def test_dense_table_up_to_32k_kept_whole():
    rows = (
        f"b{i} server-{i}.exe.bak-b{i}-20260930 | wave W{i} | "
        f"['drafts:events.json', 'live:agent-{i}.jsonl'] | " + "z" * 60
        for i in range(150)
    )
    table = "\n".join(rows)
    assert 20_000 < len(table) < 32_000
    assert engine.fact_stub(table, False, "t", engine.RAIL_TIERS[0]) == table


def _observations(n: int, size: int = 9000):
    messages = [{"role": "system", "content": "sys"}]
    calls = []
    for i in range(n):
        tc_id = f"o{i}"
        messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": tc_id,
                        "type": "function",
                        "function": {"name": "terminal", "arguments": json.dumps({"command": f"curl -s http://127.0.0.1:{8000 + i}/health"})},
                    }
                ],
            }
        )
        body = f"service {i} status=ok pid {40000 + i}\n" + "log line without facts\n" * (size // 23)
        messages.append({"role": "tool", "tool_call_id": tc_id, "content": body})
        calls.append({"id": f"t{i + 1}", "tool_call_id": tc_id, "tool": "terminal", "input": {"command": "curl"}, "pinned": False})
    return messages, calls


def test_greedy_gives_up_no_more_than_the_minimum_needs():
    messages, calls = _observations(6)
    drop = {c["id"]: "drop_result" for c in calls}
    eng = engine.JevEngine()
    eng._apply(messages, calls, drop, 0.05)
    assert eng._rail_tier == 0  # tier 0 already frees 5%


def test_last_resort_evicts_oldest_dropped_never_a_keep():
    messages, calls = _observations(6)
    decisions = {c["id"]: "drop_result" for c in calls}
    decisions["t1"] = "keep"
    eng = engine.JevEngine()
    out = eng._apply(messages, calls, decisions, 0.97)
    assert eng._rail_tier == engine.LAST_RESORT_TIER
    by_id = {m.get("tool_call_id"): m for m in out if m.get("role") == "tool"}
    assert by_id["o0"]["content"] == messages[2]["content"]  # Jev keep untouched
    assert re.search(r"evicted under context pressure|only fact lines kept", by_id["o1"]["content"])


def test_min_reduction_follows_the_prompt():
    eng = engine.JevEngine()
    messages, _ = _observations(3)
    est = engine._message_tokens(messages)
    assert eng._min_reduction(messages, None) == engine.RAIL_FLOOR  # no trigger known
    eng.threshold_tokens = 1_000_000
    eng.max_tokens = None
    trigger = eng._effective_trigger()
    expected = 1 - (trigger * 5 / 6 - 0) / est
    got = eng._min_reduction(messages, est)
    assert got == max(0.05, min(0.9, expected))


def test_reduced_results_are_final():
    stub = engine.fact_stub("x\n" * 5000, False, "t1")
    assert engine.reduced_text(stub, False, "t1", engine.RAIL_TIERS[3], False) == stub


def test_offload_saves_full_output_and_points_the_note(tmp_path, monkeypatch):
    messages, calls = _observations(2)
    eng = engine.JevEngine()
    monkeypatch.setattr(eng, "_outputs_dir", lambda: tmp_path / "out")
    out = eng._offload(messages, eng._apply(messages, calls, {c["id"]: "drop_result" for c in calls}, 0.5))
    saved = tmp_path / "out" / "o0.txt"
    assert saved.read_bytes().decode("utf-8") == messages[2]["content"]
    note = next(m for m in out if m.get("tool_call_id") == "o0")["content"]
    assert f"the full output is saved at {saved.as_posix()}" in note
    assert engine.full_output_note("o0") not in note


def test_offload_failure_keeps_the_history_note(tmp_path, monkeypatch):
    messages, calls = _observations(2)
    eng = engine.JevEngine()
    monkeypatch.setattr(eng, "_outputs_dir", lambda: tmp_path / "out")

    def refuse(self, data):
        raise OSError("EACCES")

    monkeypatch.setattr(engine.Path, "write_bytes", refuse)
    reduced = eng._apply(messages, calls, {c["id"]: "drop_result" for c in calls}, 0.5)
    assert eng._offload(messages, reduced) == reduced


def test_hard_line_sits_above_the_trigger_and_inside_the_budget():
    eng = engine.JevEngine()
    messages, _ = _observations(3)
    est = engine._message_tokens(messages)
    assert eng._hard_reduction(messages, None) == 0.0  # no figures: never forced
    eng.threshold_tokens = 1_000_000
    trigger = eng._effective_trigger()
    tokens = int(trigger * 1.1)
    # 10% over the trigger is under the 1.25x line: nothing is forced
    assert eng._hard_reduction(messages, tokens) <= max(0.0, 1 - (trigger * 1.25 - (tokens - est)) / est) + 1e-9
    # the min reduction still asks for the way back to 5/6 of the trigger
    assert eng._min_reduction(messages, tokens) >= eng._hard_reduction(messages, tokens)


def _one_output(tc_id: str, text: str):
    messages = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": tc_id, "type": "function", "function": {"name": "terminal", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": tc_id, "content": text},
    ]
    reduced = [messages[0], dict(messages[1], content=f"[jev-compaction omitted; {engine.full_output_note(tc_id)}]")]
    return messages, reduced


def test_saved_copy_is_redacted(tmp_path, monkeypatch):
    key = "sk-" + "proj" + "-" + "aB3dE6gH9jK2mN5pQ8sT" * 2  # built at run time: no key-shaped literal in the repo
    messages, reduced = _one_output("o1", f"OPENAI_API_KEY={key}\n" + "line\n" * 2000)
    eng = engine.JevEngine()
    monkeypatch.setattr(eng, "_outputs_dir", lambda: tmp_path / "cache" / "s1")
    eng._offload(messages, reduced)
    saved = (tmp_path / "cache" / "s1" / "o1.txt").read_bytes().decode("utf-8")
    assert key not in saved and "OPENAI_API_KEY=" in saved


def test_no_redactor_no_file(tmp_path, monkeypatch):
    messages, reduced = _one_output("o1", "x" * 9000)
    eng = engine.JevEngine()
    monkeypatch.setattr(eng, "_outputs_dir", lambda: tmp_path / "cache" / "s1")
    monkeypatch.setattr(engine.JevEngine, "_redact", staticmethod(lambda text: None))
    assert eng._offload(messages, reduced) == reduced
    assert not (tmp_path / "cache" / "s1").exists()


def test_hostile_tool_call_id_stays_inside(tmp_path, monkeypatch):
    messages, reduced = _one_output("../../evil", "x" * 9000)
    eng = engine.JevEngine()
    monkeypatch.setattr(eng, "_outputs_dir", lambda: tmp_path / "cache" / "s1")
    eng._offload(messages, reduced)
    assert [p.name for p in (tmp_path / "cache" / "s1").iterdir()] == [".._.._evil.txt"]
    assert not (tmp_path / "evil.txt").exists()


def test_expired_outputs_are_deleted(tmp_path):
    old = tmp_path / "s-old" / "a.txt"
    new = tmp_path / "s-new" / "b.txt"
    for f in (old, new):
        f.parent.mkdir(parents=True)
        f.write_text("output", encoding="utf-8")
    now = time.time()
    os.utime(old, (now - 31 * 86400, now - 31 * 86400))
    assert engine.JevEngine._expire_outputs(tmp_path, now) == 1
    assert not old.exists() and not old.parent.exists() and new.exists()
