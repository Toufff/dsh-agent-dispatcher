# Feishu task notifications

The host sends outbound messages directly to a Feishu custom group bot. No public webhook receiver or additional server is needed. Notification delivery cannot start, retry, approve or complete an execution. Linear remains the place to review requirements and receipts.

## Local configuration

Save a private JSON file outside the repository, readable only by the host account:

```json
{
  "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/REPLACE-ME",
  "signingSecret": "REPLACE-ME"
}
```

Omit `signingSecret` only when signing is disabled for that bot. Never paste these values into Linear, shared settings, screenshots or commits. Use the group bot's security settings for signing and any keyword/IP restrictions.

In **配置项目与连接 → 高级配置 → 本机配置 JSON**, retain the existing projects and executors and add this global property. Replace the private file path and project IDs with local values, load the draft, then save:

```json
{
  "notifications": {
    "channels": [{
      "id": "my-feishu",
      "type": "feishu",
      "label": "My task notifications",
      "enabled": true,
      "credentialsFile": "/absolute/private/feishu.json",
      "projectIds": ["local-project-id"],
      "includeExisting": false,
      "completed": true
    }]
  }
}
```

This is a fragment, not a replacement for the full settings document. The first version uses the advanced settings editor; a dedicated channel editor, email, OS notifications, reminders, acknowledgement and remote approvals are not implemented. `includeExisting: false` baselines current incidents silently so enabling notifications does not replay historical alerts. `completed` opts into new review-ready messages; those do not mean human acceptance or Linear Done. Test/archive mappings are not selected unless explicitly included in `projectIds`.

## Events and delivery

- Decisions, execution failures, exhausted executors, stalled continuation and unclassified results.
- Invalid/expired waits, wakeup limits, three consecutive monitoring failures, and Linear reports failing at least three times.
- Ordinary external waits and normal polling are quiet. Only the latest local task for each mapped issue is considered; historical continuations do not keep alerting.
- Each incident is persisted with an independent outbox. Polling and restart do not repeat a sent incident. A resolved incident cancels pending retries. A later recurrence can notify again.
- HTTP 429 has a bounded three-attempt budget and respects Retry-After, with at least one minute between retries. Other rejected requests require channel repair. A timeout or host exit during transmission is marked **unknown**, without automatic resend, because Feishu does not offer an exactly-once delivery receipt here.
- Delivery is single-flight in the background, with a five-second request timeout and at least one second between messages. A stalled destination does not hold the execution cycle.
- Notifications include a fixed reason, issue identifier and validated Linear link. Prompts, private summaries, filesystem paths and raw execution output are omitted. Credentials are loaded just in time and never stored in the dispatcher aggregate. Failed/unknown current incidents appear in the panel's error area.

The host must be running to send notifications. This does not provide independent monitoring of a powered-off device. An already-started send may finish after an incident resolves or a channel is disabled; pending messages are canceled before the next send.

Protocol: [Feishu custom bot documentation](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot).
