# Architecture and implementation sequence

## Ownership

Linear stores human-facing requirements, human assignees and acceptance. Each recipient's local DSH plugin owns routing. A remote issue must not select an executable, command line, local directory or session. Project mappings and enabled executor instances are configured locally.

The first policy is an ordered list of enabled executors and FIFO tasks, with one automatically running task globally. Adapter types are separate from configured executor instances. Later policies can select an ordered candidate list through the same interface without changing execution semantics.

## Kernel invariants

- Persist an attempt intent before starting an executor. Snapshot executor order per task.
- Only a confirmed rejection before execution permits fallback. Busy waits; approvals wait for human action; an uncertain start blocks pending reconciliation.
- A crash after intent persistence does not replay the start. Reconcile the recorded attempt using its stable ID.
- A running failure preserves the workspace and requires an explicit decision. Successful process completion enters result assessment, not human acceptance. A validated result contract distinguishes completed requirements, useful local continuation, external blockers and human decisions.
- Persist result reporting separately. A failed Linear update must never restart coding.
- Deduplicate intake by workspace, issue and explicit dispatch round, not issue modification time.
- Managed concurrency does not prevent writes by unrelated manual sessions.

## Host integration

Use DSH's storage domain for persistent state, its authenticated remote services for UI actions, and its native client extension points. The initial in-memory test store is deliberately not a production persistence provider. There is no separate unauthenticated HTTP control server.

The host adapter must provide atomic replacement of one aggregate state record and exclusive local ownership. Multiple processes receiving the same project are unsupported until explicit leases are implemented. Browser closure does not stop dispatch; DSH host shutdown does.

Standalone evidence/receipt file replacement retries transient Windows sharing errors with bounded backoff (four retries, 750 ms total). It keeps the committed destination until the same temporary file can be atomically renamed; exhausted retries and unrelated errors remain visible. This does not rerun an executor. The opt-in collaborator simulation uses the real runtime and CLI with a synthetic GraphQL transport in a fresh private store; it never injects simulated identities into a real host or Linear issue.

## Execution adapters

All adapters implement start and reconciliation; stop must confirm termination before another managed run starts. Session identity, execution identity and task identity are distinct.

| Adapter | Transport | Validation |
| --- | --- | --- |
| DSH | Native session controller | Live execution, takeover and resume passed |
| Codex | Official CLI JSON protocol | Live CLI and packaged-host execution passed |
| Claude Code | Official CLI, stream JSON and resume | Live execution and same-session resume passed |

Use official executables with their existing login. Never extract subscription OAuth credentials, proxy subscription model endpoints or share accounts. Invoke commands without a shell. Resume only explicitly registered task sessions; never choose the most recent session heuristically.

DSH cancellation must remove dispatcher-owned queued prompts before cancelling the current turn. An ambiguous stop keeps the task blocked. Viewing a session does not transfer ownership. Takeover stops automatic dispatch, confirms termination and transfers ownership; return requires reconciliation.

## Linear and UI

Intake is explicitly enabled per project and assignee with a selected ready state. Existing backlog requires deliberate import. Tokens remain local; outgoing reports contain business summaries and approved links, never raw local transcripts or paths. Reporting uses a durable outbox with retry independent from execution.

The DSH panel will expose draggable executor priority (plus keyboard controls), enable/disable, health, FIFO queue, attempt history, stop, takeover, return and retry. It does not replace Linear's project dashboard.

Project settings use a local draft with the existing revision-based configure command. Catalog and directory-check commands are authenticated, read-only helpers: they never mutate dispatch state or start executors. The catalog uses the fixed Linear endpoint and an environment-variable name, returns only account/project/member/state metadata, and bounds pagination. Directory checks stat an absolute path without writing. Saving configuration remains a separate explicit action with the kernel's existing active-task guards; task directory/session snapshots remain unchanged.

## Delivery sequence

1. Scheduling state machine and failure/restart tests (initial commit).
2. DSH storage and remote service integration; persistent queue and ownership.
3. DSH and Codex adapters with isolated live validation; Claude CLI contract and live resume tests.
4. Linear intake and result outbox; local project mappings.
5. Native DSH priority editor and task inspection; end-to-end validation.

