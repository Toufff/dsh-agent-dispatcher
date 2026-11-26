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

### Settings fields this build does not know

`configure` validates every field the running bundle knows strictly (wrong types, ranges and enums are still rejected). A field it does not know — typically one added by a newer build whose `dist/` has not been reloaded yet, or left by an older one — is no longer rejected with `Unrecognized key`: it is stored verbatim, survives later `configure` calls and host restarts, and has no effect in this process. The snapshot (and therefore every command response, including `configure`) lists such fields in `settingsUnknownKeys`, as paths like `futureFlag`, `projects[<project id>].followup.<key>` or `executors[<executor id>].<key>`. A non-empty list means "this process does not understand these settings — rebuild/restart the host for them to take effect". The list sits beside `settings`, not inside it, so sending `snapshot.settings` back to `configure` does not store it. Changing an unknown field inside a project mapping still counts as a mapping change for running tasks (stop them first), because a later build will apply it.

## Linear

The header has a separate **检查 Linear 连接** button. It reports the authenticated account/workspace, success or failure, and check time without taking in issues or launching agents. This checks identity/catalog read access, not write permission. The header also states the current API-key authentication and 30-second polling mode. OAuth and webhooks are not configured by this version; changing authentication alone would not enable push delivery.

Queue **项目** options represent Linear workspace/project identities, combining multiple local mappings of the same project. Use **映射用途** in settings to classify business, test or archive mappings; **显示范围** defaults to business and keeps test/history available separately. This classification changes display only, not intake/follow-up switches. Run a connection check to load real Linear names; until then local labels are explicitly marked unverified.

In the project form, select **为此项目配置 Linear**, enter the name of a credential environment variable already configured for the DSH host, and click **检查连接并读取项目**. The authenticated read-only request retrieves the current account/workspace, accessible projects, members and workflow states. Choose them by name; state labels include the team. Loading this catalog never enables dispatch, creates an issue or changes an assignee. A different workspace is rejected for an existing mapping. Metadata is not persisted as authoritative identity, and a failed refresh removes the verified-connection indicator.

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

Intake polls every 30 seconds while the host runs; **检查新工单** performs an immediate intake check. Pause prevents new automatic execution, but does not stop the currently executing task or disable polling. Disable the mapping to stop intake. One active receiver per human/project is supported. Do not run this mapping simultaneously on multiple machines.

Deduplication uses workspace + issue + explicit `round`, never `updatedAt`. Returning an issue to the ready state does not automatically run the same round again. Use local retry, or deliberately advance the round for a new dispatch cycle. Changing a project's round affects every eligible issue in that project.

Classified completion queues a privacy-preserving comment and moves the issue to the configured review state. Starts and execution failures also receive deduplicated status updates. Raw output, local paths, session IDs and executor names are not sent. Opt-in `shareProgress` can publish an explicit shareable business summary. Outbox retries retain a client-generated comment ID and do not rerun coding. Completed/canceled issues are not moved backward. **本地确认验收** records local acceptance; mark the issue Done in Linear when appropriate.

### 机器人账号（委派接单）

本机可以改用 Linear OAuth 应用（app user，不占付费席位）接单和回写：工单**委派（delegate）给机器人**才接，评论由机器人署名发出。开关在设置顶层的 `linear` 块里，和 `includeUnassigned` 一样**不改 `project.linear`**，所以切换和回滚都不需要先停任务：在办任务的身份（工作区 + 工单 id + round）、去重和等待都不变。

```json
"linear": {
  "credentials": [
    { "id": "tnk", "mode": "clientCredentials",
      "clientIdEnv": "LINEAR_TNK_CLIENT_ID", "clientSecretEnv": "LINEAR_TNK_CLIENT_SECRET",
      "scope": "read,write,app:assignable,app:mentionable",
      "botUserId": "<机器人 app user id>" }
  ],
  "projects": [
    { "projectId": "<本地项目 id>", "credential": "tnk", "intake": { "by": "delegate" } }
  ]
}
```

