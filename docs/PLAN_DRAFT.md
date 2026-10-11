# 首批计划草稿后端

实现日期2026-10-11。当前提供私人草稿API与DeepSeek JSON生成，已接手机资料选择和草稿审阅页，尚未实现确认计划、PlanVersion入历、自动搜索、领域事实核验、模型自动修订或搜索/计划Workflow。使用既定Workers/D1；模型不能修改Goal/Slot/核心计划/日历。

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

沿用DeepSeek deepseek-flash与thinking disabled。计划生成改用固定Beta Chat Completions endpoint与strict JSON Schema，仅允许一个名为emit_plan的格式载体；不执行该函数、不派发工具或跟进调用，未知/多个调用或截断均拒绝。参数仍送入原有引用/依赖/安全校验，输出1800 Token、响应最大64KiB。澄清保持原普通endpoint/JSON object/650 Token，并继续拒绝工具调用。原始模型错误/推理不回传或记录。依据[官方Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)与[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。

首批字段：标题/摘要、假设/风险各最多5条、1–6个任务。任务含阶段1–3、标题/说明、每次5–120分钟、每周1–7次、mandatory、依赖及证据ID。后端分两层检查：严格字段/类型/数量/范围；再检查任务key唯一、依赖存在/无环/阶段方向、引用必须存在于当次冻结来源、至少一项引用，以及部分明显已执行/保证效果/药物剂量表述。

后端生成Task UUID及依赖映射、计算weekly_minutes。强制status=draft、verification_status=unverified、time_fit=needs_user_review、cost_status=unknown、scheduling_status=not_checked。ID存在不证明引用支撑主张；词规则不是完整医疗风险分类器或语义事实核验。

**当前可用时间/限制是自由文本**：未实现可靠结构化时间、预算、领域完整约束或排程校验，不能宣称每周投入匹配、专业效果已证实或计划可执行。资源/成本细化、局部编辑、审阅修订、用户批准与SchedulingService仍待实现；失败不自动请求第二次模型。

## 费用与恢复

0012新增plan_draft_attempts与plan_draft_usage。D1 batch在外部调用前原子保存submitted/上下文及最少用量；每Goal最多10条尝试、账号每日3/全局10（UTC，含失败/unknown）。草稿额度独立于澄清8/20、搜索6/30；没有无限共享池或额外自动模型调用。

整次等待25秒、lease45秒；中断/不明上游/过期记unknown，格式拒绝或明确权限/余额/限流记failed。同键仅回执，终态不会自动重跑；新键是可能另计费的新尝试。usage没有查询/正文，删除Goal不重置当日额度，账号删除级联；清理策略待发布前确定。billing_status统一reserved_unknown，Token usage若有效可显示，未核实账单费用。

新草稿是新记录，API没有编辑已保存draft_json的入口；不是核心PlanVersion，不设置active_plan_version_id。不覆盖Goal/Slot/历史任务/日历。Goal删除级联清理私有上下文/草稿。

## 验证边界

后端合成模型输出+真实临时D1/API边界、手机页面受控回复浏览器检查通过，不代表真实DeepSeek草稿质量或iPhone专项验收。迁移/云部署实际结果见[TODO](TODO.md)。手机入口为「搜索研究资料 → 生成与审阅计划草稿」，主动选择当前版本有正文/摘要的搜索记录。读取状态与重进仅GET，同页恢复使用原幂等键；另生成需确认可能再计费，已有草稿保留。显示冻结条件、任务/依赖/引用、假设/风险和未校验投入；没有确认或入历按钮；时长/频次调整见下方。真实模型生成后再评估语义约束/引用关系，用户确认前不写日历。产品以[PRD](PRD.md)和[搜索策略](SEARCH_STRATEGY.md)为准。

## 首批真机失败诊断与提示修正

用户反馈iPhone真实生成记录为PLAN_INVALID_DRAFT。旧记录未保存原始模型回复或细分原因，不能推断这两次失败的确切字段，也不改写为成功。新校验分别记录结构、任务参数、引用、依赖、安全内容错误，只保留固定安全错误码，不回传/记录原始模型文本。

修复已复现的规则误判：明确「不/不能/无法保证成功或治愈」的否定提醒不再被当作肯定承诺；同时出现肯定承诺、剂量/已执行/网址表述仍拒绝。此规则不是全面语义或医学安全识别。模型提示明确字段与整数范围，用E1/E2/E3短evidence_ref；只在当前冻结来源内映射回source_id并去重，已有合法UUID引用向后兼容，未知引用仍拒绝。没有自动修订/第二次模型调用或放宽领域、依赖、时间/频率边界。

手机已结束的成功/失败请求禁用无效恢复，unknown仍可读取回执，另开请求须明确确认可能计费；旧记录与每日3次额度不清除。本阶段细分提示修正后用户仍报告结构失败；后续strict阶段的真实反馈见下文。


## 严格输出与开发验证（2026-10-11）

用户进一步确认第三次为PLAN_INVALID_SCHEMA；只读错误统计为旧通用2、结构1，不读取用户目标/条件或模型原文，无法恢复具体坏字段。增加固定字段分类（JSON/对象/额外字段/标题/摘要/假设/风险/任务数/任务编号），不暴露任意输出字段名或原文。

依据[官方严格模式](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)，所有object字段required且additionalProperties=false，引用enum仅当前E1/E2/E3，字符串长度用受支持pattern、整数上下界由schema及本地双检。官方不支持array minItems/maxItems，因此数量/唯一/依赖/安全/事实适用性仍由本地规则/用户核对承担。严格输出不保证事实正确。

隔离云端验证：只为测试身份写入短期验证哈希，经真实登录/Goal/slots API取得测试会话，使用标明非真实抓取的受控来源；一次普通模式、一次最终strict模式均201生成成功。没有发送邮件、读取Key/真实用户正文或保存原始模型回复，按精确测试身份清理。它证明真实云Provider与该受控样例，不证明用户原目标已成功或健身建议有效。首次fixture数字日期与认证库ISO存储不符，登录400且未调用模型；修正后通过。

本轮iPhone验证时曾仅development临时提供每日第4次，用户确认草稿出现后已恢复全部环境默认3，全局10不变；原记录/用量均不清除、失败/unknown占用，只允许用户主动另开，客户端显示服务端daily_limit。第5次仍阻断。临时验证已结束；没有自动重试/补偿或按字段错误自动再调模型。

用户随后确认iPhone原目标「已出现草稿」，基础真实生成/展示验收通过；不代表内容质量、专业事实、时间适配、VO/大字或入历验收。当天4条尝试/用量与已成功草稿保留，恢复3次默认后当天不再允许新生成，读取/审阅不受影响。

## 私有时长/频次审阅版本（2026-10-11）

草稿页「调整时长与频次」进入独立二级页，读取原稿及最新审阅版本。修改每次5–120整数分钟、每周1–7次；每周可用分钟见下节；AI原稿、Task UUID/key/顺序、依赖、引用、说明和假设/风险不改。重算weekly_minutes，新数值可能与原步骤文字不一致，仍需用户核对；time_fit/cost/scheduling与draft/unverified标志保持，不形成核心PlanVersion或批准日历。

GET/POST `/api/v1/goals/{id}/draft-reviews?attempt_id={UUID}` 要求会话、Goal/来源owner及已成功原稿。GET返回source、按revision倒序的最多20份reviews/current_revision/can_edit；POST幂等键和JSON包含expected_goal_revision、expected_review_revision、changes，以及可选weekly_capacity_minutes（见下节），changes每项task_id/duration_minutes/frequency_per_week，最多6个唯一任务。没有实际改变422；值/字段/任务非法422；旧Goal、policy、审阅版本或键冲突409；未拥有对象404，匿名401。保存200，receipt_revision说明本请求保存的版本，不混淆最新版本；重放不再插入。

0013为plan_draft_reviews建立源attempt/Goal/owner复合外键及唯一attempt+revision/owner+key。每次只INSERT不可变快照、revision1–20；单条条件INSERT再次核对Goal/来源版本/状态/policy及MAX审阅revision，防并发覆盖。Goal/来源删除级联清私有审阅。不涉及模型/搜索/每日生成用量/Goal或Slot更新。

输入先显示基准版本，读取最新状态保留未提交输入；如果已有另一版本，禁用保存，明确加载最新并确认替换后再调整。保存历史摘要显示版本/投入/时间，AI原稿仍在原草稿页；逐版任务详情选择/回退待实现。未提交输入只保留同页内存，不承诺跨Reload/账号持久；返回按钮有放弃确认，前轮用户已确认任务数字输入/保存恢复正常；系统返回与本轮新增可用时间输入真机尚未验证。

状态变化或20份上限后只读，明确说明；保存不代表符合时间预算或健康适用性。任务内容编辑、删除任务/依赖、完整资源/预算、接受计划、入历均尚未实现。部署与验证进度见[TODO](TODO.md)。

## 每周可用时间与总量比较（2026-10-11）

审阅页新增用户填写的每周可用分钟，0–10080整数、null表示未知。保存与任务调整同一不可变审阅版本，允许只改可用时间；POST可选weekly_capacity_minutes，旧客户端省略则继承前版，明确null清空。原有请求负载和幂等回执保持，旧版本迁移后为NULL，不从自由文本或AI推断。GET每份review返回该字段；客户端校验范围并在加载/保存/重进时恢复，刷新或版本冲突保留输入。

总量比较按所有任务duration×frequency之和，显示未知、超出、刚好或剩余分钟。跨阶段任务未必同周执行，这是全部任务每周执行的估算，不是排程可行性判定；超出仍可保存待审草稿，不自动删任务、模型修订或批准。没有修改Goal/Slot、time_fit或日历；具体可用日期/时区/时间窗、截止、冲突/间隔、金钱预算和专业适用性仍待实现。0014仅追加nullable受CHECK约束的列，不覆写已有快照。
