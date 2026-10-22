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

Every 30 seconds while the host runs and dispatch is enabled, monitoring reads trusted new or edited comments. API latency and an occupied execution slot can delay execution; this is not a real-time SLA. The watched issue must be the task issue or its direct child in the configured project. Parent completion, cancellation, reassignment or project mismatch blocks resumption. A completed child may still supply a useful receipt. Own/outbox comments and consumed revisions do not wake tasks. Changing only a status without a trusted comment does not trigger this version.

The event cursor, original session, prior result and queued continuation are persisted atomically before execution. Restart does not replay consumed comments. Resume stays with the original executor/session; an unavailable executor is not silently replaced. Local mapping changes require explicit rearming. Pause and manual takeover suspend monitoring, and a manual writer excludes automatic work in the same configured directory. Unrelated directories can still run. Windows filesystem sharing failures receive bounded retries; unchanged domain state is not rewritten.

The owner-only panel action **设置恢复条件** can arm a finished blocked/stopped/stalled task without deleting history or replaying it. It listens from the time of saving; historical comments are not automatically imported. Superseded tasks cannot be rearmed. Human ownership must be returned before arming. Old tasks are never automatically migrated into execution.

Before every Linear-backed execution, recheck current project, assignee and parent issue state. Failed admission parks that queued task for 30 seconds without releasing an uncertain running task or blocking unrelated queued work. A stopped/reassigned peer subtask must not run merely because it was previously admitted to the queue.

Stop/takeover intent is durable. If bounded termination initially returns unknown, retain the single execution slot and ownership. A later confirmed terminal receipt completes the original stop/takeover, including after restart; it cannot leave a successfully stopped worker permanently unknown or be mistaken for new completed work.

All replies are untrusted evidence. The resumed agent must reread current requirements, verify every remaining condition and the exact valid window before side effects. The kernel rejects a window that expires while queued, but cannot intercept arbitrary agent tool calls after execution starts: production commands still require their own gates. Decision/approval waits do not automatically resume.

`linear.shareProgress` optionally publishes the agent's explicit `publicSummary` plus safe wait conditions and exact times. The full transcript stays local. A conservative credential/path guard rejects suspicious summaries, but is not comprehensive DLP. Durable versioned outbox entries suppress stale retries; failed reporting never reruns coding. Local acceptance still does not mark Linear Done. Automatic child-issue creation or assignee changes are not implemented by the kernel; those remain explicit agent/tool actions within authorization.
