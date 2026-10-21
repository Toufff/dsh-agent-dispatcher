# DSH Agent Dispatcher

Local task dispatch across DSH, Codex and Claude Code. Linear holds requirements and acceptance; the recipient controls local executors, directories and sessions.

**Development status:** host plugin, CLI/native adapters, Linear intake/outbox and priority panel are implemented and undergoing integration acceptance. Unit/contract tests pass; live integration acceptance is not yet complete. See [the architecture](docs/architecture.md).

## Development

Requires Node.js 22 or later. No credentials are needed for the automated tests.

```sh
npm ci
npm test
npm run check
npm run build
```

The kernel accepts injected persistence and executor adapters. An executor must report whether execution was accepted, definitively rejected, or uncertain. Automatic fallback is permitted only after a definitive pre-execution rejection.

Keep runtime state and local configuration outside this repository. Never commit tokens, agent login files, transcripts or project-specific paths. See [SECURITY.md](SECURITY.md).
