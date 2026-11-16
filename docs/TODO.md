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