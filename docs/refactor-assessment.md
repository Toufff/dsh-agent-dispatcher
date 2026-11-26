# 派发器重构评估说明（2026-11-26）

> **这份文档的用途**：给另一位 agent 做「是否需要模块化重构」的评估输入。它不是结论，是把系统现状、一天真实运维中暴露的故障模式、以及结构性成因摊开，让评估者判断该不该重构、重构哪一层、代价多大。
>
> **评估者不需要读别的文档就能上手**；需要细节时再按文末「从哪读起」跳转。

## 1. 一句话定位

`dsh-agent-dispatcher` 是一个 DSH 宿主插件：把 Linear 上的 issue 派发成本机 DSH 会话，跟踪每一轮结果，决定是否自动续接，最后把结论回写 Linear。运行在本机唯一一个 DSH web 宿主进程里，被 `~/.dsh/profiles/web/package.json` 以 `link:D:/dsh-agent-dispatcher` 方式加载。

规模：`src/` 共 28 个 `.js` + 6 个 `.jsx`，约 **3,900 行**；`test/` 39 个文件，**346 个用例**；`docs/` 8 篇设计文档。

## 2. 运行时拓扑

```
DSH web 宿主进程（唯一，单实例）
│
├── plugin.js                    ← 装配根：定义 2 个 storage domain、拿目录租约、
│   │                              开 TaskStore/ArchiveStore、new Runtime(...)、注册 remote RPC
│   └── runtime.js  (1185 行)    ← 唯一的「引擎」：什么都在这
│       ├── setInterval(1.5s) → cycle()     ← 整个系统的节拍：一个 1.5 秒的 while(true)
│       ├── command(request)                ← 全部运维动作的唯一入口（submit/stop/pause/configure/retry/continue…）
│       ├── intake / report / assess        ← 进单、回写、结果判读
│       ├── monitor / sweepComments         ← Linear 轮询 + 评论清扫（60s 限流）
│       └── archiveHistory / rotate         ← 轮次折叠与归档
│
├── dispatcher.js  (382)         ← 槽位/并发/状态机（start · reconcile · stop）
├── state-store.js (302)         ← 聚合记录读写 + 归档后端
├── workflow.js    (264)         ← 纯函数：续接策略 continuationPolicy、workItems、轮次
├── adapters/                    ← dsh(254) · cli(94) · worker(124)：三种执行器
├── linear.js(198) / linear-sync.js(115) / notifications.js(192)
└── ui/                          ← client.jsx 等，走 DSH 客户端插件的 HMR 通道
```

持久化：DSH storage domain，`per-record` 布局 —— 一个 task 一份文档。

| 位置 | 内容 | 实测大小 |
|---|---|---|
| `~/.dsh/storages/agent_dispatcher_v2/tasks/` | 热状态：281 份 task 文档 | 28.9 MB |
| `~/.dsh/storages/agent_dispatcher_v2/global.json` | settings / paused / revision | 45 KB |
| `~/.dsh/agent-dispatcher/archive/` | 已折叠的历史轮次 | 669 文件 / 111.6 MB |

节拍：`cycle()` 每 1.5 秒跑一次，一次 cycle 里顺序做「推进派发 → 判读结果 → 续接 → 评论清扫（限流 60s）→ 归档（限流 10min）」。

## 3. 这一天暴露的故障（全部是真实发生、有记录的）

按「症状 → 现场处置 → 触发的结构性问题」列。这些是本机 2026-11-26 一次配置调整过程中连续踩到的。

### 3.1 改一个配置字段 = 重新编译 + 重启宿主 + 打断所有在跑的单

经过：给 `followup` 加一个 `minStagesPerRound` 字段。必须走完整链条：

```
改 src/config.js（zod schema）
  → npm run build（esbuild 出 dist/index.js）
  → 停所有在跑任务
  → 杀掉 DSH 宿主进程
  → 重启宿主（重新 import dist/index.js）
  → 等每个任务的 interrupted 轮次续接回去
  → configure RPC 提交新 settings
```

中间任何一步没做，症状都是**报错指向错误的方向**：schema 没重建 → `configure failed: Unrecognized key "minStagesPerRound"`（看起来像配置错，实际是进程里跑着旧 bundle）。

结构性问题：**配置的 schema 生命周期 = 进程生命周期**。宿主进程启动时把 zod schema 一起 import 进来，之后没有任何「重新加载 schema」的路径。一个纯数据字段的默认值，本质上不该需要重启进程。

### 3.2 配置变更被「有活动任务」拦住，而「活动」的定义是错的

`configure` 的保护条件：任何非终态任务存在时，拒绝修改 project mapping。今天它连续拒绝，理由是有活动任务——但当时实际在跑的只有 1 张单。

根因：`dispatcher.js` 里用**硬编码的字符串集合**判断终态：

```js
export const terminal = new Set(['review','failed','exhausted','stopped','accepted','blocked','decision','stalled','needs_result'])
```

漏了 `'manual'`（人工接管）。于是 **14 张 manual 任务被当成活动任务**，配置改不动。加上 `'manual'` 一个词就通了。

