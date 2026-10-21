# Configuration and operation

## Local project

The panel's configuration JSON has `executors` and `projects` arrays. For example:

```json
{
  "executors": [
    { "id": "codex", "label": "ChatGPT", "type": "codex", "command": "codex", "enabled": true, "args": [], "sandbox": "workspace-write", "verified": false },
    { "id": "dsh", "label": "DSH", "type": "dsh", "enabled": true, "args": [], "sandbox": "workspace-write", "verified": false },
    { "id": "claude", "label": "Claude Code", "type": "claude", "command": "claude", "enabled": false, "args": [], "sandbox": "workspace-write", "verified": false }
  ],
  "projects": [
    { "id": "example", "label": "Example project", "cwd": "/absolute/project/path" }
  ]
}
```

Executor IDs identify configured instances; `type` selects the adapter. More than one instance of the same adapter can have different commands or options. `verified` is a local operator annotation, not an authentication check. Availability means the native service or executable exists; it does not promise remaining quota or valid login. DSH uses its own access policy; the `sandbox` field applies to Codex. Claude keeps its official CLI permissions and configured policies.

The project directory must already exist. Issues cannot set it. The ordered executor list is captured when a task enters the queue. Changing priority affects future tasks; command and project changes are refused while affected tasks are unresolved. Configuration saves detect stale revisions from other windows.

## Linear

Add a `linear` object to a project:

```json
{
  "workspaceId": "replace-with-workspace-id",
  "projectId": "replace-with-project-id",
  "assigneeId": "replace-with-your-user-id",
  "readyStateId": "replace-with-ready-state-id",
  "reviewStateId": "replace-with-review-state-id",
  "tokenEnv": "LINEAR_PERSONAL_TOKEN",
  "enabled": false,
  "since": "2026-10-21T00:00:00.000Z",
  "round": "1"
}
```

Set `since` deliberately: ready issues updated since this timestamp become eligible, including older issues edited after activation. An old backlog is not automatically imported unless this cutoff admits it. Enable only after checking project, assignee and ready-state IDs. Supply the named environment variable to the DSH host process through your private launcher/secret manager; this plugin does not load `.env` files or store token values in its domain. Separate workspaces use separate environment variables and mappings. The API key must belong to the configured workspace and have issue read/write access.

Intake polls every 30 seconds while the host runs; **检查 Linear** performs an immediate check. Pause prevents new automatic execution, but does not stop the currently executing task or disable polling. Disable the mapping to stop intake. One active receiver per human/project is supported. Do not run this mapping simultaneously on multiple machines.

Deduplication uses workspace + issue + explicit `round`, never `updatedAt`. Returning an issue to the ready state does not automatically run the same round again. Use local retry, or deliberately advance the round for a new dispatch cycle. Changing a project's round affects every eligible issue in that project.

Successful execution queues a fixed, privacy-preserving completion comment and moves the issue to the configured review state. Raw output, local paths, session IDs and executor names are not sent. Review results locally or publish a separately reviewed PR/report. This conservative first version does not automatically publish a detailed agent summary. Outbox retries retain a client-generated comment ID and do not rerun coding. Completed/canceled issues are not moved backward. **本地确认验收** records local acceptance; mark the issue Done in Linear when appropriate.

## Sessions and intervention

- **View:** DSH sessions open directly from the task. For Codex use `codex resume SESSION_ID`; for Claude use `claude --resume SESSION_ID`. These official sessions persist outside the dispatcher. Automatic appearance in the Codex desktop sidebar is not guaranteed; Claude Desktop transfer is optional and not live-tested here.
- **Takeover:** stops owned work before transferring ownership. The entire automatic queue remains blocked while a task is manually owned. DSH removes dispatcher-owned queued prompts before cancelling the current turn and preserves unrelated queued input.
- **Return:** finish manual work and confirm this in the panel. DSH checks idle/queue state. Official CLI processes started manually have no dispatcher-owned lease, so CLI return additionally relies on your explicit confirmation that the manual session ended.
- **Retry:** allowed only after confirmed stop or terminal failure. Once an agent accepted the task, retry remains on that executor and resumes its recorded session. Starting with a different agent is a new explicit task/handoff, not a silent fallback.
- **Unknown:** a missing acknowledgement or ambiguous termination blocks the task. Reconcile it; do not start a duplicate. An approval/permission interruption must be resolved in the original tool or by takeover, never by changing executors to bypass the approval.

CLI print mode cannot host every interactive approval UI. If the tool exits for approval, the task is failed and requires manual intervention; if it stays running, the dispatcher keeps its slot occupied. DSH approvals remain in the native session.

## Persistence and recovery

Task state is stored in the DSH `agent_dispatcher` storage domain. CLI execution receipts live in the plugin's private runtime directory, default `$DSH_HOME/agent-dispatcher` or `~/.dsh/agent-dispatcher`. A custom plugin `directory` config changes the receipt/lock directory. Treat both domain and runtime files as private; they can contain task text and local outputs.

One host owns the runtime directory through `host.lock`. Always use the same runtime directory for hosts sharing the same DSH domain storage. Stop the old host before starting another. An abnormal process kill may leave a stale lock. After verifying the owner is gone:

```sh
node scripts/recover-lock.js /absolute/private/runtime/directory
```

Recovery refuses removal while the recorded PID is alive. It never restarts tasks or deletes session history. On restart, execution intents are reconciled; they are never blindly replayed. Live CLI workers maintain receipts and accept stop requests from a reloaded host. An orphan with no heartbeat stays unknown. Managed locks do not prevent unrelated manual processes from writing to the same project.

## Validation

`npm test`, `npm run check`, and `npm run build` require no agent login. `node scripts/live-smoke.js codex` makes one real subscribed-agent request. Substitute `claude` only when you intend live Claude validation. `scripts/browser-smoke.js` requires an already running isolated DSH host and `DSH_TEST_URL`; it checks the real remote transport and priority save roundtrip using Edge by default. Set `PLAYWRIGHT_CHANNEL` for another installed compatible browser. Keep authentication-bearing URLs out of issues and commits.