These stages are implemented; see acceptance.md for verified scope and remaining permission and Desktop validation. Human acceptance remains separate from an agent's completion report. The host adds a cross-process runtime-directory lock; only one receiver may use a given DSH domain store.

## Result assessment and bounded continuation

New tasks append a local structured result contract. Completion requires evidence and no remaining work, next step or blockers. Agent reports are claims, not independent proof of correctness; final acceptance remains human. Mixed tasks continue independent authorized work before waiting on external dependencies. Missing/malformed contracts get one formatting-only repair per work round in the same registered session, then stop as unclassified. A fresh external wake or validated work continuation resets this budget; a failed formatting repair does not. Legacy tasks are not automatically replayed. A blocked/decision result may describe a conditional next step; only a continue result can execute it. The owner-only `reassess-result` action reparses a stored, confirmed-finished unclassified result without launching any worker. It rejects continuation outcomes, human ownership and superseded tasks. It preserves the original summary, session and attempt history.

Automatic continuations remain in the same task, executor and session, preserving every round and its attempts. Requeue and history are persisted in one aggregate update. Restart cannot duplicate a queued continuation. Pause prevents execution; failures and ambiguous process state never trigger continuation. Three automatic work rounds are allowed; empty or exactly repeated progress stops earlier. This bounded heuristic cannot detect semantically equivalent paraphrases, so the hard ceiling also applies.

Local project executionInstructions are appended to each round and cannot be set by an incoming issue. They are agent instructions, not a command sandbox; runtime permissions and project-specific production gates remain required.

## Durable external waits

External blockers release the execution slot. Projects opt in using `followup.enabled`, a local `commentAuthorIds` allowlist and `maxWakeups` (default 8). A blocked result can include `wait: {kind: "linear", condition, issueId}` or a time wait with `kind: "time", condition, notBefore` and optional `expiresAt`. Timestamps must include a timezone; only time waits require a start. A Linear wait may specify only a monitoring deadline. If both timestamps exist, expiry must follow start. Use a Linear wait for unconfirmed window proposals. A timer is only a recheck trigger, never permission to deploy.

The host owns one single-flight sync loop per Linear workspace and credential environment variable, shared by project mappings and all open panels. It reads issues and comments separately with `updatedAt` filters, pagination and a 60-second overlap; comment edits do not depend on the issue timestamp changing. Watched parent/target metadata is fetched in a batch on every sync. A 15-minute reconciliation rereads the configured intake range and comments since each active wait was armed. Bounds fail closed instead of silently truncating results.

Sync saves a durable comment inbox before delivery and advances its cursor only after intake and monitoring finish successfully. Executor unavailability retains buffered replies across cursor advance and restart; existing task keys and consumed comment revisions prevent duplicate work. Configuration or wait-set changes invalidate the old cursor. Intake failures and reply failures are isolated so either side can make progress without committing a partial cursor. API outages back off from 30 seconds to 15 minutes; HTTP 429 and GraphQL rate-limit errors also honor the server retry/reset delay. Backoff survives restart and manual sync cannot bypass it.

After changes, active reply waits use a 30-second interval, increasing to 60 then 120 seconds while idle. Intake without reply waits uses 60 seconds, increasing to a 5-minute idle interval. Local timers and deadlines are checked each host cycle rather than waiting for the next remote sync. API latency, host cycles and an occupied execution slot can still delay execution; this is not a real-time SLA. The page shows last successful sync, next check, current interval and connection backoff; opening another page does not start another polling loop. Connection checks are read-only metadata checks; manual sync can admit eligible work through the normal paused/admission controls. Explicit pre-execution eligibility checks remain fresh and uncached.

The watched issue must be the task issue or its direct child in the configured project. Parent completion, cancellation, reassignment or project mismatch blocks resumption. A completed child may still supply a useful receipt. Own/outbox comments and consumed revisions do not wake tasks. Changing only a status without a trusted comment does not trigger this version.

The event cursor, original session, prior result and queued continuation are persisted atomically before execution. Restart does not replay consumed comments. Resume stays with the original executor/session; an unavailable executor is not silently replaced. Local mapping changes require explicit rearming. Pause and manual takeover suspend monitoring, and a manual writer excludes automatic work in the same configured directory. Unrelated directories can still run. Windows filesystem sharing failures receive bounded retries; unchanged domain state is not rewritten.

