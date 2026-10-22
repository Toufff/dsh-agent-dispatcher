# Version 0.1 acceptance — 2026-10-21

## Verified

- Result-assessment update (2026-10-22): 46 automated tests pass, including same-session automatic continuation, restart deduplication, pause, a durable three-round ceiling, repeated-progress stopping, one formatting-only repair, completion evidence validation and unfinished-result reporting without forcing review. Browser checks pass for the native host, priority roundtrip and mobile overflow. These tests verify routing behavior; they do not independently prove an agent's business claims.

- DSH 0.2.1-rc.2 web profile loads the host package and browser contribution through the normal plugin loader. The native sidebar opens the panel, authenticated remote methods read/write state, and configuration persists.
- A real native DSH session returned the requested synthetic marker. The result moved to review, and the panel opened the exact original session.
- Takeover, return and retry resumed the same DSH session rather than creating another conversation.
- The official Codex CLI returned a synthetic marker with a persisted session identity. The packaged host worker also executed Codex successfully.
- A dedicated Linear acceptance project/issue was received twice but produced one local task. Real Codex execution completed, exactly one comment was written, and the issue moved to In Review rather than Done. No stock-project code or tasks were used.
- A second explicit test round ran the complete native-host path: Linear intake, native DSH execution and successful Linear review report. Dispatch was paused and the test intake mapping disabled afterwards, retaining the records for human review.
- Automated behavioral tests cover ambiguous start/stop, restart reconciliation, FIFO exclusion, pre-start fallback, configuration conflicts, DSH queue removal, CLI stream parsing for Codex and Claude, incomplete success events, worker stop after adapter reload, Linear workspace mismatch and outbox retry without reexecution.
- GitHub CI passes on Windows and Linux. Native browser tests verify priority save/restore, desktop/mobile rendering and absence of page errors.

## Explicit limits

Completion cleanup regression: real child-process fixtures cover a successful terminal event followed by a lingering process, and a matching Codex session completion without a terminal stdout event. Both require process exit before review. Old completion records, newer unfinished/aborted turns and FIFO exclusion during cleanup have regression coverage.

Receipt recovery regression: injected transient and exhausted write failures now leave later completion writes usable, with bounded retries and error-code-only local diagnostics. Stale heartbeats are detected even when an adapter retains the worker reference. A real Codex marker task passed after the fix. An affected completed session was recovered from its matching original completion record without starting the task again.

Claude Code CLI passed real authenticated execution, packaged DSH-host dispatch, human takeover/return and same-session resume on Windows. Tests used a no-tools, no-file-change marker task. Tool permission prompts, real coding workloads and Claude Desktop visibility were not tested. The default executor remains disabled until locally configured.

One receiving host is supported. There is no distributed exactly-once guarantee, unrestricted external-session discovery or enforcement over manually launched writers. A session view does not itself transfer ownership. CLI manual-return confirmation is an operator assertion where the official runtime exposes no cross-process lease.

Linear reports are intentionally status-only in this version. Detailed summaries/PR links must be reviewed and shared separately. Local acceptance does not change Linear to Done.

Live records contain private workspace/session identifiers and are kept outside the public source tree. Public tests and examples use synthetic data only.
