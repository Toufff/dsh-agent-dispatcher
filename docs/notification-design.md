# Configurable intervention notifications

Status: broader design proposal. The initial Feishu-only implementation is available; see [implemented configuration and limits](feishu-notifications.md). Other channels, the dedicated inbox/settings page, reminders and remote acknowledgements below remain proposals.

## Purpose and boundaries

The scheduler must make actionable stops visible without requiring an open panel. Notification delivery is independent of execution and Linear reporting. A delivered message is not a human acknowledgement, authorization, task resume, or acceptance.

Normal queueing, execution, and expected external waits remain quiet by default. Technical work that is already authorized should continue rather than being classified as a human decision merely to generate a notification.

## Events

| Event | Proposed default |
| --- | --- |
| Genuine human decision or permission required | Notify immediately |
| Wake/continuation limit reached, invalid wait, unclassified result after repair | Notify immediately with recovery action |
| Relevant execution window expired or deadline approaching while blocked | Notify according to configured lead time; never extend permission |
| Repeated monitoring, authentication, or Linear-report failure | Notify after configured threshold |
| Normal wait for a named external producer | Quiet; optional reminder after configured delay |
| Ready for acceptance | Optional immediate notification or digest |
| Previously notified problem resolved | One resolution update |
| Host offline | Only available through a separately configured observer; not claimed by the dead host |

Events carry stable task/issue and phase identifiers, incident ID, revision, severity, reason, responsible actor, requested action, deadline with timezone, allowed next step, and approved evidence links. Missing actor or action is displayed as a routing defect, not invented from a role label.

## Model and delivery

State transition -> persistent incident -> routing rules -> per-channel delivery outbox -> adapter.

- Create the incident and delivery intent atomically with the triggering state transition. A reconciliation pass can repair missing delivery intents after upgrades without replaying tasks.
- Use one incident for the same unresolved cause. Retries, polling, panel refresh, and process restart do not create new incidents. A material change increments its revision. Superseded tasks stop producing current alerts.
- Track delivery separately for each destination: pending, retrying, accepted by provider, failed, or superseded. Provider acceptance does not mean the user read the message.
- Use stable delivery IDs and provider idempotency where supported. Delivery after an ambiguous network timeout may duplicate on providers without idempotency; do not promise exactly-once external delivery.
- Retry transient failures with bounded exponential backoff, jitter and rate-limit handling. Authentication/configuration errors require correction. Notification errors must never reexecute business work.
- Resolve obsolete pending alerts before sending. An independent fallback channel may report primary delivery failure, with recursion suppression and bounded escalation.

## Configurable channels

| Channel | Initial approach | Boundary |
| --- | --- | --- |
| In-app inbox | Durable local list with unread/actionable filters | Available when host and panel are accessible |
| OS desktop notification | Adapter for supported host capability | Show permission/support state; never claim delivered when unsupported |
| Feishu | Outbound signed custom-bot webhook to configured group | No public listener needed for one-way notifications |
| Email | Outbound TLS SMTP or a later explicit provider adapter | Sender, recipients and secret references configured locally |
| Additional integrations | Versioned adapter interface | Destinations configured by user, never by incoming issue content |

Feishu reference: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot

Use provider-specific payload validation, response checks, request timeouts and bounded sizes. Secrets are resolved from local environment/host secret storage; do not serialize webhook tokens, signing secrets or mail passwords into shared settings, Linear, logs, or repository files. Generic webhook destinations, if added later, require explicit destination/network policy and redirect handling; this proposal does not enable arbitrary shell commands.

## Rules and settings UI

Add a Notifications page with Channels, Rules, and Delivery history.

- Channels: display name, provider, local secret reference, destination, enabled status, capability/authentication check, explicit send-test action and last delivery result. Configuration checks do not silently send messages.
- Rules: global defaults with per-project overrides; event types/severity, recipients/channels, timezone, quiet hours, critical-event override, aggregation, reminder interval, maximum reminders, and optional fallback destination.
- Preview which rule matches an example event and exactly what content would be sent. External channels remain disabled until the user chooses destinations and enables them.
- Distinguish Saved, Connection checked, Test accepted, and Real event delivered. Do not render a generic healthy badge for partial checks.
- Configure reminder limits per incident; acknowledgement can stop reminders without resolving the task. Resolution requires current task evidence, not the notification button.

Example notification:

> Task requires your decision
> Project / issue: Example project / EX-42
> Blocked by: two mutually exclusive deployment plans
> Requested action: choose the plan in the authenticated task panel
> Deadline: explicit time and timezone, or none
> Next step after decision: revalidate gates, then resume the registered session

Default external content is a concise shareable summary and approved links, not raw transcripts, commands, credentials, or machine-local paths. Feishu recipient mappings are explicit; Linear names do not automatically identify Feishu accounts. A localhost link works only on the executing device; remote recipients receive the Linear link plus device label and instructions to open the local panel there.

## Interaction and permissions

The first version is notification-only. Users return to Linear or the authenticated local panel to act. A reply of “OK”, an acknowledged alert, or a link click never authorizes production work. Do not require a new public server just to receive a notification.

Future remote decision controls require a separate design for authenticated identities, permitted action scope, expiring one-use decisions, replay protection and audit. They are not implied by enabling a webhook. A separately installed local watchdog can detect a host crash while the computer is awake; computer power-off or loss of all connectivity cannot be reliably alerted from that same computer without an external observer.

## Acceptance scenarios

1. A task enters decision/limit/invalid and creates one durable actionable incident; repeated ticks and restart produce no additional logical alert.
2. A normal external wait stays quiet; configured reminder/quiet hours/timezone behavior is deterministic.
3. Simulated timeout after remote acceptance retains an ambiguous delivery result without launching work again.
4. Rate limits, authentication errors, offline recovery, secondary-channel failure and bounded retry are visible and do not create notification storms.
5. A resolved or superseded incident cannot send stale intervention instructions; acknowledgement alone cannot resume or resolve work.
6. Two channels route independently; failed email cannot block Feishu, Linear reporting or dispatch.
7. Payload redaction, destination scoping and secret-free persistence/logging are verified.
8. Explicit opt-in real delivery is read back for each configured provider. Mock validation is labelled separately from live delivery.

## Suggested sequence

First implement durable incidents, in-app inbox, routing, outbox, local notification capability detection and Feishu adapter. Then add email with the same contract. Keep host-offline monitoring and remote approvals separate. This work must also address accurate stop reasons and stage ownership; notifications cannot compensate for incorrect scheduling state.