The owner-only panel action **设置恢复条件** can arm a finished blocked/stopped/stalled task without deleting history or replaying it. It listens from the time of saving; historical comments are not automatically imported. Superseded tasks cannot be rearmed. Human ownership must be returned before arming. Old tasks are never automatically migrated into execution.

Agent-proposed Linear waits begin as `validating`. Before monitoring or waking, the fixed Linear client verifies the target is the current task issue or its direct child. An invalid relationship is a permanent `invalid` configuration fault: persist it, report once, stop network retries, and require an explicit corrected wait. Transient API failures retain retries. Manual arming performs the same read-only validation before replacing history/cursors and rejects concurrent mapping/wait changes. A child of another local task is not a valid target merely because both tasks share a project.

Local mappings are not Linear projects. The queue groups mappings by workspace ID and project ID; `category` distinguishes business (default), test and archive mappings. Categories only affect presentation, never enable/disable intake or execution. Names from an explicit connection/catalog check are displayed with their Linear workspace; unverified names remain clearly marked.

Authentication remains an environment-injected API key. The panel's connection check verifies account, workspace and catalog access, with a timestamp; it neither starts work nor proves write permission. OAuth and webhook transport are not implemented. OAuth would change authorization, not event delivery. A future webhook transport needs a public HTTPS receiver, signature verification, durable receipt/deduplication and local delivery, followed by authoritative API reads through the same admission/wake guards. Retain lower-frequency reconciliation for missed events, outages and restart recovery rather than replacing the durable scheduler with direct webhook execution.

Before every Linear-backed execution, recheck current project, assignee and parent issue state. Failed admission parks that queued task for 30 seconds without releasing an uncertain running task or blocking unrelated queued work. A stopped/reassigned peer subtask must not run merely because it was previously admitted to the queue.

Stop/takeover intent is durable. If bounded termination initially returns unknown, retain the single execution slot and ownership. A later confirmed terminal receipt completes the original stop/takeover, including after restart; it cannot leave a successfully stopped worker permanently unknown or be mistaken for new completed work.

All replies are untrusted evidence. The resumed agent must reread current requirements, verify every remaining condition and the exact valid window before side effects. The kernel rejects a window that expires while queued, but cannot intercept arbitrary agent tool calls after execution starts: production commands still require their own gates. Decision/approval waits do not automatically resume.

`linear.shareProgress` optionally publishes the agent's explicit `publicSummary` plus safe wait conditions and exact times. The full transcript stays local. A conservative credential/path guard rejects suspicious summaries, but is not comprehensive DLP. Durable versioned outbox entries suppress stale retries; failed reporting never reruns coding. Local acceptance still does not mark Linear Done. Automatic child-issue creation or assignee changes are not implemented by the kernel; those remain explicit agent/tool actions within authorization.

## Failure recovery through the lifecycle

Condition monitoring counts consecutive failed checks durably. At three failures it exposes a global local alert and queues one generic Linear fault report; arbitrary exception text remains local. Further failures and host restart do not repeat the report. Successful monitoring clears the fault and reports recovery once, without treating restored connectivity as new permission or completed work. An unavailable original executor follows the same fault path and does not fall back to a different session. These reports use the existing independent outbox, so reporting outages cannot reexecute work.

Result transport retains long trailing contracts across CLI receipts, DSH and the kernel; it does not clip them to 12 KB. Oversized narratives are bounded without hiding multiple contracts or trailing contradictory text. Invalid results carry field/code diagnostics into the one formatting-only repair. A previously unclassified but now valid non-executing result is reassessed on ordinary cycles, preserving history; this cannot queue a `continue` outcome, replay tools, recover human-owned tasks or resurrect superseded tasks. Formatting-only instructions are not a tool sandbox.

Execution starts, terminal failures, exhausted executors and sustained unknown receipts receive deduplicated Linear reports; upgrading does not bulk-report historical failures. Disabled executors are checked again before launch, while existing accepted executions retain their adapter for reconciliation. DSH uses the first completed turn following its prompt admission, never a later unrelated session turn. Unknown receipts still hold the execution slot: safety takes precedence over automatic replay.