- **凭据**：只填环境变量**名**，不填值。`mode` 可选 `clientCredentials`（OAuth 客户端凭据）或 `apiKey`（`tokenEnv`，个人密钥）。委派接单或 `commentTrust: "bot"` 的绑定**必须**用带 `botUserId` 的 `clientCredentials` 凭据，`botUserId` 也不能是 owner 账号，否则设置保存不通过；`apiKey` 只用于旧方式绑定。凭据可以按项目引用（`credential`），也可以写 `"default": true`（可带 `workspaceId`）给同工作区未指定凭据的绑定用。凭据环境变量和 `tokenEnv` 一样不会传给执行器子进程。
- **令牌**：向固定的官方地址 `https://api.linear.app/oauth/token` 以 `grant_type=client_credentials` 取 Bearer 令牌（30 天）。令牌只放内存，不落盘；剩余不到 3 天（令牌有效期短于 6 天时为有效期的一半）时提前刷新，并发请求只刷新一次；GraphQL 返回 401（或 `AUTHENTICATION_ERROR`）时丢弃令牌、刷新后重试一次；新令牌又被拒绝时按 1 分钟起指数退避（最长 30 分钟），退避期内直接关闭、不再请求令牌接口，直到某次请求被接受才清零（应用被撤权、scope 不足、令牌被别的进程重新签发而作废时不会来回刷令牌）。刷新失败但旧令牌仍有效时继续用旧令牌；没有有效令牌时**一律关闭**：不接单、不读评论，回写留在发件箱稍后重试，原因显示在面板错误和快照 `linearIdentity`（只有到期时间，没有令牌）。令牌接口失败后按 1 分钟起指数退避，不会反复请求。
- **身份**：启动和保存设置时查询 `viewer { id app }`，结果在快照 `linearIdentity`。配了 `botUserId` 而实际身份不同、`viewer.app` 不是 `true`（个人密钥或人的账号），或凭据属于别的工作区时报错并关闭：不接单、不读评论、不回写。
- **接单**：`intake.by` = `assignee`（旧方式，默认）或 `delegate`（`delegate.id` = 机器人 id，其余项目 / 状态 / since 过滤和启动前复核不变）。委派模式下启动前复核也要求工单仍委派给机器人。
- **评论信任**（委派模式默认 `commentTrust: "bot"`）：机器人自己发的评论是自身，永不唤醒；`followup.commentAuthorIds` 和 owner 账号（`ownerUserIds`，默认本项目 `linear.assigneeId`，即 Touf）是可信来源，按作者 id 判断，本轮进行中发的也收（并入下一轮）、本轮结束后发的照常续办；其他人的评论一律不算，哪怕带 `owner：` 前缀。**过渡保护**（绑定 `selfPrefixGuard`，默认开）：Touf 的个人账号仍是手动会话、研究主管等自动化共用的账号，它们的评论都以 `followup.selfCommentPrefix`（默认 `ZRSTUDIO`，不分大小写）开头；这样的评论不论谁发、不论本轮进行中还是结束后，都算自身、不唤醒，与 quant-mining push-queue 机器人模式的 `Get-LinearCommentClass` 一致。等所有自动化都改用机器人发评论后，再把 `selfPrefixGuard` 设为 `false`。结构化等待在机器人模式下可以把 owner 声明为预期回复人（被排除的只有机器人自己；旧方式仍排除 `linear.assigneeId`）。等待外部条件期间只有 owner 的评论能结束等待，协作者回复仍交给结构化等待监控。`commentTrust: "legacy"` 可以在委派接单时仍用旧的前缀规则。
- **回写**：评论用机器人令牌发出，由机器人署名。合并回写的抬头在机器人模式下不再加 `ZRSTUDIO：`；需要时用绑定的 `reportPrefix` 指定。执行器自己写在 `publicSummary` 里的前缀由仓库规则决定，派发器不改。
- **限流**：同步仍是单飞、评论扫描仍每 60 秒一次；机器人有自己独立的 Linear 额度，不再和个人账号共用。
- **旧方式**：不在 `linear.projects` 里列出的项目完全按旧规则（共享账号前缀协议 `selfCommentPrefix` / `ownerCommentPrefix` / `trustReceiverComments`、个人密钥、按 assignee 接单），行为不变。

**切换步骤**

