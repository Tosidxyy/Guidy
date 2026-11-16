# Guidy M2 · AI 规划闭环 设计 Spec

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-11-16 |
| 状态 | 已评审批准（六节逐节确认） |
| 上游 | [PRD.md](../../PRD.md) §9 M2 · [技术方案.md](../../技术方案.md) v0.2 · [数据模型与API契约.md](../../数据模型与API契约.md) v0.1 · [测试与验收用例.md](../../测试与验收用例.md) §11 |
| 切片方案 | A · 垂直切片，真实链路优先（已确认） |
| 范围 | M2 = 后端开通 + QCA SSE 对话 + 约束确认卡 + 排程引擎 + 生成预览 + 持久化恢复 |

---

## 0. 已确认决策与已开通资源

**用户显式确认：**
1. 后端开通（含平台自动创建 `QODER_PAT` 服务端 Secret）——已确认并执行。
2. 本地 Function runtime：`deno` 加为 **npm devDependency**（官方包自带二进制），不系统级安装。
3. 实施切片：方案 A 垂直切片。

**已开通并独立验证的云资源（bootstrap draft 保持未发布）：**
- project `01a1e421-fb6e-756e-a7c8-44fd5a28b23f` · site `01a1e421-fb71-7745-9db4-db763e874017`
- host `guidy-oxg3oo3dpdz.qoder.zone`（当前 `access_mode: private`、`hasPublishedContent: false`）
- backend `status: ready`，capabilities `database/functions/qoder/storage`，`database_access_model: function_backend`
- PAT：`issue_qoder_pat` + `sync_secret` succeeded；`QODER_PAT` 为平台托管 Secret，不出现在应用 Secret 元数据
- 数据库：空库（`tables: []`），迁移前 `schemaRef` 已读取（见 §4）
- QCA origin：`https://api.qoder.com.cn`，path prefix `/api/v1/cloud`（取自 `get_context.runtime.cloudAgents`）

**M2 不做（后置 M3/M4）：** blocks/constraints 直连 CRUD、patches apply、templates/recovery、react-router 多路由、public 访问策略、framer-motion。

---

## 1. 后端架构与组件（M2 子集）

单 `app` Edge Function（Deno），自包含依赖：官方 `cloud-agents.mjs`/`sse.mjs`（vendored 不改）+ `npm:zod@3` + 平台注入 SDK，无其他依赖。

```
functions/
├── index.ts          Deno.serve → application(deps)
├── app.ts            application(deps)：依赖注入（本地 fake / 平台 SDK）
├── router.ts         剥离 /functions/v1/app 前缀；方法/大小前置校验
├── identity.ts       requireUser(ctx) → visitor_id
├── db.ts             注入 SDK 封装：参数化查询、错误翻译、诊断 ID
├── quotas.ts         chat 60/日原子递增；同访客 pending 派发 ≤1
├── routes/
│   ├── health.ts     GET /health（匿名）
│   ├── me.ts         GET /me（visitor_id + 配额剩余）
│   ├── conversations.ts  GET /conversations
│   ├── chat.ts       POST /chat/send · GET /chat/history · GET /chat/events · POST /chat/interrupt
│   └── plans.ts      GET /plans · GET /plans/:id · POST /plans/commit
├── qca/
│   ├── cloud-agents.mjs / sse.mjs   官方资产
│   ├── sessions.ts   visitor→conversation→qca_session 懒初始化映射
│   ├── dispatch.ts   request_id 幂等派发、pending 对账
│   └── project.ts    上游事件→白名单投影、messages/游标持久化
├── engine/           re-export shared/engine（服务端权威重算）
├── schemas.ts        npm:zod 引入 shared/schemas
└── prompt.ts         服务端固定系统指令（约束提取、≤2 追问、领域知识、仅输出 constraint_set JSON）
```

