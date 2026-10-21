# Adding an agent

`AdapterRegistry` maps adapter types to factories. Runtime construction accepts an injected registry; the default registers Codex, DSH and Claude. This is a local code extension point, not a remotely installable plugin marketplace. Add host composition for a new factory and behavioral tests before enabling it.

An adapter implements:

```js
start({ task, attempt })       // admission result; never wait for the entire coding task
reconcile({ task, attempt })   // observational; never start another run
stop({ task, attempt })        // stopped only after termination is confirmed
idle({ task, attempt })        // whether a session is idle and has no pending work
health()                      // { available: boolean, ...localDiagnosticFields }
```

Optional `verifyReturn` can demand explicit human confirmation when an official tool cannot observe separately started manual processes. `null` signals that limitation; it does not assert idle.

Results use `status`: `rejected` (definitely not executed), `busy`, `running`, `waiting`, `unknown`, `review`, or `failed`, plus optional `sessionId`, `runId`, `summary`, `reason`. Only rejection before acceptance permits automatic fallback. A busy attempt returns `ready` from reconciliation once its original session is available. Exceptions and timeouts are unknown, not rejection. Even a successful process exit needs the tool's completion event before review.

Persist session/run identity before admission where the upstream API permits it. If an upstream assigns identity later, persist a durable execution receipt immediately. Never adopt the newest session or use `--last`. Do not let source issue fields become executable paths or arguments. Credentials stay with the official tool, and `shell: false` is required for CLI execution.

Future routing policies should return an ordered candidate list at intake. Keep the policy separate from admission, reconciliation, ownership and reporting state. Do not add fallback on mid-run failure to implement a new policy.