0. **部署顺序**：quant-mining 侧（`config/linear-bot.json` 的 `mode`，研究主管和 push-queue）要**先于或同时**切到机器人。派发器先切、quant-mining 仍用共享账号时，共享账号发的评论靠上面的过渡保护（`ZRSTUDIO` 前缀算自身）挡住；没带这个前缀的共享账号评论会被当成 owner 评论。上线前只读确认 Linear 的 `client_credentials` 再签发会不会作废旧令牌：如果会，派发器、研究主管、push-queue 不能各自换令牌，要共用一个令牌或各用一个 OAuth 应用。
1. 在启动 DSH 的环境里配好 `LINEAR_TNK_CLIENT_ID` / `LINEAR_TNK_CLIENT_SECRET`（私有启动脚本或密钥管理器），重启宿主后才读得到。
2. 先只加 `credentials`（带 `botUserId`）和一条 `"intake": { "by": "assignee" }`、`"commentTrust": "legacy"` 的绑定，看快照 `linearIdentity` 的 `viewer.id` 与 `app: true`、没有错误。
3. 跑迁移预演，列出在办工单：
   `node scripts/delegate-migration.mjs --state <状态导出.json> --project <本地项目 id> --bot <机器人 id> [--token-env <只读密钥变量名>]`
   默认只打印计划、不改任何东西。`--bot` 先和状态里配置的 `botUserId` 核对；带 `--token-env` 时再只读确认它是应用账号（`user.app`），并只读查询每张单当前的 delegate，同时列出项目里**处于 Ready、仍只指派给 Touf、没有委派给机器人、本地还没有任务**的单（切换后这些单不会被接，要一起委派）。不带 `--token-env` 时这一类单列不出来，脚本会提示。状态文件用 `scripts/export-legacy-state.js` 导出。
4. 由 owner 在 Linear 把这些在办工单委派给机器人（或 owner 自己运行带 `--apply --i-understand` 的脚本；这一步**只由 owner 运行**，派发器和执行代理不运行）。没委派的在办工单在委派模式下会被启动前复核拦下，不会被错跑。
5. 把绑定改成 `"intake": { "by": "delegate" }`（去掉 `commentTrust` 即按机器人规则）。保存后同步游标自动重建，已有任务不受影响。

**回滚**：删掉 `linear.projects` 里该项目的绑定（或整个 `linear` 块）并保存，立即回到个人密钥 + 按 assignee 接单 + 前缀协议；在办任务不受影响。工单上的 delegate 留着也无害。

## Sessions and intervention

An invalid Linear wait target is shown as **等待目标需要修正**, not an endlessly retrying connection failure. Targets must be the current issue or its direct child in the mapped project. Manual save validates this before replacing the old wait; the previous evidence and attempts remain. Network failures still retry. Correcting a target begins listening for new replies after saving unless the unchanged-target cursor-preservation option is selected.

- **View:** DSH sessions open directly from the task. For Codex use `codex resume SESSION_ID`; for Claude use `claude --resume SESSION_ID`. These official sessions persist outside the dispatcher. Automatic appearance in the Codex desktop sidebar is not guaranteed; Claude Desktop transfer is optional and not live-tested here.
- **Takeover:** stops owned work before transferring ownership. Automatic work in the same configured directory remains blocked while a task is manually owned. Unrelated directories can run. DSH removes dispatcher-owned queued prompts before cancelling the current turn and preserves unrelated queued input.
- **Return:** finish manual work and confirm this in the panel. DSH checks idle/queue state. Official CLI processes started manually have no dispatcher-owned lease, so CLI return additionally relies on your explicit confirmation that the manual session ended.
- **Retry:** allowed only after confirmed stop or terminal failure. Once an agent accepted the task, retry remains on that executor and resumes its recorded session. Starting with a different agent is a new explicit task/handoff, not a silent fallback.
- **Busy (residual queue):** a resumed round waits (`busy`) while its DSH session has a turn running or queued input. When the session has been idle (no active turn) for `residualNoticeMinutes` (DSH executor config, default 10; counted in memory, so a host restart restarts the clock) and is still held only by queued items, the dispatcher checks each item. If every one is a provable system notice — source kind `tool-jobs`, `time-context`, `runtime-context`, `working-directory` or `repeat-tool-reminder`, with no prompt correlation (`rpcId`) and no submitting principal — it removes them from the queue (the same removal `session/updateQueue` does by hand), records a `residual-notices-cleared` task event with the removed ids and kinds, and requeues the round. Anything else (any `user` prompt, dispatcher or manual; approval or question replies; `schedule`; `tool-goal`; unknown kinds) is left in place: the attempt gets `stuck` (`residual-queue-ambiguous` event, once) and the panel errors list the kinds, for a person to clear the queue.
- **Unknown:** a missing acknowledgement or ambiguous termination blocks the task. Reconcile it; do not start a duplicate. An approval/permission interruption must be resolved in the original tool or by takeover, never by changing executors to bypass the approval.

