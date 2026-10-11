# Guidy AI harness · 澄清测试链路

> **2026-10-11 目标交互更新**：Slot与研究/生成步骤是后台能力，正式主流程为聊天采集→方案草稿（含拟安排）→一次批准自动入历。下文已有手工确认/搜索/审阅协议是实现现状，不作为最终必经UI；受控保存用户事实与一次批准合同见[对话主流程](CHAT_FIRST_FLOW.md)。改造尚未实现，模型不直接写核心表。

用户于 2026-10-10 指定先使用自己的 DeepSeek API，主要开发 harness。当前 Provider 为 DeepSeek 的 `deepseek-flash`，使用 [官方 Chat Completions 接口](https://api-docs.deepseek.com/api/create-chat-completion/)，非流式、thinking disabled、JSON object；Provider 可替换，业务控制不交给模型。

2026-10-11 已确认后续方案方法：目标倒推、约束规划、按需搜索、生成后校验/修订、执行反馈。新增豆包SearchProvider和私有搜索尝试API，先落库保留预算再请求，unknown不自动重试；见[搜索接入](SEARCH_SETUP.md)。已接Goal内主动搜索页面，未接自动查询/搜索Workflow；首批PlanDraft后端已实现，手机审阅已接入，完整校验仍待实现，旧后台来源任务仍仅公开GET。候选供应商、费用及完整流程见[搜索实现策略](SEARCH_STRATEGY.md)，产品验收以[PRD](PRD.md)为准。

## 模块与边界

| 层 | 职责 |
| --- | --- |
| agent/provider.ts | 固定 HTTPS endpoint、服务端 Key、请求/响应大小与输出 Token 限制、AbortSignal、安全错误映射；不导入 DB、不执行 tools |
| agent/harness.ts | 已验证 owner、草稿状态、目标/对话版本、上下文一致快照、运行状态、幂等/并发/调用额度、Schema 与语义边界、过期恢复 |
| D1 agent_runs | 原始请求、turn index、目标版本、私有上下文快照、requested model、context schema/harness version、usage、成功/失败/lease |
| D1 agent_messages | 关联运行的用户消息与已通过校验的回复；同一 run/role 唯一、同 Goal 复合外键、随目标删除级联 |
| Goal 内对话页 | 展示建议/系统边界，输入、失败保留、恢复/状态读取；账号/目标切换不复用私有输入 |

AI 输出一个澄清问题、简短理由和可选的条件建议，不能写 goal_slots、PlanVersion、Calendar 或通知，也不提供 tools 列表。对话回答不自动变成确认 Slot。

`clarify-v2` 的 `suggestions` 最多三项，key 仅 outcome/available_time/constraints 且唯一。text/evidence 必须相同、最多300字、逐字存在于本次用户消息；模型不能改写或用历史/助手文字充当依据。分类仍可能有误，原文匹配并不证明语义正确。旧回复无 suggestions 时作为空建议兼容，旧 run/version 不改写；policy 不提供条件建议。建议随已校验 reply_json 私有保存，无需新迁移，不附加独立模型请求。

聊天页「审阅这轮条件建议」进入条件页，仅通过 run ID 从已认证对话重新读取；目标/当前 run 版本必须匹配且仍为草稿。显示原文和已有输入，用户逐项填入或忽略，填入仅修改本页草稿；在原有三步页核对/修改并「确认并保存条件」后，走原有 owner/expected_revision/Idempotency-Key 原子保存，source=user、confirmed_at=服务端时间。已确认条件不被模型自动覆盖。旧建议不再适用时保留历史、禁止套用；并发保存失败继续保留用户输入。最近30轮之外的建议暂无审阅入口。

## 运行协议

`GET /api/v1/goals/{id}/messages` 返回当前目标与最近 30 轮状态；原始更早记录保留在 D1。`POST` 携带 Idempotency-Key 与 `{text,expected_chat_revision,expected_goal_revision}`，text 为 1–600 字。先原子占用一轮并保存用户消息，再调用 Provider。相同请求只尝试一次 Provider；running 重放为 202，已结束重放返回持久状态，不重复付费调用。

每个 Goal 最多一个 running，turn index 防止旧页面抢占新对话；输入的目标版本必须匹配。上下文仅包含当前目标、三项条件、最近两轮成功对话和当前输入（最多 5000 字符）；不自动加入账号邮箱/ID、认证 cookie、Key 或其他目标。生成前读取一致快照，生成后再次核对目标状态/版本；已改变时拒绝旧回复，不覆盖核心数据。

模型输出必须通过 JSON、字段/类型/长度、单问和重复问题边界校验；不允许 tool calls、截断或虚假“已写入/购买”等执行声明。未通过的原始模型输出/思考内容不保存、不展示；失败输入和安全错误码仍可恢复。按明确用户事实保守匹配部分高风险条件，返回标为 policy 的系统边界，不假装这是模型输出；该词匹配不是完整医学风险判定，研究/计划尚未开放。

## 基础澄清进度

`GET /goals/{id}/slots` 在同一个 D1 batch 读取 owner 过滤的目标、条件与该目标已有的 policy 提示，新增 `readiness`（schema_version=1、goal_revision、phase、confirmed_keys、missing_required、unknown_optional）。用户确认、有时间戳、有效非空文本的 outcome/available_time 是首批研究资料前置；constraints 可未知，始终明确提示未确认，不解释为“没有限制”。

phase 为 needs_confirmation / needs_review / research_preparation / paused / read_only。现有部分高风险词或该目标已有的 policy 提示优先标为待核对；这是保守提示，不是完整风险分类。修改描述或条件不会自动解除历史转介，显式专业核对/解决流程尚待实现。该结果为只读派生数据，不改变 Goal 状态、不声明研究/计划可执行、不写日历，也不替代后续研究工具、领域安全或排程规则。

目标详情显示三项确认进度、所缺基础条件和下一步说明。研究尚未实现时只显示研究准备，不提供无效启动按钮。可继续补充可选条件或聊天，不强制无限问答。

`backend/evals/clarification-readiness.json` 包含学习、健身、护肤等10个合成样例，由确定性规则测试重复运行；包括缺项、可选未知、专业判断提示、暂停与非草稿。它验证状态规则，不评估真实 DeepSeek 输出质量。

## 测试限额与恢复

- DeepSeek 输出最多 650 Token（包含条件建议），HTTP/harness 等待最多 20 秒，运行 lease 45 秒，App 等待最多 30 秒。
- 每账号每天最多 8 次、全局每天最多 20 次新请求，包含失败尝试；重复同键不重复计入。按 UTC 日期重置，即北京时间每日 08:00。此为请求数量上限，不是金额预算。
- 历史/GET 只读取和结算过期状态，不自动重启模型。超时/崩溃后保留失败状态与输入，由用户明确开启新请求；中止等待不保证供应商未消耗 Token。
- 本轮是短澄清请求，不是后台长时研究 Job；不承诺关闭 App 后继续研究。agent_jobs、搜索与持久后台编排后续单独实现。

## 密钥与开关

```powershell
cd C:\Users\29035\Desktop\Guidy\backend
npx wrangler secret put DEEPSEEK_API_KEY --config wrangler.cloud.json
```

云配置 GUIDY_AI_ENABLED=true、GUIDY_AI_MODEL=deepseek-flash。部署 guard 只捕获核对 secret 名称，不显示值；本地无 Key 时 POST 为 AI_NOT_CONFIGURED，仍可读对话。需要本地真实测试时只在忽略的 backend/.dev.vars 配置同名 Key/开关，不放 App .env 或 Git。

测试方式：真实临时 D1 + 模拟 Provider 验证 harness；受控 API 回复验证 UI。真实 DeepSeek 质量与 iPhone 输入/多轮恢复必须另外验收，不能将固定测试回复当成真正模型输出。

### 首批计划生成隔离

PlanDraft使用独立计划system提示/1800输出Token，与原澄清提示/650 Token分开。输入最多8500字符，最多3份900字符来源，条件和证据先冻结，引用/任务依赖/范围验证后保存。规则失败不自动修订或重试付费调用；草稿只待用户审阅，时间匹配与排程未校验。API、额度及限制见[PLAN_DRAFT](PLAN_DRAFT.md)，不是完整M1/领域安全验收。

草稿真机校验失败后补充结构/任务/引用/依赖/安全内容固定错误码；不保存原始模型错误内容。evidence_ref E1/E2/E3由后端限定映射为本人目标冻结UUID，重复同源引用去重、未知引用拒绝。明确否定效果承诺不误识别为肯定承诺，部分风险词规则仍不是完整语义安全门槛；不自动再次调用模型，详细边界见[PLAN_DRAFT](PLAN_DRAFT.md)。

计划输出已切换DeepSeek官方Beta strict Schema：emit_plan仅是响应格式，不进入工具registry/dispatcher，不执行任何操作；仅一个固定函数/参数返回可接受，仍经本地结构/引用/依赖/安全校验。对象字段/类型/额外字段由输出schema约束，数组数量/唯一/依赖继续代码校验。澄清普通JSON模式与拒绝工具调用不变。开发环境曾临时每日4次验证，用户确认成功后已恢复每日3/全局10，旧用量和草稿保留；见[PLAN_DRAFT](PLAN_DRAFT.md)。
