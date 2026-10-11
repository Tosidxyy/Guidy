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

以下为clarify-v1/v2历史桥接；当前新聊天采集见本文clarify-v3章节。AI 输出一个澄清问题、简短理由和可选的条件建议，不能写 goal_slots、PlanVersion、Calendar 或通知，也不提供 tools 列表。对话回答不自动变成确认 Slot。

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

## clarify-v3 首批聊天条件采集（2026-10-11）

新澄清回复允许内部requested_slot（outcome/available_time/constraints/null）和harness派生stage，前端不展示字段或建议表单。当前仍一次单问/650 Token、8/20 UTC日限额，不增加独立提取请求；旧回复无requested_slot时仅保留历史建议，不自动套用。

harness只接受上一成功且紧邻当前turn、有效Goal版本的问题所对应的完整回答；模型建议必须逐字等于整条用户消息、同一key，且通过保守未知/疑问/命令/更正/长度过滤。partial quote、其他字段、旧问或已confirmed条件不自动保存；不是完整语义理解或纠正能力。明确暂不确定保存unknown（text空、confirmed_at NULL），未知必需条件继续补问。已有policy提示持续阻止新采集，不能通过换词/修改条件解除。

模型question字段与下一缺项不匹配时，harness使用该缺项的固定补问并标为同一内部target；简单关键词检查不是全面语义证明。基础成果/时间确认后stage可为research_ready，仍不是排程可用；约束再问一次，可未知。自动研究/方案和自然语言更正尚未接通，聊天如实说明。

0015 chat_condition_captures保存回答run、问题run、owner/Goal、key/value/原文、chat-capture-v1及resulting_goal_revision；两端复合FK防跨目标/账号。单个D1 batch完成成功reply、Goal revision+1、Slot和依据、助手消息，失败一起回滚。run.goal_revision保留请求输入版；下一轮用捕获回执版对齐上一问题，GET/POST返回新的Goal一致快照。同键只读持久结果，不重提取/调用/涨版本。没有核心PlanVersion、日历或提醒写入。

## clarify-v3.1 委托时间、未知去重与停止请求

用户反馈韩语目标回答「你来安排吧」导致重复询问每周时间。将该回答识别为委托建议而非可用时间事实：受控提议每周3次×20分钟（60分钟）作为尝试投入，只有下一轮明确同意才保存「愿意先尝试每周60分钟；具体可用时段尚未确认」。time_proposal=weekly_60_v1仅由harness设置，模型不能提供该字段；捕获依据仍链接用户明确同意与此前服务端提议的question run。不能据此推导可用日期或安排任务。拒绝/重复委托/未知转到尚未问过的字段，都问过仍缺关键条件则needs_information，主动「继续完善」才重新讨论未知，不循环逼答。

asked_topics从本人Goal成功DeepSeek问题的三个内部target去重，包含旧已问问题；不是轮数或确认数，不代表三个答案已确定。停止操作至少三种target问过才允许，否则422 CLARIFICATION_MINIMUM_NOT_MET，不调用模型。固定用户停止消息创建clarify-stop-v1/notice/harness/draft_requested回执，最多每Goal10条，不占8/20模型澄清日额度、耗尽额度仍可停止；重复key不多建，旧版本/并发/历史policy继续保护，不取消已在途付费请求。停止仅记录准备草稿的意图，尚未自动运行研究/计划，不补假Slot、写日历或生成假结果。未发送输入在停止成功后保留。

## 停止后自动研究与方案（首批chat_auto_v1）

停止notice成功与planning_jobs/生成额度预留同一个D1 batch；上下文冻结Goal版本与三个条件（可未知），同一source_run_id只一项，单Goal一项活跃，最多10项。停止本身不调用模型；有额度才派发已保存请求，达到上限/已有活跃时不假称已启动。每job与手动plan-drafts共享账号每日3/全局10 plan_draft_usage（UTC，失败/unknown也计），一次自动任务最多研究判断+计划两次模型，0或1次搜索；搜索额外共享6/30 search_usage。删除Goal不退款，两种用量在账号删除时级联。

复用ResearchWorkflow绑定，event仅jobId；数据库判定source重读还是自动规划，原来源任务行为不变。planning-decide/research/generate三步检查点，付费阶段先D1 claim再调用；45秒付费阶段保护窗口、外部判断20秒/搜索12秒/生成25秒，Workflow每步60秒、自动重试0。中断/重复claim/超时不重付费，结果不明终态unknown；已保存后重复步骤无副作用。queued/中间待处理10分钟、外部阶段45秒lease，GET只过期结算，不派发或重生成；派发失败可POST恢复同一jobID，另开须用户明确确认。

研究判断返回needs_search与固定七类通用topic，查询由harness固定词表生成并冻结，不发送用户时间/限制/邮箱/原文到搜索。健康/健身/护肤关键词强制检索，是保守规则非全面领域分类。确定性选前三份有正文/摘要来源各900字，保存URL/供应商request_id/search_id/searched_at/未核实，不把摘要当事实核验；没有正文失败，不静默降级为已研究。need_search=false才允许无来源个人行动草稿，仍unverified且明确未检索。

计划复用strict emit_plan与Schema/引用/依赖/风险校验，不执行工具；未知成果/时间/限制在服务端补入assumptions，保留unknown事实。只chat_auto_v1支持来源0与未知必需字段，原手动搜索/生成门槛不放宽；无来源禁止虚构引用，不能认定专业事实。生成前后检查owner/Goal版本/状态/policy，通过才同batch保存私有plan_draft_attempt与completed，稳定Task IDs/未排程标志，完全不写核心PlanVersion/日历。研究判断不是全面知识缺口或语义事实评估。