- **Stop holds the task:** a user stop (`{action:'stop', id, reason?}`) persists `task.hold = {by:'user', reason, at}` before the executor is asked to stop. While held, nothing automatic starts, requeues, continues or wakes the task or its issue: owner/collaborator comments (including comments queued while the round ran), data-version wakes, condition/timer wakes, fresh-session rescue and format repair, output-limit retries, intake of a new dispatch round, and a host restart that interrupts an unconfirmed stop (it settles as stopped instead of resuming). Only an explicit owner action clears it: **retry**, **continue**, **submit** of the same issue, **设置恢复条件** (arm-wait), or **解除冻结** (`{action:'unhold', id}`). After unhold the task is handled normally again: a comment that arrived during the hold can then resume it. Tasks stopped before this version are **not** held by default (same behaviour as before). `userStopCandidates(state)` in `src/explain.js` lists the ones that would be (latest stop/return/unhold event is a stop); after the owner has reviewed that list, starting the host once with `DISPATCH_MIGRATE_USER_STOPS=1` (optionally `DISPATCH_MIGRATE_USER_STOPS_DAYS=N` to only take stops of the last N days) gives them the hold (event `hold-migrated`). The upgrade runs at most once per state (`state.upgrades.userHoldsMigrated`), so a later unhold is not undone by a restart.

### Ops commands

All go through the authenticated `agentDispatcher/command` RPC (owner only); the panel shows **排空**, **解除冻结** and **清除排队时段** buttons where they apply.

| Command | Effect |
| --- | --- |
| `{action:'explain', id}` | Read-only. Returns the decision inputs in force now: `settings` (paused, drain, concurrency, and the effective `followup` values from the current settings revision with defaults applied), `counters` (autoRounds, idle rounds, wakeups, review wakeups/audits, session rounds, each with its effective limit), `lastEvaluated` (values a task cached at its last assessment, e.g. `autoRoundLimit`, labelled as such), `holds` (`hold`, `pendingStop`), `pending` (wait, resumeWindow and whether it is in the future, admission backoff, queued comments/rounds, continuation task), `runnable` (`runnableNow` plus every reason it would not start on the next tick: status, hold, drain, pause, queue window, admission backoff, manual writer in the same directory, concurrency/slot), and the last ten events. Linear admission is rechecked at start and is not evaluated by explain. Works on archived tasks. |
| `{action:'clear-resume', id, expiry?}` | Removes a task's queue window `resumeWindow.notBefore` and any admission backoff so it can be scheduled; `expiry: true` also removes `expiresAt`. The previous values are recorded in a `clear-resume` event. Does not change a structured wait (`task.wait`); rearm that explicitly. |
| `{action:'drain', reason?}` / `{action:'undrain'}` | Persisted `state.drain = {on, at, reason}`. While draining no queued task starts and no new work is created (intake, comment/data continuations, condition wakes, output-limit retries); running turns finish and are reconciled/assessed normally, and a finished round that continues is requeued (it starts after undrain or a restart). Both are logged in `state.opsLog` (last 50). |
| `{action:'unhold', id}` | Clears a user hold (see **Stop holds the task**). |

Snapshot fields for operations (`agentDispatcher/snapshot`):

- `drain`: `{ on: false }` or `{ on: true, at, reason }`.
- `restart`: `{ idleForRestart, idleExceptUncertain, executing: [{id, issue, status}], uncertain: [...], queued }`. `idleForRestart` is true when no task is in an executing status (starting, running, finishing, waiting, busy, stopping, unknown), i.e. a host restart interrupts no turn. `idleExceptUncertain` ignores `unknown` tasks (execution not confirmed). A restart script can `drain`, poll the snapshot until `restart.idleForRestart` (or, deliberately, `idleExceptUncertain`) is true, restart the host, then `undrain` (drain is persisted, so it is still on after the restart).
- Per task, `autoRoundLimit` is the effective limit from current settings; `autoRoundLimitEvaluated` is the value the task cached at its last assessment.

### 聚焦模式

用途：让整个系统暂时只做你主动要求的单子，但不让系统停摆。开启后，**聚焦单和判定为相关的单照常全自动**（自动续办、评论唤醒、定时/条件唤醒、数据唤醒、换会话、新会话救援都不变）；**其他单不再启动，但不丢**：它们的下一轮照常排队，只是被冻结在队列里（`task.hold = {by:'focus', reason, revision, at}`），退出聚焦后自动恢复原来的行为。

**命令**（都走 `agentDispatcher/command`；面板左栏「聚焦模式」有对应按钮）：

