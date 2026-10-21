# DSH Agent Dispatcher

Local task dispatch across DSH, Codex and Claude Code. Linear holds requirements and acceptance; the recipient controls local executors, directories and sessions.

**Development status:** the initial implementation contains the scheduling kernel and behavioral tests. It is not yet an installable DSH plugin. Native DSH integration, official CLI adapters, Linear intake/outbox and the priority editor are planned in [the architecture](docs/architecture.md). No live agent or Linear integration is claimed by this version.

## Development

Requires Node.js 22 or later. No dependencies or credentials are needed for the kernel tests.

```sh
npm test
npm run check
```

The kernel accepts injected persistence and executor adapters. An executor must report whether execution was accepted, definitively rejected, or uncertain. Automatic fallback is permitted only after a definitive pre-execution rejection.

Keep runtime state and local configuration outside this repository. Never commit tokens, agent login files, transcripts or project-specific paths. See [SECURITY.md](SECURITY.md).
