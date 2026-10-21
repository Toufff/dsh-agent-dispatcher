# Product

Confirmed user brief: a local DSH plugin receives work from Linear and routes it among locally configured Codex, DSH and Claude Code executors. Other collaborators assign the human owner, never the local runtime. Detailed development remains in agent sessions.

## Platform

Web panel inside DSH, using the host's React runtime and native navigation. Chinese first. Single local host and one automatic task at a time in version one.

## Primary workflow

Configure local project mappings, order and enable executors, then enable intake. Inspect the queue and results. Stop and take over when needed. Human acceptance is separate from execution completion. The user confirmed a left executor-priority column and right task queue/detail area; no separate project-management board.

## Direction contract

THESIS: explain who will receive work and whether execution is safe to continue.
OWN-WORLD: inherit DSH shell typography and neutral surfaces, with blue selection, amber uncertainty, and explicit state labels.
STORY: configure, dispatch, inspect, intervene, review.
FIRST VIEWPORT: heading and pause control above two columns; executor priority at left, queue and selected task at right. Empty state points to project configuration.
FORM: native operational panel, confirmed by the user. Reordering visibly updates ordinal rank and requires saving.
FINISH: validate keyboard controls, real error and empty states, desktop/mobile rendering, tests and design documentation.
