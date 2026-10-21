# Architecture and implementation sequence

## Ownership

Linear stores human-facing requirements, human assignees and acceptance. Each recipient's local DSH plugin owns routing. A remote issue must not select an executable, command line, local directory or session. Project mappings and enabled executor instances are configured locally.

The first policy is an ordered list of enabled executors and FIFO tasks, with one automatically running task globally. Adapter types are separate from configured executor instances. Later policies can select an ordered candidate list through the same interface without changing execution semantics.

## Kernel invariants

- Persist an attempt intent before starting an executor. Snapshot executor order per task.
- Only a confirmed rejection before execution permits fallback. Busy waits; approvals wait for human action; an uncertain start blocks pending reconciliation.
- A crash after intent persistence does not replay the start. Reconcile the recorded attempt using its stable ID.
- A running failure preserves the workspace and requires an explicit decision. Process exit zero means ready for review, not human acceptance.
- Persist result reporting separately. A failed Linear update must never restart coding.
- Deduplicate intake by workspace, issue and explicit dispatch round, not issue modification time.
- Managed concurrency does not prevent writes by unrelated manual sessions.

## Host integration

Use DSH's storage domain for persistent state, its authenticated remote services for UI actions, and its native client extension points. The initial in-memory test store is deliberately not a production persistence provider. There is no separate unauthenticated HTTP control server.

The host adapter must provide atomic replacement of one aggregate state record and exclusive local ownership. Multiple processes receiving the same project are unsupported until explicit leases are implemented. Browser closure does not stop dispatch; DSH host shutdown does.

## Execution adapters

All adapters implement start and reconciliation; stop must confirm termination before another managed run starts. Session identity, execution identity and task identity are distinct.

| Adapter | Planned transport | Validation |
| --- | --- | --- |
| DSH | Native session controller | Live local test required |
| Codex | Official app-server or CLI protocol | Live local test required |
| Claude Code | Official CLI, stream JSON and resume | Contract tests first; collaborator validates live |

Use official executables with their existing login. Never extract subscription OAuth credentials, proxy subscription model endpoints or share accounts. Invoke commands without a shell. Resume only explicitly registered task sessions; never choose the most recent session heuristically.

DSH cancellation must remove dispatcher-owned queued prompts before cancelling the current turn. An ambiguous stop keeps the task blocked. Viewing a session does not transfer ownership. Takeover stops automatic dispatch, confirms termination and transfers ownership; return requires reconciliation.

## Linear and UI

Intake is explicitly enabled per project and assignee with a selected ready state. Existing backlog requires deliberate import. Tokens remain local; outgoing reports contain business summaries and approved links, never raw local transcripts or paths. Reporting uses a durable outbox with retry independent from execution.

The DSH panel will expose draggable executor priority (plus keyboard controls), enable/disable, health, FIFO queue, attempt history, stop, takeover, return and retry. It does not replace Linear's project dashboard.

## Delivery sequence

1. Scheduling state machine and failure/restart tests (initial commit).
2. DSH storage and remote service integration; persistent queue and ownership.
3. DSH and Codex adapters with isolated live validation; Claude CLI contract tests.
4. Linear intake and result outbox; local project mappings.
5. Native DSH priority editor and task inspection; end-to-end validation.

Do not advertise the plugin as functional until these integration stages pass. Human acceptance remains separate from an agent's completion report.
