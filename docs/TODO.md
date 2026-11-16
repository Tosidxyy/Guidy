# TODO / 验收记录

> 本文件在 M1 重写（4c9cc53）中曾被移除；Task 16 按其 brief 要求重新创建，用于记录 M2 部署与验收。
> 三段证据严格分离：**本地 fixture ≠ 站点发布 ≠ 真实 AI 执行**。ready backend / HTTP 200 **不算** AI 验收，必须有真实 QCA 完成响应。

## M2 — AI 规划闭环（私有部署与验收）

状态：**已完成并发布到 private**。M2 保持私有，公开访问（C3 公开）属 M4。

- 站点：`https://guidy-oxg3oo3dpdz.qoder.zone`（owner 登录态实测）
- projectId `01a1e421-fb6e-756e-a7c8-44fd5a28b23f`；siteId `01a1e421-fb71-7745-9db4-db763e874017`
- 发布 actionId `0510db5b-26f2-4c07-a0b2-483efba0a9af`；function operation `01a1e547-e604-78f5-89c3-4604b6ba54ec`
- 部署 bundle `index-N2D-wdEH.js`（与本地 `npm run build` 产物 hash 一致）
- 验收时 HEAD `6508f26`

### 1. 本地 fixture（credential-free fake，vitest）

`npm run dev:function` 的 fake-db / fake-qca 注入下，路由 / 投影 / 协调 / 引擎单测全绿。

- `npx vitest run`：**17 文件 / 118 测试通过**（含 R6–R9 / R13 / R16–R18：send 顺序与配额、流投影白名单、artifact 重试≤2、游标重连、commit 幂等/无解/hash/version、dispatch 幂等）。
- `npm run check:function`（Deno 类型 gate，`functions/app.ts`）：EXIT 0。
- `npx tsc --noEmit`（随 `npm run build`）：通过。
- 说明：根 tsconfig `exclude` 含 `functions`，故 functions 的类型门禁只由 Deno gate 把守。

### 2. 站点发布（private）

`get_site(include:["backend","functions"])` 实测：

- `lifecycle: active`，`access_mode: private`，`hasPublishedContent: true`，`auth_integration_status: ready`
- backend `status: ready`，capabilities `[database, functions, qoder, storage]`，`database_access_model: function_backend`
- function `app`：runtime `edge`，`database_access: read_write`，`preparation_status: ready`，`is_active: true`，`functionPublicationStatus: published`
- `required_secret_names: []` —— `QODER_PAT` 平台托管，故意省略，**空列表不代表 PAT 缺失**。
- 迁移：Task 10 的 10 表已应用（migration_id `01a1e490-be47-73b3-9db8-408f64339cfb`），发布前重读取得新 `schemaRef`。
- 部署偏差（已裁决）：brief 写 `functionDirectory: functions`，实际用预打包自包含 `build/function-package`（edge-bundler 兼容，见 9a92b80 / 89da30d / ce8ccfb）。

### 3. 真实 AI 执行（owner 浏览器，真实 QCA，非 fixture）