结构性问题：**状态语义靠多处的字面量集合各自维护**。除了 `terminal`，`followup.js`、`outcome.js`、`workflow.js`、`runtime.js` 里还有若干处 `['review','stopped'].includes(...)` 这类集合。新增一个状态值时，没有任何机制强制你更新它们（编译器不管，测试也只覆盖到测过的那几条路径）。

### 3.3 磁盘上的状态不是真相，内存里的是；离线改文件会被覆盖

经过：想直接改 `global.json` 把 `maxAutoRounds` 从 200 改成 6。改完看起来成功了，但宿主关闭时会**用内存状态整份重写**这个文件，改动被无声回滚。只有走 `configure` RPC 才真正持久化。

同类：某个 task 的 `resumeWindow.notBefore` 卡在未来时间导致任务永远排队，改磁盘记录没用（内存里有一份，会盖回去），也没有任何 RPC 能清它，最后只能重启宿主。

结构性问题：**同一份事实有两个写者**（磁盘聚合 vs 进程内 Runtime 状态），且没有「谁是权威」的规则，也没有「重启时合并」的策略。运维者面对的是「看起来能改的文件」和「实际只在内存里的状态」两套东西，而两者长得一样。

### 3.4 快照里显示的值 ≠ 实际生效的值

`configure` 之后，快照里任务的 `autoRoundLimit` 仍显示 **200**（上次评估时写进 task 的展示字段），而真正参与判定的值来自 `settings.followup.maxAutoRounds` = 6。也就是说：**同一个语义量，一份是缓存在 task 里的历史值，一份是每轮现读的 settings**，UI 展示前者、行为用后者。

结构性问题：快照是「给人看的」，但它的字段是系统内部状态的投影，没有区分「当前生效值」和「上次评估时的值」。这类字段每加一个，就多一处可能的展示谎言。

### 3.5 停不掉的单：stop 不敌 1.5 秒的 cycle

今天 LON-35 / LON-160 / LON-284 / LON-299 被 stop 之后，在 12:45–12:56 之间**反复自己重新起来**，停了三轮才停住。触发条件没定位（可能是待执行的 wake、已排队的 continuation chain、或 reconile 把 stop 当成可恢复状态）。

结构性问题：**stop 是一个事件，不是一个状态**。停止意图要穿过「已排队 continuation / pending wake / reconcile 重建」三层才生效，任何一层没检查就会被覆盖。cycle 是个 1.5 秒的轮询循环，它每轮都会重新推导一遍「这个任务该不该跑」，而「用户叫停了」这个事实没有以高优先级的不变量形式参与推导。

### 3.6 `runtime.js` 是唯一的改动热点，也是唯一的冲突热点

1185 行，一个类，**31 个方法**，职责横跨：settings 安装、快照投影、任务提交、RPC 分发、Linear 进单、结果判读、会话轮换、重试、续接、monitor、评论清扫（含 Linear 429 限流参数）、data wake、输出超限重试、归档、cycle 调度。

实际后果：
- 今天三个互不相关的改动（`minStagesPerRound` 传参、`interrupted` 续接、`terminal` 集合）全部落在 `runtime.js` / `dispatcher.js` 上，改动彼此需要串行验证；
- 想验证「重启后 in-flight 任务能否续接」，除了真的重启宿主没有别的办法——因为没有单进程内可注入的 cycle 边界；
- esbuild 只出 `dist/index.js` 一个 bundle，改动后**无法按模块确认符号是否真的进了 bundle**，只能 `grep dist/index.js` 猜。

### 3.7 一次重启的附带损害：所有在跑的单

重启宿主 → 所有在跑会话的 turn 被打断（`turn/end(interrupted)`）。今天为此专门加了「重启中断的轮次续接同一会话，不再停在 unknown」（commit `cccae34` / `e525c31`）。这是**必要的补丁**，但它把「重启」从「运维动作」变成了「会影响业务正确性的动作」——每次重启都是一次对全部在跑任务的扰动，且扰动后的语义要单独设计。

## 4. 结构性成因（我的读法，供评估者校正）

1. **进程生命周期绑死了太多东西**：配置 schema、bundle 代码、内存中的任务状态、正在跑的会话。四者只有「重启整个进程」一条同步路径。
2. **状态没有单一权威**：磁盘聚合、内存 Runtime、task 内缓存字段，三处都可能是一个语义量的家。
3. **语义常量散落在字面量里**：状态集合、终态集合、可续接状态集合，没有一处声明式的状态表。
4. **一个 1185 行的引擎类**承担了调度、领域判定和 IO 适配三种不同变化速率的东西。变化最慢的是状态机语义，最快的是 Linear 限流参数，它们现在住在一起。
5. **没有面向运维的命令面**：`command()` 有十几个 action，但缺「清 resume 窗口」「停止并冻结」「重新加载 settings」「导出某个 task 的判定依据」这类日常动作，于是运维只能去改文件或重启。

## 5. 评估时建议先回答的问题

按「先定性、再定量」排：