- `application(deps)` 可注入：本地 vitest / `npx deno` 用 credential-free fake（fake QCA 计数、fake DB）；部署用平台 SDK。真实 UI 始终打真实端点，fixture 仅存于本地 adapter。
- 引擎服务端只用于 `commit` 重算比对 `result_hash`/`engine_version`；试算在前端本地引擎。
- 系统指令固定服务端（`prompt.ts`），用户不可改。

## 2. 前端组件、布局与状态归并

**新增依赖：** `@tanstack/react-query`（服务端状态/乐观回滚）、`react-markdown` + `rehype-sanitize`（安全渲染）。`react-router` 后置 M4。

**布局（UIUX §6：对话 38% 暖纸 / 日历 62% 冷白）：**
- 左栏 `OverviewPanel` → `ChatPanel`；概览统计/约束/任务迁入已有抽屉（ConstraintDrawer/TasksDrawer）+ TopBar 紧凑计划头。
- 移动端底部 Tab：`对话` / `日历`。
- 日历复用 M1 组件；生成预览复用现有 ghost/diff（`preview` 态）。

**新增模块：**
```
lib/api.ts            fetch 封装：错误包络、diagnostic_id、409/422/429 语义
lib/sse.ts            SSE 消费：cursor 重连回放、新建对话取消旧 reader、旧 seq 不污染新视图
store/useChatStore.ts zustand：conversation_id、消息缓冲、流式态、cursor、连接态
components/chat/
  ChatPanel.tsx       左栏容器（暖纸底、aria-live=polite 流式区）
  MessageBubble.tsx   react-markdown + rehype-sanitize
  StreamingCursor.tsx dawn 渐变 2px 竖条 1s 呼吸（reduced-motion 常亮）
  ConstraintConfirmCard.tsx  role=dialog 焦点陷阱；逐条可编辑/删除/补充；mutex 软↔硬；[确认并生成] dawn CTA
  ChatInput.tsx       ≤2000 字符、/ 聚焦、中断按钮
```

**状态归并：** committed plan 走 TanStack Query（服务端为准，commit 乐观更新失败回滚保留预览）；视图/选中/撤销栈/抽屉/SSE 连接态走 Zustand；localStorage 仅乐观缓存+草稿/外观。
**示例共存：** 首屏本地示例（isSample 角标）+ 对话问候；首次 commit 成功后清空示例、服务端 plan 为唯一源；示例不入库。
**确认卡交互：** artifact 到达 → clarifications_needed 非空先追问（不出卡）；否则出卡 → 用户编辑确认 → 前端 solve 预览（ghost）→ 确认预览 → POST /plans/commit。

## 3. 数据流：SSE 投影、游标重连、commit 幂等

**POST /chat/send 服务端顺序：** 归属/大小校验(≤2000) → 配额原子递增(60/日,超限429上游零调用) → 并发检查(pending→409 dispatch_busy) → 插 dispatch_intents(pending) → 懒初始化 QCA Session(回填 qca_session_id) → 派发 → 投影+持久化 → done/failed 回填。响应 202 + text/event-stream，首事件 accepted（受理≠完成）。重复 request_id 回放不重复派发。结果未知保持 pending，下次 send/events 先对账再决定重发。

**流投影：** 只转发白名单 `accepted/delta/artifact/status/error/done`；逐条持久化 messages(seq 单调) 推进 last_seq，完成关闭上游流。artifact 仅 Zod+业务校验通过后发出；失败自动重试≤2，仍失败 error{artifact_invalid} 保留上下文。delta 增量追加该 seq text。

**游标重连 GET /chat/events?cursor：** cursor=`<seq>:<offset>`（offset 仅 text 字符偏移）。先回放游标后持久化（text 从 offset 续传）再续流至 done；绝不重发用户消息。刷新只 GET history/events，零 POST send。

**POST /chat/interrupt：** 取消上游读取，status=interrupted，投影 status；可继续新消息。
**新建对话：** 前端取消旧 reader；旧 seq 不写新视图。