| 用例 | 结论 | 证据 |
| --- | --- | --- |
| T3 匿名身份 | PASS | `GET /api/me` 返回 `visitor_id` + `quotas`；私有数据按访客隔离 |
| C1 send 首事件 | PASS | `POST /chat/send` 202 + 首事件 `accepted`（request_id/conversation_id/seq） |
| C2 流式增量 | PASS | delta 有序拼接=最终 text；artifact 仅在 Schema 校验通过后出现 |
| A2 对话采集 | PASS | PRD §2.2 需求 2 轮产出约束确认卡，含每日上限/忙碌窗口/互斥/偏好四类 + 可编辑任务 |
| A3 确认生成 | PASS | commit 200，服务端重算；7 天日历 28 块/42h，硬约束零违反（每日 360min 精确、数学英语 15min 间隔、周三晚空） |
| C3 断线重连 | PASS | `GET /chat/events?cursor` 回放 seq 唯一，无重复无丢失（修复 restore cursor 后） |
| C4 刷新页面 | PASS | 刷新后仅 GET me/conversations/history/events，**零 POST send** |
| A9 恢复 | PASS | 刷新自动恢复计划与对话，确认卡从历史 artifact 重现，不重发消息 |
| C5 interrupt | PASS | 流式中点「中断生成」→ `POST /chat/interrupt` 200，reader 取消，streaming 停止，可继续新消息 |
| C6 新建对话旧流未结束 | PASS | 流式中点「新建对话」→ 旧 reader 取消，视图清空（bodyText 96），旧 seq 不写入新视图；随后新会话 `7007fd9b` 正常 |
| C7 artifact 校验失败 | 单测覆盖 | 投影器重试≤2 与 `artifact_invalid` 由 vitest 覆盖；真实 AI 修复 prompt 契约后**首次即校验通过**，部署侧未触发重试路径 |
| SEC3 凭据 | PASS | 客户端 bundle、SSE 帧、history、`/me` 均无 PAT/secret/token；PAT 仅 `functions/qca/cloud-agents.mjs:21` 经 `Deno.env.get('QODER_PAT')` 读取，只发往 QCA origin，不回显、不入日志、不进 secretNames |

#### T4 流式延迟（accepted→首个 delta，5 次）

| 样本 | ms |
| --- | --- |
| A | 2937 |
| B | 1913 |
| E | 2579 |
| F | 2055 |
| G | 2038 |

排序 1913 / 2038 / 2055 / 2579 / 2937；P95≈2937ms **< 3s 目标**，均值≈2304ms。逐条转发不缓冲全文（Task 7 投影保证）。

#### 本轮修复（真实 AI 验收暴露）

- `c657691` fix(prompt)：把 AI 产物契约逐字钉到 Schema（frequency 对象形态、high|mid|low、daily_cap.max_minutes、mutex.subjects/mode、busy_window.weekday+start/end、preferred_period.strength:'soft'），并内嵌 schema-valid 示例。修复前三次真实发送均 `artifact_invalid`（AI 自创 frequency:"daily"/priority:"medium"/max_minutes_per_day 等），修复后首次即通过。
- `6508f26` fix(chat)：恢复会话时 cursor 须越过已加载历史最大 seq（`cursorAfterMessages`），否则 resume 重放历史把全文再追加一遍（C3/A9 文本重复缺陷）。

#### 观察（未修复，YAGNI）

- assistant 文本气泡在确认卡上方显示原始 JSON（MessageBubble 对 kind=text 走 ReactMarkdown）。属展示瑕疵，不影响验收；如后续优化可在投影侧把产物 JSON 与可读文本分离。
- 复用被中断的会话立即再发送，偶发 QCA `upstream_error`（seq19， transient）；新建对话会开启全新 QCA 会话规避。错误未污染 UI（reset 已清 store）。

### 验收截图（build/，git-ignored）

`a2-confirm.png` / `a2-card.png` / `a3-calendar.png` / `a9-restore.png` / `c6-newconv.png`；门禁日志 `build/gates-final.log`。

## M2 增强 — 自由对话 agent（意图分流）

状态：**已实现并发布到 private**。commit `f6550e8`；发布 actionId `fb8e98bb-9195-498a-9dbf-64badc74edca`（publish op `01a1e563-d850-7141-a323-0b827799fb23`，committed）；部署 bundle `index-DXsSocaf.js`。

起因：旧 prompt 强制每轮输出产物（`buildUserMessage` 无计划时硬塞「请生成 constraint_set」+「产物只输出一个 JSON」+ 唯一考研数学范例），导致问「你是什么模型」也被套成数学计划。

