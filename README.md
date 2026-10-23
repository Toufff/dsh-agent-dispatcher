# DSH Agent Dispatcher

Local task dispatch across DSH, Codex and Claude Code. Linear holds requirements and acceptance; the recipient controls local executors, directories and sessions.

**Version 0.1:** a working plugin for DSH 0.2.1-rc.2. Native DSH, official Codex CLI and official Claude Code CLI execution have passed live acceptance. Claude also passed takeover/return and same-session resume through the packaged host. Its default executor remains disabled until locally configured. See [acceptance evidence](docs/acceptance.md).

The Chinese panel separates the searchable task queue from project/connection settings. Local project forms validate working directories and retrieve Linear projects, people and states by name. It also provides draggable executor priority, keyboard reorder controls, a persistent FIFO queue, attempt history, pause, stop, takeover, return, retry and human acceptance. Host-owned incremental Linear sync and a separate durable outbox connect human-assigned issues to local execution. Mappings share a sync loop per workspace and credential environment variable; no public endpoint or relay server is needed. The panel shows last success, next check and retry status, with separate connection-check and sync actions. Connection currently uses host environment API keys; OAuth is not implemented.

## Install in a DSH web profile

```sh
git clone https://github.com/Toufff/dsh-agent-dispatcher.git
cd dsh-agent-dispatcher
npm ci
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-agent-dispatcher
dsh web
```

On Windows use a path such as `C:/Projects/dsh-agent-dispatcher`. Install into the profile you actually use; restart that DSH host after installation. The package's `dsh.bundle` automatically registers its plugin patch. Open **任务派发** in the sidebar. Automatic dispatch starts paused and no real project is configured by default.

In **配置项目与连接**, add a local project and verify executable paths. Native `.exe` executables are recommended on Windows; shell aliases and `.cmd` shims are not supported. Keep your ordinary agent login in the official tool. Start with a harmless local task before enabling Linear intake.

See [configuration and operation](docs/usage.md), [adapter extension](docs/adapters.md), and [architecture](docs/architecture.md).

## Development

Requires Node.js 22 or later. No credentials are needed for the automated tests.

```sh
npm ci
npm test
npm run check
npm run build
```

For isolated browser form tests, run `npm run test:settings-ui` (Microsoft Edge by default, or set `PLAYWRIGHT_CHANNEL` to an installed Chromium channel). These tests use synthetic metadata and never dispatch tasks or contact Linear.

The kernel accepts injected persistence and executor adapters. An executor must report whether execution was accepted, definitively rejected, or uncertain. Automatic fallback is permitted only after a definitive pre-execution rejection.

Keep runtime state and local configuration outside this repository. Never commit tokens, agent login files, transcripts or project-specific paths. See [SECURITY.md](SECURITY.md).