Window expiry is evaluated locally before network requests. Optional local policy `followup.observeAfterExpiry: true` continues reading trusted replies after expiry, records a pending update, and reports it once per new revision. It **does not start an agent, extend the deadline, or consume the normal execution cursor**. Confirmed new timing must be rearmed by the local owner/coordinator. Owner rearming may explicitly set `preserveCursor: true` for the same issue and wait kind, preserving replies that arrived during maintenance; the default remains listening from save time. Wait replacements retain history.

Reporting retries show their failure count after three failures and remain independent of execution. Superseded pending reports are retired immediately, including during backoff, so obsolete errors cannot mask a recovered task. The complete synthetic lifecycle test covers intake deduplication, one formatting repair, timed original-session wake, an external wait, host restart, read outage/recovery, concurrent reply polling and a lost report response, ending in review without marking Done. Production window negotiation, business validation and authorization remain separate from scheduler reliability.

CLI exit is tracked separately from stdout/stderr closure: detached services can inherit pipes after the agent exits. The worker drains pending output briefly, detaches its pipe readers and records the actual exit without killing descendants or an exited PID. Legacy completed receipts recover only when both CLI and worker PIDs are confirmed absent; permission errors, missing completion evidence or a live process remain unknown. Durable stop intent takes precedence. Recovery assesses the existing result and does not replay the task.

If a queued continuation expires before creating its next attempt, retain its completed evidence and original session. Explicit owner rearming may use only the latest confirmed historical attempt that matches that session; it preserves the old wait/deadline in history. A mismatch or unresolved attempt cannot silently select another session. A separately scoped development interval is not an extension of a production window; local restrictions and production gates still apply.

The owner-only `issue-context` command is display-only: it reads the source/target issue and configured reply-user identities from Linear, validates workspace/project and direct-child relationships, and never changes state, assignees, trust lists, cursors or dispatch admission. The panel refreshes selected task metadata once per minute, including disabled historical tasks, and keeps source assignee, target assignee and allowed reply authors distinct. Missing metadata is not replaced with agent-written role labels as if they were verified identities.


## Typed producers and deadlock prevention

A wait is an event subscription, not merely a natural-language blocker. New Linear waits require `expectedAuthorIds`: the actual required producer IDs, constrained by the local allowlist and excluding the receiver. A missing identity is a result-format error (one bounded formatting repair), while an impossible identity is a durable configuration fault. Legacy persisted waits retain history and cursors, but an undeclared producer becomes an actionable local configuration fault; explicit rearming is required. The scheduler cannot infer an intended person reliably from arbitrary prose.

Local handoffs use `kind: "task"` with an existing `taskId`, or an unambiguous local task's `issueId` (UUID or identifier). Resolution binds the exact task in the same local mapping. Self, missing, ambiguous, superseded and cross-project targets are rejected. Dependency traversal detects cycles, including indirect cycles. A confirmed `complete` outcome on a finished accepted attempt in review/accepted triggers the dependent's original session once. Completion is an agent result, not human acceptance or production authorization. Failure, stop, decisions, expired/invalid dependency waits and human takeover surface an actionable local fault instead of being treated as completion. Blocked/running dependencies release the slot and remain observable.

Task waits use local persistence rather than the receiver's own Linear comment. The event and original session are saved atomically, target state is checked again under the lock after asynchronous admission, and receipt identity is checked again immediately before execution. Pauses, ownership, executor/wakeup limits, Linear admission, deadlines and the independent outbox still apply. Expired task waits never become remote comment subscriptions. Invalid waits do not retry indefinitely or launch a worker; explicit local correction rearms them while preserving history.

Project snapshot changes are deterministic configuration faults, reported immediately even before a future timer, rather than repeated network errors. Expired windows appear in global alerts with the local owner as next actor; peer replies never extend them. Local execution instructions remain authoritative and are included afresh with machine-readable reply routing on every round. This does not parse arbitrary prose deadlines or silently rewrite old production restrictions. Existing prose-only misrouted waits need explicit conversion, not guessed migration.