改动（后端/schema/确认卡/日历零改动，纯 prompt 策略 + 开场白）：
- `functions/prompt.ts`：身份守卫（只以 Guidy 助手作答，不透露底层模型）+ 意图分流（闲聊/元问题→自然语言不输出产物；信息不足→自然语言追问每轮≤2；目标明确且信息足够→才输出 constraint_set；改计划→patch）；范例标注「仅示范形状，禁止照抄范例科目」；无计划上下文改中性「当前还没有计划。」。
- `components/chat/ChatPanel.tsx`：静态开场改为问句「你想制定什么方案？…信息够了就在下方生成计划。」。
- TDD：`artifacts.test.ts` 先 RED（6 条策略断言）→ GREEN；全量 123 测试通过，check:function/build EXIT 0。

真实 AI 浏览器实测（owner，private，三条路径全过）：
1. 问「你是什么模型」→ accepted/status/done，**无 artifact、无卡**；答「我是 Guidy 排程助手…要不要聊聊你想排什么？」。
2. 模糊目标「我想做个学习计划」→ **无 artifact、无卡**；自然语言追问 2 个（学什么/每天多久+忙碌时段）。
3. 具体目标（数学120/英语90 daily、08–22 有空、周三18–22 兼职、数学英语不连续、偏好早上数学）→ artifact（残留 1 澄清→「还需要确认」框，卡暂不出）；答澄清后 → artifact clarifications 清空 → **确认卡自动出现**「核对约束方案」：任务2 + 约束5（active 08–22 / 周三 busy 18–22 兼职 / math·english no_adjacent soft / math 早晨 / english 下午）+ 取消/确认并生成。

证据：`build/chat-agent-card.png`、`build/gates-chat.log`。

观察（仍未修复，YAGNI）：assistant 文本气泡在卡上方显示原始 JSON，自由对话下更明显；如后续优化可在投影侧把产物 JSON 与可读文本分离（不影响本次行为验收）。

## M2 修复 — 新建对话被旧计划劫持恢复

状态：**已修复并本地验证，待发布到 private**。commit `ac1a0d9`。

用户报告：「为什么我新建了一个，又自动生成数学」。

根因（系统化调试 + live 复现确认，非 prompt 问题）：
- 后端 `chatSend` 从不带 `plan_id`（chatController.ts:36），`buildUserMessage` 恒走「当前还没有计划」；QCA 会话按对话绑定（sessions.ts:20），新对话 createSession 全新会话；系统提示 baked 进 agent 定义且指纹随 prompt 变（live.ts:27 / cloud-agents.mjs ensureCloudResources）——服务端不会把数学上下文带进新对话。
- 真正根因在前端：`ChatPanel` 恢复 effect 旧 deps 只有 `[conversations.data]`，判据仅 `!conversationId`。`newConversation()` 只 `reset()` 把 `conversationId` 置 null，与「首次加载需恢复」无法区分。QueryClient `staleTime:30_000` + 默认 `refetchOnWindowFocus`，conversations 在 stale 后 refetch（或发送竞态）使引用变化时，effect 把 `items[0]`（最近一条旧数学对话，含 constraint_set 确认卡）`api.history + setConversation` 拉回，劫持新对话。
- live 复现：点新建对话清空后发「你是什么模型」，聊天却出现整段旧数学对话历史（未重打）——只有恢复 effect 能做到。

修复（最小，落在可单测的 store）：
- `ChatState` 加 `restoreDone`；`reset()`/`startSend()`/`setConversation()` 均置 true。
- 纯函数 `shouldAutoRestore(state,itemCount,dataReady)`：仅 `dataReady && !restoreDone && conversationId===null && itemCount>0` 放行（首次加载一次）。
- `ChatPanel` 恢复 effect 改用该判据，deps 加 `conversationId/restoreDone`。
- TDD：chatStore.test.ts 先 RED（5 条守卫断言失败）→ GREEN；全量 **128 测试通过**，build / check:function EXIT 0（`build/gates-restore.log`）。

本地 UI 验证（dev server 5175 + fixture 8000，fake-qca 恒吐数学）：恢复一条旧数学对话→点新建对话清空→发送「你是什么模型」并反复聚焦 refetch→**旧「你能干什么」对话不再被拉回**（oldConvHijack=false），聊天仅含新这一轮。

待办：发布到 private 需用户新授权（上一次发布授权不延及本次改动）。

