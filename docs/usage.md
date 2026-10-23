# Configuration and operation

## Local project

Open **项目与连接** for the project form. Add or select a local mapping, enter its name and absolute working directory, then use **检查目录**. The directory must already exist; this check does not create or write files. New mappings do not enable Linear intake or automatic follow-up. Save explicitly after reviewing the form. Existing tasks keep their captured directory and session; saving a mapping does not rearm historical waits.

The form preserves executor commands and other settings it does not expose. **高级配置 JSON** remains available for full configuration; loading JSON changes the draft only. Leaving a dirty form prompts before discarding it, and stale saves from another window are rejected without losing the draft. Saves apply all project drafts, not only the selected one.

The task queue supports title/issue-number, project and status filters. Local task creation is collapsed by default. Executor ordering stays in the task view; save or discard priority changes before entering project settings.

The configuration JSON has `executors` and `projects` arrays. For example:

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

In the project form, select **为此项目配置 Linear**, enter the name of a credential environment variable already configured for the DSH host, and click **读取账号与项目**. The authenticated read-only request retrieves the current account/workspace, accessible projects, members and workflow states. Choose them by name; state labels include the team. Loading this catalog never enables dispatch, creates an issue or changes an assignee. A different workspace is rejected for an existing mapping. Metadata is not persisted as authoritative identity, and a failed refresh removes the verified-connection indicator.

Connection currently uses an API key, not OAuth. Do not enter the secret itself in the form. The page cannot add environment variables to an already running host; provide the key through your private launcher or secret manager. Several project mappings may use the same credential variable. **外部回复与自动恢复** has a separate checkbox list of trusted Linear members; selecting a member alone does not enable follow-up. Recheck project, team states, assignee and activation timestamp before enabling intake.

For advanced configuration, add a `linear` object to a project:

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

Classified completion queues a privacy-preserving comment and moves the issue to the configured review state. Starts and execution failures also receive deduplicated status updates. Raw output, local paths, session IDs and executor names are not sent. Opt-in `shareProgress` can publish an explicit shareable business summary. Outbox retries retain a client-generated comment ID and do not rerun coding. Completed/canceled issues are not moved backward. **本地确认验收** records local acceptance; mark the issue Done in Linear when appropriate.

## Sessions and intervention

- **View:** DSH sessions open directly from the task. For Codex use `codex resume SESSION_ID`; for Claude use `claude --resume SESSION_ID`. These official sessions persist outside the dispatcher. Automatic appearance in the Codex desktop sidebar is not guaranteed; Claude Desktop transfer is optional and not live-tested here.
- **Takeover:** stops owned work before transferring ownership. Automatic work in the same configured directory remains blocked while a task is manually owned. Unrelated directories can run. DSH removes dispatcher-owned queued prompts before cancelling the current turn and preserves unrelated queued input.
- **Return:** finish manual work and confirm this in the panel. DSH checks idle/queue state. Official CLI processes started manually have no dispatcher-owned lease, so CLI return additionally relies on your explicit confirmation that the manual session ended.
- **Retry:** allowed only after confirmed stop or terminal failure. Once an agent accepted the task, retry remains on that executor and resumes its recorded session. Starting with a different agent is a new explicit task/handoff, not a silent fallback.
- **Unknown:** a missing acknowledgement or ambiguous termination blocks the task. Reconcile it; do not start a duplicate. An approval/permission interruption must be resolved in the original tool or by takeover, never by changing executors to bypass the approval.

CLI print mode cannot host every interactive approval UI. If the tool exits for approval, the task is failed and requires manual intervention; if it stays running, the dispatcher keeps its slot occupied. DSH approvals remain in the native session.

## Persistence and recovery

CLI completion first enters **执行完成，正在清理进程**. The queue remains occupied until the owned process closes. After a successful completion record, a CLI that lingers for 15 seconds is terminated; an unconfirmed cleanup stays unknown. Codex additionally checks the matching local session's latest turn event every five seconds, requiring a completion timestamp after this attempt started. This compatibility fallback depends on Codex's local transcript format; missing or unrecognized records never imply completion. Do not run another writer in the same session during automatic execution.

Task state is stored in the DSH `agent_dispatcher` storage domain. CLI execution receipts live in the plugin's private runtime directory, default `$DSH_HOME/agent-dispatcher` or `~/.dsh/agent-dispatcher`. A custom plugin `directory` config changes the receipt/lock directory. Treat both domain and runtime files as private; they can contain task text and local outputs.

