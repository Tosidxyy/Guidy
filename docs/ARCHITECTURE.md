# Guidy｜Cloudflare TypeScript 架构

> 2026-10-09 用户确认改用 Cloudflare 并将后端语言改为 TypeScript。本文件替代此前 Python/FastAPI/Supabase 方案；旧文档仅见 [历史快照](../archive/architecture-before-cloudflare/ARCHITECTURE.md)，不能作为当前实现依据。

## 1. 已确定选型与边界

| 层 | 方案 | 当前进度 |
| --- | --- | --- |
| iOS | Expo / React Native / TypeScript / Expo Router | 三 Tab 与 API 连通检查已实现 |
| API | Cloudflare Workers / TypeScript，模块化单体 | M0 迁移中；HTTP 标准接口，按功能拆模块 |
| 业务数据 | Cloudflare D1（SQLite 语义） | 本地开发/测试及独立云开发 D1 迁移已应用；云端认证尚未开放 |
| 用户认证 | Better Auth + Expo 集成 | 本地 OTP/会话/退出及当前账号保护已接入；正式邮件/云部署/新真机验收待完成 |
| 邮件 | Resend 发信 + Cloudflare Email Routing 收信 | 2026-10-10 用户选择；发信适配已实现，secret/实际投递待验收，收信域名未配置 |
| DB 访问 | D1 binding、参数化 SQL、Wrangler SQL migrations | 本地开发/测试隔离，生产资源待配置，不下发管理凭据 |
| Schema | TypeScript DTO + 运行时 Schema 校验（M1 选定/锁定实现） | 不把静态 TS 类型当成运行时校验 |
| Agent | TypeScript Provider 抽象 + 结构化 PlanDraft | M1 才实现；模型/检索供应商未选定 |
| 排程 | TypeScript SchedulingService | 确定性校验，不由模型写日历 |
| 后台研究 | Cloudflare Workflows + D1 Job/来源检查点 | 首批持久来源重读；真正研究/计划阶段后续扩展，不用手机后台JS或API内存任务 |
| 提醒 | iPhone expo-notifications + 服务端意图对账 | M2；不等同任务完成 |
| 测试 | tsc / ESLint / Node test + Wrangler 实际运行验证 | CI 不直接部署远程 |

前端只访问 HTTPS 业务 API；登录按 Better Auth 的 Expo 集成完成后接入。用户身份由已验证会话决定，绝不信任客户端 owner_id。服务端密钥仅 Workers secrets，App 只有公开服务地址。底部仍仅「目标｜日历｜我的」；品牌/版本边界不变。

## 2. 模块与目录

```text
apps/mobile/app/              # 保持现有三个 Tab 与 Goal 内流程
apps/mobile/src/api/          # typed client；当前为 health
backend/src/index.ts          # Worker HTTP 入口
backend/src/                  # 按需增加 auth/services/repositories/scheduling/agent
backend/tests/                # 最小有效边界测试
backend/wrangler.jsonc         # 本地运行配置；尚无远程账号/资源 ID
backend/migrations/           # 后续 M0 添加 SQL，不提前创建 M1 表
```

单体模块职责：入口负责请求上下文/路由/鉴权；Service 定义目标状态、计划版本与确认；Repository 执行参数化 SQL 和 owner 条件；Scheduler 校验硬约束；Agent 仅产生结构化候选；后台消费者负责可恢复执行、预算、重试与幂等。无需 Redis、Celery、向量库或复杂多 Agent。

## 3. HTTP 合同与可观测性

`GET /health` 是公开 liveness，不能代表数据库、认证或模型可用。成功 `{data:{status:"ok",service:"guidy-api",version:"0.1.0"},error:null,request_id}`；失败 `{data:null,error:{code,message,details},request_id}`。业务路径 `/api/v1`。合法 UUID 追踪 ID 规范化复用，其余生成服务端 UUID；响应头 X-Request-ID 与 JSON 一致。

404/405/500 使用稳定错误码与通用文案；未来请求 Schema 失败保持 422，认证保持 401/403。不得回显异常原文、令牌或私人字段。日志仅记录 event、request_id、已知 method、路由模板、status_code、duration_ms；未知路径记 unmatched。Cloudflare 平台日志策略须部署前核对，不能将原始 URL/正文作为业务日志。Workers observability 默认关闭，本地 Wrangler 自带访问输出与业务白名单日志分开理解。

