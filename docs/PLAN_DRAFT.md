# 首批计划草稿后端

实现日期2026-10-11。当前提供私人草稿API与DeepSeek JSON生成，不含手机审阅页、确认计划、PlanVersion入历、自动搜索、领域事实核验、模型自动修订或搜索/计划Workflow。使用既定Workers/D1；模型不能修改Goal/Slot/核心计划/日历。

## API与输入

GET/POST `/api/v1/goals/{id}/plan-drafts` 都要求登录及目标owner。GET最多10个尝试，包含草稿和当次条件/来源快照；只结算过期submitted为unknown，不触发模型。

POST要求Content-Type application/json、8–128字符Idempotency-Key，请求体仅：

```json
{"expected_revision":0,"search_ids":["当前目标成功搜索记录的UUID"]}
```

search_ids去重最多3项，必须属于本人目标、当前Goal版本且搜索成功。草稿只在draft且基础readiness=research_preparation时生成；历史policy提示阻断，提交及保存时再次核对版本/安全提示。相同键/请求结束200、运行202，冲突409；缺条件409、来源不合规/正文不足422、模型未配置503。

按规范化搜索ID顺序和供应商排名确定性选取最多3份有正文/相关摘要的来源，每份最多900字符；仅Snippet不进模型。此规则只控制数量/内容可用性，不代表语义相关性排序或证据充分性核验。后续需要用户来源选择与内容评估。

保存冻结条件、目标描述最多1500/时间备注300、来源DTO及source_id；上下文JSON最多8500字符，不包含邮箱、Key或对话历史。它与旧澄清5000字符上下文分开；用户目标/条件可能含敏感文字，后续隐私审阅/保留策略待发布前完成。来源保持unverified，searched_at不是retrieved_at。

## 生成与校验

沿用DeepSeek deepseek-flash、thinking disabled、JSON模式和固定HTTPS endpoint；独立计划system提示，输出1800 Token，不改变澄清650 Token提示。响应最大64KiB、非stop/工具调用拒绝，原始模型错误/推理不回传或记录。依据[官方Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)与[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。

首批字段：标题/摘要、假设/风险各最多5条、1–6个任务。任务含阶段1–3、标题/说明、每次5–120分钟、每周1–7次、mandatory、依赖及证据ID。后端分两层检查：严格字段/类型/数量/范围；再检查任务key唯一、依赖存在/无环/阶段方向、引用必须存在于当次冻结来源、至少一项引用，以及部分明显已执行/保证效果/药物剂量表述。

后端生成Task UUID及依赖映射、计算weekly_minutes。强制status=draft、verification_status=unverified、time_fit=needs_user_review、cost_status=unknown、scheduling_status=not_checked。ID存在不证明引用支撑主张；词规则不是完整医疗风险分类器或语义事实核验。

**当前可用时间/限制是自由文本**：未实现可靠结构化时间、预算、领域完整约束或排程校验，不能宣称每周投入匹配、专业效果已证实或计划可执行。资源/成本细化、局部编辑、审阅修订、用户批准与SchedulingService仍待实现；失败不自动请求第二次模型。

## 费用与恢复

0012新增plan_draft_attempts与plan_draft_usage。D1 batch在外部调用前原子保存submitted/上下文及最少用量；每Goal最多10条尝试、账号每日3/全局10（UTC，含失败/unknown）。草稿额度独立于澄清8/20、搜索6/30；没有无限共享池或额外自动模型调用。

整次等待25秒、lease45秒；中断/不明上游/过期记unknown，格式拒绝或明确权限/余额/限流记failed。同键仅回执，终态不会自动重跑；新键是可能另计费的新尝试。usage没有查询/正文，删除Goal不重置当日额度，账号删除级联；清理策略待发布前确定。billing_status统一reserved_unknown，Token usage若有效可显示，未核实账单费用。

新草稿是新记录，API没有编辑已保存draft_json的入口；不是核心PlanVersion，不设置active_plan_version_id。不覆盖Goal/Slot/历史任务/日历。Goal删除级联清理私有上下文/草稿。

## 验证边界

本轮合成模型输出+真实临时D1/API边界验证，不代表真实DeepSeek草稿质量或手机功能。迁移/云部署实际结果见[TODO](TODO.md)。下一轮接手机来源选择/草稿审阅，完成真实模型生成后再评估语义约束/引用关系，用户确认前不写日历。产品以[PRD](PRD.md)和[搜索策略](SEARCH_STRATEGY.md)为准。