| 命令 | 作用 |
| --- | --- |
| `{action:'focus-set', issues:['LON-35','LON-160'], intent:'今天只推进…'}` | 开启聚焦（或整体替换清单与意图）。`intent` 是给模型判定看的自由文本。 |
| `{action:'focus-add', issues:[...]}` / `{action:'focus-remove', issues:[...]}` | 追加 / 移出聚焦单（需已开启）。 |
| `{action:'focus-clear'}` | 退出聚焦：释放全部聚焦冻结，各单回到原来的行为。 |
| `{action:'focus-approve', issue:'LON-48'}` | 把待确认的单（连同它续办链上的单号）加入聚焦，按相关处理。 |
| `{action:'focus-reject', issue:'LON-48'}` | 判定为不相关：保持冻结，直到聚焦清单重设（`focus-set`）或退出聚焦。 |

每次聚焦变化都把 `revision` 加一，旧的判定结果作废、按新清单重判。聚焦状态存在 `state.focus`（持久化，宿主重启后仍在），快照的 `focus` 字段给出 `{enabled, issues, intent, revision, since, pending, decisions, held, rejected}`；`pending` 是待你确认的单及原因，`held` 是被聚焦冻结的任务。所有命令记入 `state.opsLog`。

**什么算相关**（任何要启动的任务都会判一次；续办、唤醒、新接的单最终都变成排队的一轮，只在启动这一步把关）：

1. 先用确定规则（不调模型，`src/focus.js` 的 `relatedByRules`）：在聚焦清单里；续办链（continuationOf / supersededBy / 同一 rootTask）上有聚焦单；Linear 父单或子单是聚焦单（读 Linear 的 parent / children，只读）；单子标题、描述、最近评论里写了「移交 / 接管 / 转交 / 拆单 / split_issue」到某个聚焦单，或聚焦单里写了移交 / 拆单到这张单；**标题**里提到了聚焦单号（按单号边界匹配，`LON-3` 不会命中 `LON-35`）。描述、评论和派发器拼出的 prompt 里只是提到聚焦单号（常见于引用 LON-28、LON-221 作基准）不直接放行，只作为 `candidate.mentions` 提示交给判定程序（线上 279 条任务实测：聚焦 LON-28 时直接放行从 188 个 issue 降到 10 个）。本机手动提交、没有 Linear 单的任务算相关；宿主重启打断的那一轮允许跑完。
2. 规则判断不了的，交给模型判定（异步、同一时间只判一张、从不阻塞调度循环；结果按「单号 + revision」缓存并带理由持久化）。判定程序只能在本机设置里配，不能来自单子：

   ```json
   "focus": { "judge": { "command": "node", "args": ["D:/dsh-agent-dispatcher/scripts/focus-judge.mjs", "--key-env", "LEIHUO_API_KEY", "--gateway", "https://<网关>/v1/chat/completions", "--model", "deepseek-flash"], "timeoutMs": 60000 } }
   ```

   程序从 stdin 读 `{focus:{issues,intent}, candidate:{identifier,title,description 节选,parent,children,最近评论节选,mentions}}`，在 stdout 输出 `{"verdict":"related|unrelated|uncertain","reason":"…"}`。参考实现 `scripts/focus-judge.mjs` 调 OpenAI 兼容网关，密钥和网关地址都只写**环境变量名**（`--key-env`、`--gateway-env`），不会出现在设置或日志里；派发器启动它时会去掉 Linear 令牌环境变量。`settings.focus.linearContext: false` 可关闭 Linear 读取（只用本地任务信息判断）。
3. **失败保守**：判定出错、超时、或回答 `uncertain`，这张单**不启动**，进「待确认」列表（快照 `focus.pending`，面板可点「算相关」/「不相关」）。没配判定程序时，规则判断不了的单也都进待确认。

**冻结与释放**：

- 已经在跑的不相关任务不会被打断，这一轮跑完；它的下一轮（自动续办、评论续办等）排队后被聚焦冻结。已判定不相关的等待中任务，条件 / 定时、评论、数据唤醒都先不接（事件保留，不设 resumeNotice、不占唤醒次数），等聚焦让它变成相关后再接。
- 新增聚焦单（`focus-add`、`focus-approve`、重试 / 继续 / 解除冻结带来的加入）保留本 revision 已判「相关」的结果，只重判「不相关」和待确认的；改 intent、`focus-set`、`focus-remove`、`focus-clear` 全部重判。
- `focus-clear`、`focus-approve`、`focus-add` 让任务变成相关时，聚焦冻结自动释放；**用户停止（`hold.by:'user'`）不受聚焦变化影响**，仍需重试 / 继续 / 解除冻结。
- 聚焦开启时，你对某张单的**重试、继续、解除冻结**会把这张单加入聚焦（这就是你主动要求的单）；派发器自己发起的评论 / 数据续办不会。
- 每个决定都是任务事件：`focus-related`、`focus-judged`（判定结果与理由）、`focus-held`、`focus-pending` / `focus-judging`、`focus-start`（启动时用的规则或判定理由）、`focus-release`。`explain` 的 `focus` 段给出当前判定、是否被聚焦冻结和最近的聚焦事件，`runnable.reasons` 里会写明「聚焦模式：…」。
- 研究主管（quant-mining 的 `research-director.mjs propose`）在聚焦开启时不再提新单，日志写明原因；review / coverage / daily 不受影响。