浏览器 CORS 默认空；health 仅 GET/request ID、不使用凭据。Auth/当前账号路径仅显式 origin 可使用 GET/POST、Content-Type/Expo-Origin/request ID 与 cookie 凭据；原生 iPhone fetch 不依赖 CORS。账户数据仍须服务端会话验证。Better Auth SDK 路径保留库响应协议，业务 /api/v1/me 使用统一 envelope。

## 4. 认证与数据一致性

Better Auth 身份/会话表与业务 profiles/goals 关联；具体表名采用锁定版本生成的 Schema，不假造 Supabase auth.users。所有业务查询必须附 owner 条件，关联关系也要验证。D1 不提供 PostgreSQL RLS；对象授权在服务/Repository 中强制执行并以跨用户测试覆盖。

用户确认携带 expected_goal_revision 和 Idempotency-Key。D1 batch 可原子执行 SQL，但“先读后写多个请求”不是事务。确认必须将并发条件、幂等提交标识、计划指针和派生记录放入可验证的原子 SQL 方案；不能仅因 UPDATE 影响 0 行就假定后续语句会回滚。M2 需用失败回滚、并发竞争测试证明后才能上线。

D1 不使用 PostgreSQL 行锁或 SKIP LOCKED。Job 原子 claim、lease、heartbeat、去重与检查点需针对 D1/消费者设计；如果平台消息重放，不能重复确认计划/入历。M1 评估持久编排与消费者契约，不能以 waitUntil 或手机后台 JS 代替持久任务。

## 5. 产品与 Agent 合同

2026-10-10 用户指定先用自己的 DeepSeek API 测试，重点开发 harness。已增加独立 Provider 与短澄清 harness：owner/状态/版本、上下文一致快照、持久 run/message、调用限额、输出校验和失效恢复由服务端掌控。模型生成问题和带本轮原文依据的待确认条件建议，不执行 tools 或写确认条件；用户在条件页逐项审阅后通过现有版本/幂等接口确认保存。研究/计划的后台 jobs 尚未实现。详见 [AI harness](AI_HARNESS.md)。

Goal 是根对象；Slots 保留来源/确认/敏感性；研究保存 URL、checked_at、支撑主张和限制。网页/模板都是不可信数据；工具限制 SSRF、重定向、下载量、时间和费用，不将外部文本提升为系统指令。

首批 [来源准备](RESEARCH_SOURCES.md) 分离ResearchProvider、短请求存档与Cloudflare Workflows后台来源任务：用户指定有限官网URL，持久Job/逐项lease与检查点、同实例派发重试、版本检查和未核实结果恢复。没有自动搜索、事实核验或计划生成，不向澄清模型传入外部网页全文；长时研究/LLM阶段后续增加预算与heartbeat。

动态澄清优先必要信息；软轮次预算不能绕过安全门槛。PlanDraft 先运行时 Schema，再领域/风险/排程校验，再用户批准。专业事实缺乏引用时标为未核实，不伪造价格、浓度或医疗结论。模型/搜索密钥不进入 App。

2026-10-11 用户确认方案生成采用目标倒推+约束规划+按需检索+生成/校验/修订+执行反馈。新增[搜索实现策略](SEARCH_STRATEGY.md)记录候选供应商、费用口径和拟实现的SearchProvider/证据/PlanDraft步骤。当前ResearchProvider.read是短网页读取，后续SearchProvider.search独立查询供应商API；不得直接把手填URL抓取当作搜索。付费搜索步骤要有独立尝试/预算回执，不能照搬公开网页GET的自动重试规则；网络结果不明时标unknown，不默认为未扣费。

Task 定义和 Occurrence 执行实例分离；计划版本不可覆盖。局部修改只产生受影响项的待审 Diff，用户确认前旧版本仍生效，过去的真实反馈始终保留。所有货币估算有单位与来源/时间；所有具体时间存 UTC，重复规则保留 IANA 本地意图。

默认任务不可重叠；固定事件不静默移动；依赖环、截止日期、资源互斥、最小间隔、前置条件、DST/跨日均确定性检查。无可用候选给出原因和备选，不凭空生成空闲窗口。V0.1 不访问 Apple Calendar。

## 6. 通知最终一致性

确认事务写 occurrence、notification_intents 与 outbox；手机 schedule/cancel 后 ACK desired_revision，并保存系统通知 ID。滑动窗口注册、去重与恢复对账；关闭 App 的旧通知可能未及时取消，必须显示真实待同步状态。通知权限拒绝不妨碍日历；注册/送达/点击均不等同 completed。反馈 completed/partial/skipped/postponed/unknown 幂等，未反馈不能当跳过。