**A. 该不该做**
- A1. 上面 7 个故障，有几个是「重构能消除」的，有几个是「设计本来如此、只能加护栏」的？（我的判断：3.1/3.2/3.3/3.4/3.6 可消除；3.5/3.7 更像护栏问题）
- A2. 现在这套系统的**变化速率**在哪：一周内改了哪些文件、几次重启？如果 `runtime.js` 每周都改，重构收益随时间线性增长；如果一个月不动，收益接近零。
- A3. 单人维护 vs 多人/AI 并行改？AI 并行改一个 1185 行的类是冲突放大器。

**B. 如果做，做到哪一层**（建议按投入产出排序，逐层判定是否值得）
- B1. **零风险的语义归并**：把 `terminal`、可续接状态、结果状态集合收敛成一张声明式状态表，所有 `includes` 从表里取。半天工作量，直接消灭 3.2 这类故障。**是否应该无条件先做？**
- B2. **补运维命令面**：`clearResume` / `stop --freeze` / `reloadSettings` / `explain <task>`（打印某任务当前判定依据：读的哪个 settings、算出的 repeat/idle/stop）。不碰架构，纯加 RPC。能否靠这个把「重启」从日常运维里挤出去？
- B3. **拆 `runtime.js`**：按 cycle 阶段切成 `runtime/{dispatch,assess,comments,archive,newsession}.js`，`Runtime` 只留编排和一个显式的 phase 列表。收益是可单测、可单独改；代价是 1185 行的一次性搬迁 + 346 个测试要重新对位。**拆到什么粒度是够的？按阶段拆 vs 按领域拆（execution / assessment / comments / archive）？**
- B4. **配置与 schema 解耦**：settings 走「版本化 schema + 未知键透传 + 每 cycle 从 store 重读」，让加字段不再需要在新 bundle 上重启；旧 bundle 读到新字段不报错，只是不生效。风险是「不生效」的静默性 —— 是否可接受，需要设计一个「本进程不认识的设置项」告警。
- B5. **热重载 plugin bundle**：技术上要绕过 DSH 的 `Service.init` 生命周期和 `ctx.effect` 清理，且要处理 storage domain 句柄与目录租约的交接。**我的判断是不值得**，正确方向是缩小重启的爆炸半径（drain → 不接新单 → 等当前 turn → 持久化中断点 → 重启 → 自动续接），而不是追求不重启。评估者是否同意？
- B6. **重启语义做成一等公民**：把「重启会打断在跑会话」变成显式的 `drain` 流程（命令 + UI + 状态），而不是靠人记得先 stop。和 B5 二选一。

**C. 不该动的（重构必须保住的载荷）**
`docs/architecture.md` 里的 kernel invariants 是过去踩坑换来的，重构时必须逐条验证仍然成立。至少这几条不能因为拆分而松掉：
- 先持久化 attempt intent 再启动执行器；启动结果不明时**阻塞**而不是重试（否则会双开）；
- pause ≠ stop ≠ blocked 的语义区分；
- 续接预算（连续无进展即停）与「已完成的阶段不能重复充数」；
- 按 (workspace, issue, round) 去重，不按 issue 修改时间去重；
- 一个 DSH domain 只能有一个接收者（目录租约）；
- 结果回写是独立的 durable outbox，Linear 失败不得重跑编码。

## 6. 判据建议（评估者可用）

如果要给出「值得/不值得重构」的结论，希望能看到这几项：

| 判据 | 怎么量 |
|---|---|
| 改动成本 | 过去 30 天，改一个「配置/策略类」需求平均要动几个文件、几次重启 |
| 故障成本 | 过去 30 天，3.1–3.7 里各类故障各发生几次、每次花了多久 |
| 重构收益 | B1/B2/B3/B4 各能消灭上面几条；不做的代价是「每小时运维 x 分钟」 |
| 重构风险 | 346 个测试的覆盖盲区（尤其重启/中断/并发路径）；回滚路径 |
| 增量可验证性 | 能不能分 4 步落地，每步独立可发布、可回滚 |

## 7. 从哪读起

| 想知道 | 读 |
|---|---|
| 设计意图与 kernel invariants | `docs/architecture.md`（必读，尤其「Kernel invariants」「Result assessment and bounded continuation」「Durable external waits」） |
| 续接/轮次/预算的判定细节 | `docs/workflow-continuity.md` |
| 验收范围与已知缺口 | `docs/acceptance.md` |
| 实际事故复盘 | `docs/incident-review.md` |
| 三个执行器的契约 | `docs/adapters.md` |
| 代码入口 | `src/plugin.js`（71 行，装配根，读它能看清全部依赖）→ `src/runtime.js` |
| 纯函数逻辑（最好测的部分） | `src/workflow.js`（264 行，续接策略在这里，已有专门测试 `test/workflow.test.js`） |

## 8. 附：当前工作区状态（评估者勿误改）

`git status` 有未提交改动，是今天这次运维的产物（`minStagesPerRound` 相关）：`src/config.js`、`src/dispatcher.js`、`src/runtime.js`、`src/workflow.js`、`test/workflow.test.js`。已经部署并在跑（346/346 测试通过）。评估期间**不要回滚这些改动**。