CLI print mode cannot host every interactive approval UI. If the tool exits for approval, the task is failed and requires manual intervention; if it stays running, the dispatcher keeps its slot occupied. DSH approvals remain in the native session.

## Persistence and recovery

CLI completion first enters **执行完成，正在清理进程**. The queue remains occupied until the owned process closes. After a successful completion record, a CLI that lingers for 15 seconds is terminated; an unconfirmed cleanup stays unknown. Codex additionally checks the matching local session's latest turn event every five seconds, requiring a completion timestamp after this attempt started. This compatibility fallback depends on Codex's local transcript format; missing or unrecognized records never imply completion. Do not run another writer in the same session during automatic execution.

Task state is stored in the DSH `agent_dispatcher_v2` storage domain (per-record layout: one document per task and per pending Linear write-back, plus a small global document). On first start after upgrading, the plugin backs up the old single-document `agent_dispatcher.json` next to itself (`agent_dispatcher.json.bak-<time>`), migrates it and never writes it again; a failed migration stops the plugin instead of starting empty, and restarting reruns it. History leaves the hot state into `<directory>/archive` (append-only, readable by task id): superseded tasks, accepted/stopped tasks that ended more than `settings.archive.taskDays` (default 3) days ago and that nothing references, automatic-round results beyond the latest `keepRounds` (default 3), and finished write-backs after `outboxDays` (default 1). To roll back to a version before this layout, stop the host and run `node scripts/export-legacy-state.js --out <file>`, then put that file in place of `agent_dispatcher.json`. CLI execution receipts live in the plugin's private runtime directory, default `$DSH_HOME/agent-dispatcher` or `~/.dsh/agent-dispatcher`. A custom plugin `directory` config changes the receipt/lock directory. Treat both domain and runtime files as private; they can contain task text and local outputs.

One host owns the runtime directory through `host.lock` (`{ pid, processStartedAt, startedAt }`). Always use the same runtime directory for hosts sharing the same DSH domain storage. Stop the old host before starting another. An abnormal process kill may leave a stale lock; the next start takes it over by itself when the recorded owner is provably gone:

- the recorded PID is not alive, or
- the PID is alive but is a different process (Windows PID reuse): its start time differs from the recorded `processStartedAt` by more than 2 s, or, for locks written before start times were recorded, it started after the lock was written.

The takeover runs under an exclusive `host.lock.takeover` mutex and re-reads the lock before replacing it, so two starting hosts never both win; a mutex left by a host that died mid-takeover is ignored after 60 s. Each takeover appends one JSON line (`action: "host-lock-takeover"`, reason `owner-dead` or `pid-reused`, the previous lock record) to `host-lock-audit.log` in the runtime directory and logs a warning. A live owner, an unreadable lock record, or a live PID whose start time cannot be read (for example access denied) is refused as before. In that case, after verifying the owner is gone:

```sh
node scripts/recover-lock.js /absolute/private/runtime/directory
```

Recovery refuses removal while the recorded PID is alive. It never restarts tasks or deletes session history. On restart, execution intents are reconciled; they are never blindly replayed. Live CLI workers maintain receipts and accept stop requests from a reloaded host. An orphan with no heartbeat stays unknown. Managed locks do not prevent unrelated manual processes from writing to the same project.

## Validation

Each successful execution is classified before reporting: **完成待验收**, **等待外部条件**, **需要决策或授权**, **续办已暂停：进展或次数限制**, or **结果待分类**. Useful authorized local work continues automatically in the original session. New evidence or completion of an existing unfinished stage renews the progress allowance; three continuations without a new checkpoint or forty total continuations stop for review. Repeated evidence, edits to completed stages and invented stages cannot renew the allowance. Evidence remains an executor claim, not acceptance. A missing result contract receives one formatting-only repair per work round with specific validation diagnostics. A stored result that becomes valid after a parser update can recover without rerunning the agent (only non-executing outcomes). History is preserved. These limits are fixed in this version. Pausing prevents any new automatic turn.