One host owns the runtime directory through `host.lock`. Always use the same runtime directory for hosts sharing the same DSH domain storage. Stop the old host before starting another. An abnormal process kill may leave a stale lock. After verifying the owner is gone:

```sh
node scripts/recover-lock.js /absolute/private/runtime/directory
```

Recovery refuses removal while the recorded PID is alive. It never restarts tasks or deletes session history. On restart, execution intents are reconciled; they are never blindly replayed. Live CLI workers maintain receipts and accept stop requests from a reloaded host. An orphan with no heartbeat stays unknown. Managed locks do not prevent unrelated manual processes from writing to the same project.

## Validation

Each successful execution is classified before reporting: **完成待验收**, **等待外部条件**, **需要决策或授权**, **续办已暂停：进展或次数限制**, or **结果待分类**. Useful authorized local work continues automatically in the original session, up to three work continuations. A missing result contract receives one formatting-only repair per work round with specific validation diagnostics. A stored result that becomes valid after a parser update can recover without rerunning the agent (only non-executing outcomes). History is preserved. These limits are fixed in this version. Pausing prevents any new automatic turn.

Set optional project `executionInstructions` for local restrictions that must survive continuation, such as offline-only validation during trading hours. These are prompt restrictions, not an OS sandbox or a trading-calendar service; they persist until locally changed. Set optional Linear `activeStateId` and/or `blockedStateId` to keep unfinished issues out of review. Without either mapping, unfinished results add a status comment without changing the issue state.

To enable external-condition monitoring, add `followup: {"enabled": true, "commentAuthorIds": ["trusted-linear-user-id"], "maxWakeups": 8}` to the local project. The agent must return a blocked result with a `wait` object; existing finished blocked/stopped/stalled tasks can use **设置恢复条件**. For replies use `{"kind":"linear","condition":"Verify peer receipt","issueId":"child-issue-id"}`. For exact time checks use `{"kind":"time","condition":"Recheck the agreed window","notBefore":"2030-01-02T20:30:00+08:00","expiresAt":"2030-01-02T21:30:00+08:00"}`. These are examples, not live schedules. Keep dispatch enabled and the DSH host running. The panel shows last check, current condition, window and errors. A received comment or elapsed time queues the original session to reassess; it does not grant production permission.

Set `linear.shareProgress: true` only when you want the agent's explicit `publicSummary` and safe wait condition shared with collaborators. Include completed work, next responsible party, required receipt and exact times in that summary; never put credentials or local paths there. The plugin has a conservative disclosure guard but no comprehensive DLP. Full transcripts remain local. See architecture.md for deduplication, ownership and reporting limitations.

For maintenance startup, `DISPATCH_START_PAUSED=1` persists a paused queue before the host begins cycling. The panel can explicitly resume after configuration is verified.

Set `followup.observeAfterExpiry: true` to keep receiving trusted replies after an execution window expires. The panel and Linear will show a pending reply, but no agent is started and the old window stays expired. Confirm the new timing locally and use **设置恢复条件**. When updating the same watched issue/type during maintenance, check **保留原监听起点** to retain replies received in the meantime; leaving it unchecked ignores older comments. Both modes preserve the consumed execution cursor and prior wait history.

Repeated Linear write failures show an automatic retry count in the panel. Restoring connectivity retries reporting only; it never reruns the coding task. An obsolete report is superseded as soon as a newer task state exists. Sustained unknown execution is reported but never automatically replayed; verify the original session/receipt before intervention.

Completed tasks offer **继续处理未完成事项**. This creates a distinct continuation with the previous result and the original issue link, preserving the old task. Repeated requests on the same parent deduplicate to one continuation. A registered session stays on its original executor even if local priorities changed; disabling that executor prevents the start instead of routing existing work elsewhere. An explicit retry starts a new bounded repair/continuation budget. A continuation is not permission to repeat completed work or override project approval rules.

`npm test`, `npm run check`, and `npm run build` require no agent login. `node scripts/live-smoke.js codex` makes one real subscribed-agent request. Substitute `claude` only when you intend live Claude validation. `scripts/browser-smoke.js` requires an already running isolated DSH host and `DSH_TEST_URL`; it checks the real remote transport and priority save roundtrip using Edge by default. Set `PLAYWRIGHT_CHANNEL` for another installed compatible browser. Keep authentication-bearing URLs out of issues and commits.
