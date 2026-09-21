# Security and data-integrity advisory

**Status: DO NOT USE.**

- **Published:** 2026-09-21.
- **Audited HEAD:** [`bd827680b56d8bd37017b8a9baa89ef478121235`](https://github.com/deadczarvc/hermes-jev-compaction/tree/bd827680b56d8bd37017b8a9baa89ef478121235).
- **Scope:** this repository's Python context-engine plugin, TypeScript Hermes adapter, CLI, and test integration at the audited commit.
- **Remediation status:** the four findings below remain unresolved in that revision. This documentation update does not fix them.

## Correction of previous claims

Previous documentation and project updates overstated privacy protection, receipt preservation, lossless conversion, and test coverage. Passing the existing test suites and registering the plugin in Hermes did not establish those properties. The following findings were confirmed by source inspection and, where applicable, offline tests with synthetic inputs and an intercepted HTTP boundary.

Do not enable this revision as a context engine or use its CLI to compact or export working transcripts. Keep original transcripts intact. This advisory takes precedence over conflicting installation instructions, safety claims, and earlier statements that these issues were fixed.

## Confirmed findings

| ID | Component | Confirmed behavior | Consequence | Evidence at audited HEAD |
| --- | --- | --- | --- | --- |
| JEV-AD-01 | Python plugin: `metadata` egress mode | Message text is replaced with character counts, but serialized tool arguments are still included in the state submitted to Jev. A synthetic marker placed in a tool argument remained in the intercepted request body. | Tool arguments can contain document text, message bodies, commands, credentials, or other working data. Selecting `metadata` does not prevent that content from being sent to the external API. | [`_fit_state`, lines 339–357](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/hermes-plugin/__init__.py#L339-L357); [`_ask_jev`, lines 452–459](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/hermes-plugin/__init__.py#L452-L459). |
| JEV-AD-02 | Python plugin: successful compaction | The active `drop_result` path retains the first 300 characters of a long tool result and removes the remainder. A confirmation ID placed beyond that prefix was lost. `_RECEIPT_RE` is used only by `_fallback_prune`, which the active `compress()` path does not call. | Confirmation IDs and important error details can disappear from the retained context. Repeating a side-effecting operation is not a safe substitute for recovering its original result. | [`compress`, lines 270–287](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/hermes-plugin/__init__.py#L270-L287); [`_apply`, lines 520–526](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/hermes-plugin/__init__.py#L520-L526); [`_fallback_prune`, lines 548–576](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/hermes-plugin/__init__.py#L548-L576). |
| JEV-AD-03 | TypeScript adapter and CLI export | `fromHermes()` converts content-part arrays to text. Non-text parts, including images, are not restored by `toHermes()`. The declared `keepNonTextParts` option is not applied. The loss occurs even when every compaction decision is KEEP, and the CLI's `--dry-run` output uses the same conversion. | Exported transcripts can lose images before any Jev decision. This finding concerns the adapter/CLI conversion path; it is not a claim that all Python-plugin paths remove images. | [`contentText`, lines 35–46](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/src/hermes.ts#L35-L46); [`fromHermes`, lines 78–122](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/src/hermes.ts#L78-L122); [`toHermes`, lines 132–168](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/src/hermes.ts#L132-L168); [`--dry-run`, lines 105–124](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/bin/hermes-compact.mjs#L105-L124). |
| JEV-AD-04 | Test integration | `tests/fixtures/contract-corpus.json` exists, but none of the executable tests at the audited commit loads it or evaluates its declared invariants. | The corpus does not provide automated regression coverage. Its presence and the existing passing test counts cannot be used as evidence that those contracts hold. | [Contract corpus](https://github.com/deadczarvc/hermes-jev-compaction/blob/bd827680b56d8bd37017b8a9baa89ef478121235/tests/fixtures/contract-corpus.json); [executable test sources](https://github.com/deadczarvc/hermes-jev-compaction/tree/bd827680b56d8bd37017b8a9baa89ef478121235/tests). |

## Evidence limits

- The outbound-content finding demonstrates a data path. It does not establish whether any particular user's data was transmitted or retained by the API provider.
- The receipt-loss finding concerns the successful decision-application path. In this revision, a caught Jev transport failure returns the original messages unchanged; that does not protect receipts when Jev successfully returns a destructive decision.
- Existing passing tests are not withdrawn as execution results. Their interpretation as proof of the properties above is withdrawn.
- No additional suspected findings are included in this advisory.

## Conditions for withdrawing this warning

The warning remains in effect until a subsequent identified revision fixes all four findings and passes tests that exercise the relevant boundaries: captured outbound request bodies, receipt IDs beyond the retained prefix, image-preserving all-KEEP and CLI round trips, and an executable runner for the contract corpus. The revision and verification evidence must be published before the status changes.