Set optional project `executionInstructions` for local restrictions that must survive continuation, such as offline-only validation during trading hours. These are prompt restrictions, not an OS sandbox or a trading-calendar service; they persist until locally changed. Set optional Linear `activeStateId` and/or `blockedStateId` to keep unfinished issues out of review. Without either mapping, unfinished results add a status comment without changing the issue state.

To enable external-condition monitoring, add `followup: {"enabled": true, "commentAuthorIds": ["trusted-linear-user-id"], "maxWakeups": 8}` to the local project. The agent must return a blocked result with a `wait` object; existing finished blocked/stopped/stalled tasks can use **设置恢复条件**. For replies use `{"kind":"linear","expectedAuthorIds":["trusted-linear-user-id"],"condition":"Verify peer receipt","issueId":"child-issue-id"}`. For exact time checks use `{"kind":"time","condition":"Recheck the agreed window","notBefore":"2030-01-02T20:30:00+08:00","expiresAt":"2030-01-02T21:30:00+08:00"}`. These are examples, not live schedules. Keep dispatch enabled and the DSH host running. The panel shows last check, current condition, window and errors. A received comment or elapsed time queues the original session to reassess; it does not grant production permission.

Set `linear.shareProgress: true` only when you want the agent's explicit `publicSummary` and safe wait condition shared with collaborators. Include completed work, next responsible party, required receipt and exact times in that summary; never put credentials or local paths there. The plugin has a conservative disclosure guard but no comprehensive DLP. Full transcripts remain local. See architecture.md for deduplication, ownership and reporting limitations.

Parallel execution is opt-in. Set top-level `"concurrency": N` (1–8) in **高级配置 JSON** for the global cap and `"maxConcurrent": N` on a project to let it run several tasks at once; both default to 1, so omitting them keeps one task at a time. Tasks of one project share its `cwd`, so raise `maxConcurrent` only when the project's instructions make each task write in its own isolated checkout. Changing a project's mapping requires stopping its active tasks first.

Set `followup.reviewComments: true` (panel: **本轮已结束（待验收、受阻或待决策）的单收到可信回复者的新评论时，在原会话自动续办**) to keep working on an issue after feedback. While the current task of an issue has finished its round in review, blocked (without a live structured wait, which the wait monitor handles), decision or needs_result, the host checks that issue every 2 minutes; a comment from a trusted `commentAuthorIds` member (never the receiver/assignee itself, never the plugin's own reports) created after the task was queued starts one continuation in the original session, with the quoted comments as an added owner instruction. When a continuation round starts, the issue only moves back to the active state; no "started" comment is posted (the round's result report follows). Each comment is consumed once; the continuation counts toward `maxWakeups` for the whole chain. When the chain has used `maxWakeups`, the next trusted comment starts an **audit round** in a fresh session (no conversation history; `followup.maxAudits`, default 3): it rebuilds context from the repository and the Linear thread, judges whether the chain still converges or is looping, writes an audit conclusion, and then either does the new requests (the wake-up count starts again at 0) or returns blocked to the owner. Only after `maxAudits` audit rounds is the next comment announced once (a Linear report and a panel error) and held; a manual **继续处理未完成事项** starts a new count. Automatic follow-ups trim the oldest owner instructions (kept in the Linear thread) instead of failing once the instruction history exceeds its size limit; an audit round carries the latest ten. Closed, canceled or reassigned issues, a paused queue and an existing continuation never trigger it. Comments add scope; they do not grant permissions beyond the project restrictions.

The dispatcher owns the full workItems ledger. Each round's prompt lists unfinished items in full and only an index (ID and title, latest 40) of completed ones; a result may omit completed items, which are restored from the stored ledger in their original order, and dependsOn may reference them. Unfinished items must still be reported, and a completed item cannot be reopened. So the per-round result stays small however long a follow-up chain grows; the 200-item schema cap applies to one round's report only.

When the owner uses the same Linear account as the receiver (for example from another device), set `followup.trustReceiverComments: true`: a comment from the receiver account then also continues a settled round, but only when it is not one of this host's reports (outbox id), does not start with `followup.selfCommentPrefix` (default `ZRSTUDIO`; agents must start their own writebacks with it) and was posted after the round settled, so a round's own comments never wake it. A comment that starts with `followup.ownerCommentPrefix` (default `owner`) counts even when posted while the round was running, so an owner instruction sent mid-round is not lost.