**POST /plans/commit：** body `{preview_id, plan_id|null, input, result_hash, engine_version}`。engine_version 不匹配→409 engine_version_mismatch；服务端重算无解→422 engine_infeasible+报告 DB 零写入；result_hash 不匹配→200+server_authoritative:true+服务端结果；preview_id 已存在(commit_log)→返回首次结果不重复。无通用事务：先 commit_log 占位→写业务表→更新 version；失败可重试凭 preview_id 收敛。

## 4. 数据模型（M2 建表子集）与迁移

`app` schema，走 reviewed migration（create_database_migration→审阅→apply_database_migration）。DDL 与契约 §3 逐字对齐（CHECK/索引/默认值），仅去掉 M3/M4 表。M2 建 9 张表：

`plans` · `task_defs` · `constraints` · `blocks` · `conversations` · `messages` · `dispatch_intents` · `commit_log` · `quotas`

（字段/索引/约束见契约 §3；M2 不建 templates/template_likes/template_uses/recovery_codes/patch_log。）

- 归属强制：私有读写 WHERE `owner_visitor_id=$verified`；跨访客 403。
- 时间全 UTC timestamptz + plans.timezone；HH:mm 按计划时区解释。
- 无通用事务 → 唯一键幂等 + version 条件更新 + 失败对账。
- 输入上限沿用契约 §1（task_defs≤30/blocks≤300/constraints≤40）。
- 迁移 SQL 不含 DML/凭据/业务记录；function_backend 省略 accessPolicies。

## 5. 错误处理与配额

- 错误包络 `{error:{code,message,diagnostic_id,details?}}`；message 可读中文；diagnostic_id 不含凭据/原文/签名 URL。
- M2 触发码：unauthorized401/forbidden403/not_found404/validation_failed422/engine_infeasible422/artifact_invalid422/quota_exceeded429/dispatch_busy409/engine_version_mismatch409/upstream_error502/service_unavailable503。placement_invalid/version_conflict/content_rejected 保留码表但 M2 不触发。
- 前置顺序：方法/大小/归属→配额→并发→才触上游。
- 前端映射：429→额度用完；409 busy→等待当前生成；502→重试+诊断 ID；artifact_invalid→可读说明+保留上下文（不自动重发）。
- XSS：react-markdown+rehype-sanitize 白名单禁 raw HTML。PAT 仅 `Deno.env.get('QODER_PAT')` 于 Function，不下发/不入日志/不进 secretNames。

## 6. 测试与本地/部署 loop

- **vitest：** shared/engine+schemas 沿用 M1 33 例；新增 Function 路由/投影/协调用 `application(fakeDeps)` 注入，覆盖 R6–R9/R13/R16–R18（fake QCA 计数不重复派发、pending 对账、配额上游零调用、commit 幂等/无解/hash/version）。
- **本地 runtime：** `deno` devDependency；`npm run dev:function` = `npx deno run --allow-net=127.0.0.1:8000 dev/function-local.ts`（credential-free fake）；`npx deno check functions/index.ts` 作 Deno 类型 gate（T2 首周验证）。Vite 代理 `/functions/v1/app`→127.0.0.1:8000 不变。
- **部署实测：** prepare_site(databaseAccess read_write + 迁移后 schemaRef + functionDirectory) → publish_site 到 **private** 站点，owner 身份实测 C1–C7/A2/A3/A9 与 T3 匿名身份。public 属 M4，M2 保持 private。
- 验收分离报告：本地 fixture / 站点发布 / 真实 AI 执行 三者分开；ready backend/HTTP200 不算 AI 验收。

---

## 7. 退出标准与风险

**M2 必过（部署 private 实测）：** C1–C7、R6–R9、R13、R16–R18、A2/A3/A9。
**风险：** T2（Deno npm:zod 兼容）首周最小 Function 验证，失败则 vendor zod 或手写校验器；T3（匿名身份运行时）部署后实测，失败触发 Plan B（自建匿名 token + 恢复码升 P0）；T4（SSE 投影延迟）逐条转发不缓冲全文，实测 P95 首 token<3s。