## 7. API 规划（非已实现）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/goals` | 创建草稿（Idempotency-Key） |
| `GET` | `/goals` | 当前用户 Goal 列表 |
| `GET` / `PATCH` | `/goals/{id}` | 读取/修改目标基本约束 |
| `POST` | `/goals/{id}/messages` | 保存对话输入、更新 Slot、决定下一阶段 |
| `POST` | `/goals/{id}/research-runs` | 创建研究/计划生成 Job |
| `GET` | `/agent-runs/{run_id}` | 查询阶段/研究进展、错误与产物 |
| `GET` | `/goals/{id}/plan-draft` | 获取草稿、依据、估算和风险 |
| `POST` | `/goals/{id}/schedule-proposals` | 对当前草稿生成排程预览 |
| `POST` | `/schedule-proposals/{id}/confirm` | 乐观锁确认并生效（幂等） |
| `GET` | `/calendar/occurrences?from=&to=` | 日历查询（当前用户） |
| `POST` | `/calendar/fixed-events` | 添加个人固定事件 |
| `POST` | `/occurrences/{id}/feedback` | 完成/跳过/延期（幂等） |
| `POST` | `/goals/{id}/revisions` | 请求自然语言修改草稿 |
| `GET` | `/goals/{id}/revisions/{rid}` | 获取差异预览 |
| `POST` | `/goals/{id}/revisions/{rid}/confirm` | 确认合法的新版本 |
| `GET` | `/notifications/desired` | 查询设备应安排的本地通知 |
| `POST` | `/notifications/sync-ack` | 上报设备同步状态 |
| `GET` / `POST` | `/templates/private` | 私人模板查询/抽取（V0.2） |
| `POST` | `/templates/{id}/instantiate` | 应用模板成为新 Goal（V0.2） |
| `POST` | `/templates/{id}/submit` | 公开审核申请（V0.3） |
| `DELETE` | `/me` | 账户删除流程 |


除 health 外均按 M0–M3 顺序实现，模板只在 V0.2/V0.3。具体用户验收以 [PRD](PRD.md)、[UI](UI_DESIGN.md) 和 [TODO](TODO.md) 为准。

## 8. 分期、发布与未验证项

M0：TS Worker 探活/错误/日志、基础 CI、D1 开发/测试迁移、Better Auth 登录/恢复/权限、iPhone 基础联调。M1：Goal/研究/PlanDraft 与持久任务。M2：排程/确认/提醒/反馈。M3：局部修订与我的完善。M4：真机与真实用户验证。V0.2 私人模板/启动观察；V0.3 公共模板审核。

用户确认 iPhone Expo Go 预览和本地 Worker 探活可用；新真实登录、机型、大字体/VoiceOver、原生通知、最终图标/签名安装包尚未完整验证。本地 Auth 已接入，云开发 Worker/D1 已部署；正式邮件、云端登录与手机云联调待完成，详见 [云开发环境](CLOUDFLARE_DEPLOY.md)。公开账号删除/导出、模板脱敏、数据保留/供应商条款在发布前落实。

开发用 Wrangler 本地运行；生产使用独立 Worker/D1 及 secrets，不能把无认证开发服务长期公开。Cloudflare 账号、地区/数据需求、费用与资源权限要在真实资源创建时确认；CI 只做检查与 dry-run，不自动部署。失败重试与批处理边界先测再标完成。

参考：[Workers](https://developers.cloudflare.com/workers/)、[D1](https://developers.cloudflare.com/d1/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Better Auth 数据库](https://better-auth.com/docs/concepts/database)、[Expo 集成](https://better-auth.com/docs/integrations/expo)。

### 首批搜索尝试接口（2026-10-11）

SearchProvider.search独立于网页ResearchProvider.read；首批豆包Custom Adapter调用固定API，不抓取搜索结果URL。GET/POST /api/v1/goals/{id}/search-runs要求会话/owner、版本和已确认基础条件；D1原子保留尝试/预算，先持久保存再请求。首批同步12秒等待、30秒lease，不复用网页Workflow；崩溃/不明结果不自动重试，完整搜索编排仍待实现。合同与Key配置见[SEARCH_SETUP](SEARCH_SETUP.md)，已接Goal内主动搜索页面；自动查询/PlanDraft未实现。