Set `followup.dataVersionFile` to an absolute file holding the current data version (for example a snapshot id). When it changes, a current round that settled as blocked, decision or needs_result with an unfinished stage or blocker about data gets one continuation (`data-wake` event) to check whether the data arrived; each version wakes a chain once, counts toward `maxWakeups`, and finished (review) rounds are never woken.

Long chains rotate sessions instead of growing one conversation. `followup.maxSessionRounds` (5–500, unset by default) hands the task to a fresh session after that many automatic rounds in one session. `followup.freshContextTokens` (default 200000; `0` disables) does the same when the session's next request would carry more context than that: before an automatic continuation, a collaborator-comment or data-wake continuation (which then starts in a fresh session but keeps the full owner instruction history, unlike an audit round), and a **重试任务** retry or output-limit retry (the round prompt is kept, with a takeover note in front). The size is read from DSH's token-meter projection (`contextPressure`), falling back to the newest `usage` sample in session history; a read that fails or takes longer than 5 seconds keeps the current session. Executors without a readable context (Codex, Claude) never rotate for size. Size rotation is routine and does not use up the once-per-episode `freshRescue`. Every round's prompt asks the agent to keep `HANDOFF.md` (in `strategies/<issue>-*/` when the task has an issue directory, otherwise the working directory) current and to check `trials.jsonl` before rerunning variants; a fresh session is told to start from those files.

A workItem marked `decision` whose blocker kind is not `permission` (for example an external owner choosing between two paths) is classified as `blocked` instead of failing result validation; the task event records `external-decision-as-blocked`. Only `permission` blockers stay local decisions.

For maintenance startup, `DISPATCH_START_PAUSED=1` persists a paused queue before the host begins cycling. The panel can explicitly resume after configuration is verified.

Set `followup.observeAfterExpiry: true` to keep receiving trusted replies after an execution window expires. The panel and Linear will show a pending reply, but no agent is started and the old window stays expired. Confirm the new timing locally and use **设置恢复条件**. When updating the same watched issue/type during maintenance, check **保留原监听起点** to retain replies received in the meantime; leaving it unchecked ignores older comments. Both modes preserve the consumed execution cursor and prior wait history.

Repeated Linear write failures show an automatic retry count in the panel. Restoring connectivity retries reporting only; it never reruns the coding task. An obsolete report is superseded as soon as a newer task state exists. Sustained unknown execution is reported but never automatically replayed; verify the original session/receipt before intervention.

Completed tasks offer **继续处理未完成事项**. This creates a distinct continuation with the previous result and the original issue link, preserving the old task. Repeated requests on the same parent deduplicate to one continuation. A registered session stays on its original executor even if local priorities changed; disabling that executor prevents the start instead of routing existing work elsewhere. An explicit retry starts a new bounded repair/continuation budget. A continuation is not permission to repeat completed work or override project approval rules.

`npm test`, `npm run check`, and `npm run build` require no agent login. `node scripts/live-smoke.js codex` makes one real subscribed-agent request. Substitute `claude` only when you intend live Claude validation. `scripts/browser-smoke.js` requires an already running isolated DSH host and `DSH_TEST_URL`; it checks the real remote transport and priority save roundtrip using Edge by default. Set `PLAYWRIGHT_CHANNEL` for another installed compatible browser. Keep authentication-bearing URLs out of issues and commits.


### Local task handoffs

Use `{"kind":"task","issueId":"EX-7","condition":"Verify its completed result"}` for another existing task on this receiver, or specify its exact `taskId`. Both tasks must belong to the same local mapping. The panel shows the target and current state; no self-comment or peer forwarding is needed. Completion triggers a verification round in the original session, not automatic human acceptance. Missing/ambiguous targets and dependency cycles are rejected. A stopped/failed/expired dependency requires local correction, and the reason is reported in Linear.

New `linear` waits must include `expectedAuthorIds` from the locally trusted external users. They cannot name the receiver or expand the allowlist. Legacy saved waits without explicit producer IDs retain their evidence but stop monitoring with a configuration alert. Explicitly add the required IDs or convert to `task`; use `preserveCursor` only for the same Linear target if retaining replies from maintenance. Do not use a time trigger to disguise a missing dependency.

A changed project restriction or expired window is an actionable local scheduling fault, not evidence that a collaborator has failed to reply. Correct the local scope/window and rearm explicitly; the plugin never renews production permission from a comment.
