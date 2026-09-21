# Security and data-integrity advisory

**Status: RESOLVED.**

- **Originally published:** 2026-09-21.
- **Audited HEAD:** [`bd827680b56d8bd37017b8a9baa89ef478121235`](https://github.com/deadczarvc/hermes-jev-compaction/tree/bd827680b56d8bd37017b8a9baa89ef478121235).
- **Resolved at:** [`4a55bef69033ae357ccc6eaff7da76582f14abf9`](https://github.com/deadczarvc/hermes-jev-compaction/commit/4a55bef69033ae357ccc6eaff7da76582f14abf9) (latest fix commit in the `85bb9ad..4a55bef` range; see resolution table below).
- **Scope:** this repository's Python context-engine plugin, TypeScript Hermes adapter, CLI, and test integration.

## Correction history

Previous documentation and project updates overstated privacy protection, receipt preservation, lossless conversion, and test coverage. The four findings below were confirmed by source inspection and offline tests at the audited commit. All have been fixed in subsequent commits.

## Resolution table

| ID | Component | Fixing commit(s) | How it was fixed | Verification |
| --- | --- | --- | --- | --- |
| JEV-AD-01 | Python plugin: `metadata` egress mode | [`85bb9ad`](https://github.com/deadczarvc/hermes-jev-compaction/commit/85bb9ad) | `metadata` mode now projects tool arguments to kind/keys/count/length metadata. Serialized bytes to Jev contain no raw argument values. Unknown egress modes fail closed (zero HTTP). `off` mode performs zero HTTP. Scoped-secret failures do not fall back to process env. | `tests/test_egress_policy.py`: 8 wire-byte privacy tests with sentinel markers. `mutation_controls.py`: off_guard, raw_argument_stripping, scoped_error_fallback all killed. |
| JEV-AD-02 | Python plugin: `drop_result` truncation | [`12f8a15`](https://github.com/deadczarvc/hermes-jev-compaction/commit/12f8a15) | `_apply` now uses `_RECEIPT_RE` on the active path: if a result matches receipt markers, head+tail is kept instead of head-only. Additionally, dropped calls are logged in `get_status()["dropped_recent"]` for recovery. | `tests/test_history_fidelity.py`: deep receipt survives; no-receipt still truncates; dropped-call recovery via status. |
| JEV-AD-03 | TypeScript adapter and CLI export | [`f39b715`](https://github.com/deadczarvc/hermes-jev-compaction/commit/f39b715) | `toHermes()` now accepts `HermesTranscript` (with `sourceMessages`) for source-aware lossless serialization. All-KEEP round trip is deeply equal to native input, including images, opaque fields, unknown roles, and raw arguments. CLI `--dry-run` and live output both use the source-aware path. | `tests/hermes-lossless.test.ts`: 9 tests covering mixed/image-only content, developer/unknown roles, mid-stream system, opaque/reasoning/error fields, raw arguments. CLI dry-run fixtures cover JSON array/container/JSONL. |
| JEV-AD-04 | Test integration (golden corpus) | [`acb3ff2`](https://github.com/deadczarvc/hermes-jev-compaction/commit/acb3ff2) | `tests/test_contract_corpus.py` now loads `contract-corpus.json` and runs all 14 cases. Standard cases (9) test structural invariants via stubbed Jev. Adversarial cases (5: unpaired, fallback, junk×3) are tested separately. `compress(non-list)` returns input unchanged (fail-open on junk). | Full suite: 71/71 pytest, 41/41 vitest. Corpus cases contribute 9 standard + 4 adversarial + 1 fallback + 3 junk-parametrized = 17 new tests. |

## Verification

Two consecutive clean runs of the full battery at commit `4a55bef`:

- pytest: 71 passed × 2
- vitest: 41 passed × 2
- tsc --noEmit: exit 0 × 2
- git diff --check: exit 0 × 2
- Station-path/secret scan on `f8a3919..HEAD` diff: 0 findings

## Evidence limits

- The outbound-content fix is demonstrated by wire-byte sentinel tests (captured HTTP body), not by calling the live API.
- The receipt fix is tested with synthetic markers; real-world receipt format coverage depends on `_RECEIPT_RE` pattern matching.
- The threshold calibration (`keep_threshold = 0.5`) remains a starting point, not a validated optimum. See `docs/threshold-analysis.md` for scope and limitations.

## Architecture decision

See [`docs/ADR-001-primary-bounded-curation.md`](docs/ADR-001-primary-bounded-curation.md): Jev is the primary bounded-curation stage; it decides tool-call keep/drop/truncate. User/assistant prose always stays verbatim. Full compaction of prose is Hermes' built-in summarizer's job.