## M2 修复 — 气泡内原始 JSON 替换为生成动画

状态：**已修复并本地验证，与 restore 修复捆绑发布 private（用户授权"现在修+一起发布"）**。

用户报告：「agent 在会话里不应该直接发出 json，这一段可以替换成加载或者生成中的动画」。

根因：模型把产物 JSON 作为文本吐出，投影器（project.ts:18）逐字流式透传，`MessageBubble` 以 ReactMarkdown 渲染 → 确认卡上方出现 JSON 代码块。

修复（前端展示层，最小、可单测）：
- 纯函数 `lib/artifactText.ts#splitArtifactText`：把气泡文本拆成可读 prose 与产物 JSON（识别 ```json 围栏与行首裸 JSON），围栏刚打开（流式中）即返回非 null 以触发动画。
- `components/chat/ArtifactGenerating.tsx`：`正在生成方案…` + Sparkles，复用 `animate-guidy-breathe`，`role=status aria-live=polite`。
- `MessageBubble`：assistant 文本若含产物 JSON，流式中渲染 prose + 生成动画；完成后仅渲染 prose（无 prose 则隐藏气泡，确认卡照常）。
- TDD：artifactText.test.ts 先 RED（模块缺失）→ GREEN（9 条）；全量 **137 测试 / 18 文件通过**，build / check:function EXIT 0（`build/gates-jsonanim.log`）。

本地验证（5175 + fixture 8000）：rawJsonInBubble=false，prose「【本地 fixture】已生成示例约束：」+ 确认卡保留；生成动画因 fixture 瞬时流完不可见，需 live 真实流式验证。

## M3 范围追加 — 研究式规划（用户授权延后实现）

用户：「如果用户完全不知道做什么，agent 需要结合自己的知识并且上网搜索，再给出具体计划，通过用户后续追加再慢慢修改计划，这个加入 M3 一起实现吧」。

已记入 PRD §9 M3 范围与退出标准，并把原 P1 的 F1.5 联网检索提前并入 M3「研究式规划」（工具不可用降级为模型知识并明示，见 R1）。本次不实现，仅记录范围。

## M2 修复 — 删除全部示例机制（用户授权"把示例全删掉"）

状态：**已删除并门禁全绿，与 restore + JSON 动画捆绑发布 private**。

用户报告新建对话仍唤起数学，要求把示例全删掉（含「【本地 fixture】已生成示例约束：」提示）。

删除范围：
- `lib/seed.ts` 删 `buildSamplePlan()` 及专用 `c()`/`seedConsId`（首屏不再预置"在职考研冲刺"数学计划）。
- `store/usePlanStore.ts` `initial()` 改 `buildEmptyPlan()`；删 `isSample`/`clearSample`/`restoreSample`，persist 传参简化。
- `lib/storage.ts`/`lib/useCommitPlan.ts` 去掉 `isSample` 持久化与回滚分支。
- `ChatPanel` 删示例横幅；`CalendarPanel` 删"载入示例计划"按钮与文案。
- `dev/function-local.ts` 删 fixture 示例提示前缀，改为只流式吐 JSON 产物（plan_title 去"示例"字样）。

TDD：新增 `store/__tests__/planStore.test.ts` 先 RED（初始 6 个数学任务）→ GREEN（空计划）；全量 **138 测试 / 19 文件**，build / check:function EXIT 0（`build/gates-sample.log`）。

后果：首屏 = 空日历 + 开场问句，M1"示例上拖拽"演示取消（用户确认）。

未动（超出确认范围，待用户定夺）：`functions/prompt.ts` 的考研数学 few-shot 范例（第 61 行已明令禁止照抄科目，健身测试证明 agent 跟随用户意图；改动会变 QCA agent 指纹）；`ConstraintDrawer` 占位符"例如：考研初试"。

注：本地 5175 仍见数学/旧 fixture 文本，源于残留 fixture server(8000) 旧对话被恢复 + 旧 fixture 代码，非示例种子；干净证明以 live 部署后为准。