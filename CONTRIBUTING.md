# Contributing to hermes-jev-compaction

Thanks for your interest in improving the project!

## How to report a bug

Open a [bug report](.github/ISSUE_TEMPLATE/bug_report.md) with:
- Steps to reproduce (minimal is best)
- Expected vs actual behavior
- Hermes Agent version, Node version, and model used
- Relevant log lines (⚠️ redact API keys and personal data)

## How to suggest a feature

Open a [feature request](.github/ISSUE_TEMPLATE/feature_request.md) describing
the problem you're solving, not just the solution.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your changes.
3. Run tests:
   ```bash
   npx vitest run                              # TypeScript (library + adapter)
   python -m pytest tests/test_jev_engine.py   # Python engine (needs Hermes venv)
   ```
4. Ensure `npm run build` and `npm run typecheck` pass.
5. Commit with a clear message describing *what* and *why*.
6. Push and open a PR against `main`.

## Code style

- TypeScript: strict mode, ES2022, NodeNext modules.
- Python: type hints, docstrings on public functions.
- Keep it boring — no frameworks, no abstractions for one caller.

## License

By contributing you agree that your contributions are licensed under MIT.
