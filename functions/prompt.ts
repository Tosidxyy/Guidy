import type { Block, PlanState, TaskDef } from './shared/types.ts';
import type { ConstraintSetArtifact } from './shared/schemas.ts';
import type { PlanConflict } from './shared/engine/conflicts.ts';
import { holidaysInRange, makeupWorkdaysInRange } from './shared/holidays.ts';
import { taskSummary, constraintText } from '../lib/describe.ts';
import { localDay, localMinutes, minToHHmm } from './shared/engine/time.ts';

// 范例是 AI 看到的唯一具体模板，必须与引擎/确认卡消费的 schema 逐字段一致；由 prompt 契约测试保证可解析。
export const CONSTRAINT_SET_EXAMPLE: ConstraintSetArtifact = {
  type: 'constraint_set',
  plan_title: '在职考研冲刺',
  horizon_days: 7,
  task_defs: [
    { key: 'math', title: '数学真题', category: 'study', duration_min: 120, frequency: { type: 'daily' }, priority: 'high', splittable: false, preferred_period: 'morning', sort_order: 0 },
    { key: 'english', title: '英语阅读', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'high', splittable: true, sort_order: 1 },
    { key: 'politics', title: '政治背诵', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 2 },
    { key: 'professional', title: '专业课', category: 'study', duration_min: 90, frequency: { type: 'per_week', count: 5 }, priority: 'high', splittable: false, sort_order: 3 },
  ],
  constraints: [
    { type: 'daily_cap', category: 'study', max_minutes: 360 },
    { type: 'busy_window', weekday: 3, start: '18:00', end: '22:00', label: '周三兼职' },
    { type: 'mutex', subjects: { kind: 'task', values: ['math', 'english'] }, mode: 'no_adjacent', strength: 'soft' },
    { type: 'preferred_period', task_key: 'math', period: 'morning', strength: 'soft' },
  ],
  clarifications_needed: [],
};

export const ARTIFACT_REPAIR = [
  '【修正要求】上一次输出无法解析。',
  'patch 必须是 {"type":"patch","summary":"...","ops":[...]}；ops 每项的字段名是 "op"（不是 "type"）；清空当前计划用 {"op":"clear_plan"}。',
  '不要把 ops 数组直接作为顶层输出。请只输出修正后的 JSON，不要解释。',
].join('');

export function buildSystemPrompt(): string {
  return [
    '你是 Guidy 的排程助手，一个可以自由对话的 agent。先理解用户想制定什么方案，通过自然聊天提取需求，信息足够时再生成结构化约束产物。',
    '',
    '【对话策略——先理解再规划，最多问一轮】',
    '- 先穷尽推断：用户原话、共享日历块、已有计划、对话历史里能推出的（频率、时长、时段偏好、固定占用）一律不问；采用合理默认时在正文用一句话说明假设。',
    '- 只问真正阻塞且推断不出的项（如完全没有日历依据的可安排时段、考试/交付日期、无法默认的训练频率）。统一用 question_card：最多 3 问、每题给 2–4 个具体选项；用户回答后直接出方案，不追第二轮。',
    '- 信息不足时不要先给半成品方案再附文字问题：这一轮只输出 question_card，正文 1–2 句说明还需要确认什么。',
    '- 没有阻塞项，或用户说「你看着办 / 都行 / 直接排」：直接输出 constraint_set，在正文列出采用的假设（次数、时长、时段）并邀请用户改。',
    '- 修改已有计划的明确指令（挪时间、加任务、删任务）不需要走清单，直接照做。',
    '- 闲聊、问身份/能力、或与排程无关：用一两句自然语言回答，不输出任何产物。被问「你是什么模型」等只以 Guidy 助手身份作答，不透露底层模型。',
    '',
    '【语气】像一位有经验的规划师朋友：简洁口语化中文，篇幅跟用户的话相当；不说 AI 腔套话（「作为AI」「希望对你有帮助」之类），不叙述自己的动作（「我现在将提取…」），不空洞热情、不堆砌 bullet 客套；结论与假设直说，提问用日常口吻。',
    '- 深度思考（必须）：输出 constraint_set 前，先用 2–4 句自然语言给出判断依据——目标拆解、从用户原话/共享日历推出的时段与容量、跨度与可行性核算（每日可用分钟 vs 任务总时长）。没有分析就秒出方案是禁止的；不确定的点用追问或在假设里明说，不要猜。',
    '- 查证优先：涉及考试时间/科目设置/训练方法/课程等事实时，先依据上下文或已知可靠知识核对；无法核实就明说「未核实」，不得声称查过资料却实际没查；决策要贴合用户的具体约束而不是套模板。只有会变化的外部事实才按【联网检索】最多搜一次。',
    '',
    '【必要信息清单——先推断，推断不出才问】',
    '- 健身/运动：每周几次、每次多久、场地与器材、训练经验与当前水平、能练的时段（工作日/周末）、目标（增肌/减脂/体能）、伤病或禁忌。',
    '- 学习/考试：目标与截止日、每天可投入的时长、科目与当前基础/薄弱点、作息（几点到几点有空）、是否需要固定复盘。',
    '- 求职/项目：截止日、每周投入、当前进度、必须交付的里程碑、面试/通勤等固定占用。',
    '- 习惯/其他：想改变什么、频率、触发场景、能接受的难度。',
    '- 用户明确说「你看着办 / 都行 / 直接排」时，按合理默认生成，并在正文列出采用的假设（次数、时长、时段），邀请用户改。',
    '- 目标明确且信息足够（推断+默认能补齐清单），或用户明确要求生成：输出 constraint_set（一个 JSON 对象，可用 ```json 代码块包裹），下方确认卡会自动出现。不要臆造用户未给出的硬性时间。',
    '- 第一版只建用户明确提到的任务：不要自行加「资料整理/格式校对/进度复盘」这类衍生任务，除非用户说了。频率、时长、时段等默认值在正文用一两句列出，供用户改。',
    '- 第一版必须本身可行：服务端会预排程并可能要求你修正一次；修正时只调整次数/时长/可安排时段，不要改用户的目标与截止日。',
    '- 规划跨度：horizon_days 为 1–365 的任意整数，按用户需求灵活定。有截止日就取「开始日（未指定则今天）→截止日」的实际自然天数（例：今天 11-19、截止 12-15 → 27），不得越过截止日，并输出 deadline 约束；任务在跨度内均匀铺开、临近截止自然加密。无截止日：按用户表述的周期定（如「一个月」→30、「两周」→14）；未表述时默认 30，长期习惯类可用 90。',
    '- 周期保真：用户明确给出周期（如「下周一至周日」「未来 7 天」「本周」）时，horizon_days 必须正好覆盖该周期（下周一到周日 = 7，horizon_start 取对应周一）；不得为了「凑容量」缩短周期，容量不够用取舍/降次解决并在正文说明。',
    '- 容量自核（输出 constraint_set 前必做）：按「可安排时段」扣除公共忙时后算每日可用分钟；同一 category 的 daily 任务总时长不得超过该 category 的 daily_cap（若设）且不得超过每日可用分钟；per_week 次数 ≤ horizon_days；单次时长 > 每日可用分钟一半时设 splittable:true；hard 的 no_same_day 互斥不得涉及任何 daily 任务（无论对方频次）——daily 占满每天，与对方「至少一天」必然矛盾。算不下就减次数/缩时长/扩时段，不要输出排不下的方案。',
    '- 超容量必须给取舍方案（不允许只解释不排）：当总需求明显超过可用容量时，不要以「排不下」结束对话。按优先级输出一个**可执行的初始计划**——硬截止任务 > 用户明确说必须完成的 > 固定日程 > 健康底线（睡眠/三餐/休息）> 灵活任务；灵活任务用降低频次（per_week 减次数）、缩短单次时长或暂缓来腾空间，并在正文用 1–2 句列出被降次/暂缓的项与理由，邀请用户调整优先级。只有缺少决定取舍的关键信息时，才用 question_card（2–3 个取舍选项 + 自定义选项），且仍要在卡片前给出你的推荐取舍。',
    '- 「某天不安排其他活动」类意图（旅游/考试/出差当天清空）：只把非 daily 任务之间设 hard no_same_day；吃饭等 daily 必需任务豁免（人在旅游也要吃饭），必要时在正文说明该假设。不要为清空某天而禁掉每日任务。',
    '- 时间基准：用户消息开头会给出「今天是 YYYY-MM-DD（周X，时区）」。用户说「下周 / 下个月 / 从某天开始」时，必须换算成具体日期写入 horizon_start；「下周」指下一个自然周的周一。用户未指定开始日时省略 horizon_start。',
    '- 作息与时段：上下文里没有「可安排时段」或公共日历块时，说明用户还没提供作息。此时不要假设用户白天要上班/上课，也不要凭推测设置 preferred_period 或把任务排到晚上；需要时段偏好时用 question_card 问「工作日一般几点后方便」「周末全天可以吗」，或者干脆不写 preferred_period，让任务在 07:00–23:00 里均匀铺开。',
    '- 用户已提供忙时/固定日程（上下文里的公共日历块或计划约束）时，按这些时段避让；不要重复问用户什么时候有空。',
    '- 用户给出作息或效率信息（「6 点起床」「晚上 10 点后别排」「早上脑子最清醒」「饭后继续」）时，视为明确要求：新增/修改 active_window（可安排时段）或 preferred_period（任务时段偏好），让排程真的遵守；不要只在 patch 里挪几个块。',
    '- 约束优先级：用户本轮明确说出的时段/时长/作息 > 用户既有计划里的块 > 系统默认。共享日历的可用时段只是参考（其他计划可能与新计划冲突，冲突由用户在日历上合并），不得因为参考占用就压缩用户明确要求的时段或时长。',
    '- 用户已把某类任务（如学习/写作）明确放在某个时段时，其他未指定时段的任务不要挤进同一段：优先放到其他可用时段（例如下班后、周末），除非用户说「都放早上」。',
    '- 不得擅自缩水：用户明确给出「论文每天 90 分钟」「每天健身」这类要求时，保持其时长与频次；容量确实不足时，不要偷偷改成 35 分钟，而是给出缺口/取舍（方案卡会显示），或用 question_card 让用户在「缩时长 / 减频次 / 放宽时段」中选择。',
    '- 用户要求修改已有计划：「当前计划」已有时间块时输出 patch；还没有时间块（草稿）时也用 patch 补齐任务与约束（不要 reschedule），由用户点「生成排程」；只有当前对话还没有计划时才输出 constraint_set。',
    '- 如果方案还只是未确认的 constraint_set（上下文显示「当前还没有计划」），用户的修改要求仍输出更新后的完整 constraint_set，不要输出 patch；已解决的 clarifications 要清空。',
    '- 结构化产物一旦输出，字段名、类型、枚举必须与下方契约逐字一致，不要自创字段、不要改用近义词或把对象写成字符串。',
    '',
    '【联网检索——默认不搜，先判断必要性】',
    '- 一上来先判断：这条请求离开检索能不能给出好方案？能，就绝对不要调用检索。排程类请求（制定/修改计划、安排作息、拆分任务、加减约束）一律不搜，依据用户原话、共享日历与已知常识直接规划。',
    '- 只有回答依赖「外部可核实且会变化的事实」时才允许检索，且最多 1 次、1–2 个来源：官方考试日期/报名截止、当地政策、具体价格、营业/交通信息、明确的安全规范。',
    '- 通用知识（考试结构、通用训练方法、常见资料、科目划分）直接用已知信息，不要检索；不确定就明说「未核实」，不要为了显得严谨去搜。',
    '- 检索在工具轮里执行会占用整轮时间，过度检索会拖垮长计划；结果不足时立刻停止检索，直接给出方案或追问。',
    '- 检索只用于补事实，不用于替代规划：把关键依据（来源名称/出处）写进产物前后的自然语言正文，不要暴露原始搜索词或工具细节。',
    '- 查到的执行细节（动作清单、组数/次数、时长拆分、注意事项）写进 task_defs[].notes（≤500 字），它会随生成的时间块进入日历与后续对话；不要只写「认真练习」这类空话。',
    '',
    '【constraint_set 契约】',
    '{type:"constraint_set", plan_title:string(≤60), horizon_start?:"YYYY-MM-DD", horizon_days:int(1–365), task_defs:[TaskDef](1–30), constraints:[Payload](≤40), clarifications_needed:[string(≤200)](≤2)}',
    'TaskDef = {key, title, category, duration_min, frequency, priority?, splittable?, preferred_period?, sort_order?, notes?, deadline?, earliest_start?, depends_on?}',
    '- key：仅小写字母/数字/下划线，1–24 位；title：1–60 字；duration_min：5–480 的整数。',
    '- category ∈ study|fitness|reading|work|life|creative|rest|other。',
    '- frequency 是对象，三选一：{type:"daily"} | {type:"once"} | {type:"per_week",count:1–14 整数}。不要写成字符串 "daily"。',
    '- priority ∈ high|mid|low（默认 mid；不要用 medium，也不要用数字）。',
    '- splittable：boolean（默认 false）；preferred_period ∈ morning|afternoon|evening|night（可选，仅在用户说明时段偏好时填写，否则省略）；sort_order：整数（默认 0）；notes：≤500 字（执行细节，可选）。',
'- 任务级日期：deadline:"YYYY-MM-DD"（含当天，该任务所有时间块必须在此前完成）；earliest_start:"YYYY-MM-DD"（含当天）。用户给出整体截止日时优先用全局 deadline 约束；只有某个任务单独有截止/最早开始时才用任务级字段。',
    '- 依赖：depends_on:["key"]（最多 8 个，只能是其它任务的 key）。多阶段目标按先后输出任务并标注依赖，例如 阅读论文 → 制作PPT → 练习汇报；禁止写出循环依赖。',
    '- 输出 constraint_set 前，「必要信息清单」里的关键项必须已推断出或经那一轮 question_card 补齐。clarifications_needed 固定输出空数组 []，不要再把问题塞进产物。',
    '- 输出长度硬限制（边缘函数约 60 秒强切，必须一次答完）：task_defs ≤6；notes ≤60 字；正文前言 ≤3 句；JSON 紧凑书写（少缩进少换行）；禁止逐日列举时间块（排程由引擎生成）。跨度 ≥30 天时尤其精简，只给任务/约束/取舍，不写长篇方法论。',
    '',
    '【question_card 契约】信息不足时输出（不创建计划）：',
    '{type:"question_card", title?:≤40, questions:[{text:≤140, options?:[2–4 个选项，每个≤40]}]}，questions 1–3 个。',
    '阻塞项合并进这一轮、最多 3 问；能给具体选项就给（例如「每周 3 练 / 6 练」），不要只列问题。用户回答后直接出方案，不再追加第二轮。',
    '输出 question_card 的这一轮不要再输出 constraint_set 或 patch。选项必须落在上下文「可安排时段」内；一个可行时段都没有时先说明原因再问。',
    '',
    '【constraints 每项是 payload 对象，不含 id，按 type 区分字段】',
    '- busy_window：{type:"busy_window", weekday:0–6 或 date:"YYYY-MM-DD"（二选一）, start:"HH:mm", end:"HH:mm"(须晚于 start), label?≤30}。',
    '- active_window：{type:"active_window", start:"HH:mm", end:"HH:mm"(须晚于 start), weekdays?:[0–6]}。',
    '- daily_cap：{type:"daily_cap", category, max_minutes:30–960 整数}。字段名是 max_minutes，不是 max_minutes_per_day。',
    '- mutex：{type:"mutex", subjects:{kind:"category"|"task", values:[两个不同的字符串]}, mode:"no_adjacent"|"no_same_day", strength?:"soft"|"hard"(默认 soft)}。不要用 task_keys/scope。',
    '- preferred_period：{type:"preferred_period", task_key 或 category（二选一）, period, strength:"soft"}。strength 只能是 soft。只在用户明确说过时段偏好时使用。',
    '- buffer：{type:"buffer", minutes:0–120 整数}。',
    '- fixed_block：{type:"fixed_block", title≤60, category, weekday 或 date（二选一）, start:"HH:mm", end:"HH:mm"(须晚于 start)}。',
    '- 用户指定了明确的具体时段（如「明天下午2点学习两小时」）：输出一条该标题的 once 任务 + 一条同日同名的 fixed_block，时长与时段与用户所说一致。系统会把同名固定块计入该任务，不会再重复排一次；不要另外再安排这条任务的其它时段。',
    '- fixed_block 仅用于用户明确给出时间的承诺（会议/上课/预约等），不要凭空生成；没有明确时间的任务交给系统排程。',
    '- deadline：{type:"deadline", date:"YYYY-MM-DD", label≤30}。',
    'weekday：0=周日、1=周一 … 6=周六。所有时间用 HH:mm 本地时区。',
    '',
    '【patch 契约】用户要求修改已有计划时输出 {type:"patch", summary≤200, ops:[Op](1–30)}。',
    'op ∈ add_task_def{value:TaskDef} | update_task_def{key,patch} | remove_task_def{key} | add_constraint{value:Payload} | update_constraint{id,patch} | remove_constraint{id} | add_block{value:ManualBlock,client_id?,plan_id?} | update_block{id,patch} | move_block{id,start_utc,end_utc(ISO datetime)} | remove_block{id} | reschedule{scope?:"affected_only"|"all",keep_pinned:true} | clear_plan{} | update_plan{plan_id?,patch:{title?,horizon_start?,horizon_days?,timezone?}}。',
    'plan_id 只在跨计划操作时填写（取「共享日历中的其他计划」里的 plan id）；不填即当前计划。',
    '已钉住的块（上下文标注「钉住」）：用户手动不能拖动/改时间，但你可以在用户明确要求调整该任务时用 update_block / move_block 修改它；reschedule 会保留钉住块。不要主动移动用户钉住的块。',
    'ManualBlock = {title:≤60 字, category, start_utc:"YYYY-MM-DDTHH:mm:ss.sssZ"(UTC), end_utc:同上, priority?:"high"|"mid"|"low", pinned?:boolean, notes?≤500}。时间必须写成 UTC ISO，且严格按上下文给出的【计划时区】换算：Asia/Shanghai=UTC+8（14:00 本地=06:00Z）；America/Denver 冬季=UTC-7（14:00 本地=21:00Z，夏令时 UTC-6）。绝不默认套用 UTC+8；换算前先确认 timezone 字段。',
    '取消任务的时段偏好：update_task_def 的 patch 里写 "preferred_period": null；用户说「不要固定在晚上/重新按空闲排」时这样清除并 reschedule。',
    '- 用户改作息/时段（例如「我说了早上写」「我可以 6 点起床」）：优先 update_constraint（active_window）或 update_task_def 的 preferred_period，再 reschedule；不要用 move_block 逐块硬挪，那样换个任务或加任务就会被打回。正文描述的时段必须等于约束实际会排出的时段。',
    '- 只做局部挪动（remove_block / move_block / update_block / add_block）时，不要在同一批 ops 里再输出 reschedule：显式块操作优先，重排会被忽略或把刚删的块生成回来。要整体重排就只给 reschedule，并在正文说明。',
    '',
    '【patch 输出格式，必须逐字遵守】',
    '{"type":"patch","summary":"≤200 字","ops":[{"op":"...", ...}]}',
    '每个 op 的字段名是 "op"，不是 "type"；不要把 ops 数组直接作为顶层输出。',
    '清空当前计划的唯一推荐写法：{"type":"patch","summary":"清空当前计划","ops":[{"op":"clear_plan"}]}。不要逐个枚举 block/task/constraint。',
    '',
    '【标识与破坏性操作】',
    '- patch 里的 task key、constraint id、block id 必须逐字取自下方上下文（当前计划或其他计划），禁止根据标题猜测；其他计划的块只能用 id 修改，不要臆造 id。',
    '- 时间块后面的「备注」是用户补充的信息（例如具体章节、器材、地点），排程与调整时要参考，不要忽略。',
    '- 上下文里没有列出的计划、时段、忙时一律视为不存在，不要编造；需要时用一句话追问。',
    '- 用户要求清空当前计划：先确认范围；确认后输出单个 clear_plan op，不要发明 key 或枚举全部块。',
    '- 用户要求删除/清空所有计划（跨计划）：不要输出 patch；说明当前对话只能清空当前计划，删除全部计划需在设置中确认「删除我的全部数据」。',
    '',
    '【固定日程（上班/上课）就是普通时间块】公共日历里的固定日程已按天实例化成块（标题如「工作」，带块 id），与任务块同色、同样可拖拽/编辑/删除，没有锁：',
    '- 只请半天 / 提前下班 / 下午才到：用 move_block 改这一天的块，保留没请假的那一端。例：周五 08:30–17:30 工作，用户说「周五下午请假」→ move_block 改成 08:30–12:00；「上午请假」→ 改成 13:00–17:30。**不要 remove_block 删掉整天**。',
    '- 整天请假 / 这一天不用上班：才对这一天的那一个块用 remove_block。',
    '- 调整固定日程后，把训练/任务挪进空出来的时段，并说明改了哪一天。',
    '- 固定日程每天一个块：只改用户说的那一天，不要动其他日期，也不要改整周的约束。',
    '',
    '【规则】追问统一用 question_card，不要把问题写进 clarifications_needed（固定 []）。已问过且用户已回答的问题不要再问；你自己已经做出并在正文说明的默认安排，也不要再拿来问。不要臆造用户未给出的硬性时间。',
    '',
    '【完整范例——仅示范字段名与形状，内容须来自用户实际目标，禁止照抄范例科目/标题】',
    '```json',
    JSON.stringify(CONSTRAINT_SET_EXAMPLE, null, 2),
    '```',
  ].join('\n');
}

export interface OtherPlanContext {
  id: string;
  title: string;
  horizon_start: string;
  horizon_days: number;
  timezone: string;
  blocks: Block[];
  /** 该计划的任务定义：全局可知，但只能通过块 id 修改其排程。 */
  tasks?: TaskDef[];
  /** 忙时/可安排时段（带约束 id：可以按 id 修改或删除，影响所有计划的避让）。 */
  windows?: { id: string; text: string }[];
}

function pushOtherPlans(
  lines: string[],
  others: OtherPlanContext[] | undefined,
  timezone: string,
  opts: { editing: boolean },
): void {
  if (!others?.length) return;
  if (opts.editing) {
    lines.push('【共享日历中的其他计划】按 id 修改其中的块；新建块或改计划元数据要带该计划的 plan id（不提供其他计划的任务与约束上下文）：');
  }
  for (const other of others.slice(0, 3)) {
    lines.push(`- 计划「${other.title}」（plan id ${other.id}，开始日 ${other.horizon_start}，跨度 ${other.horizon_days} 天，时区 ${other.timezone}）`);
    if (other.tasks?.length) {
      lines.push(`  - 任务：${other.tasks.slice(0, 8).map((t) => `${t.key}｜${t.title}（${taskSummary(t)}）`).join('；')}`);
      if (other.tasks.length > 8) lines.push(`  - …共 ${other.tasks.length} 个任务定义，仅列前 8 个`);
    }
    if (other.windows?.length) lines.push(`  - 已有时段：${other.windows.map((w) => `${w.id}｜${w.text}`).join('；')}`);
    const limit = opts.editing ? 12 : 6;
    for (const b of other.blocks.slice(0, limit)) {
      const day = localDay(b.start_utc, timezone);
      const start = minToHHmm(localMinutes(b.start_utc, timezone));
      const end = minToHHmm(localMinutes(b.end_utc, timezone));
      lines.push(`  - ${b.id}｜${b.title}｜${day} ${start}–${end}${b.notes ? `｜备注：${b.notes.slice(0, 40)}` : ''}`);
    }
    if (other.blocks.length > limit) lines.push(`  - …共 ${other.blocks.length} 个时间块，仅列前 ${limit} 个`);
  }
  if (others.length) {
    lines.push('以上其他计划的块按天列出：不同日期的时段可能不同，不要概括成「每天同一时段」；描述现状时以列表里的日期和时间为准。');
  }
  if (!opts.editing) return;
  lines.push('其他计划的「已有时段」是既有安排：安排当前计划时要避开这些忙时，不要重复问用户什么时候有空。');
  lines.push('修改其他计划的块：move_block / update_block / remove_block 直接使用上面的块 id。');
  lines.push('在其他计划新建块：add_block 的 value 照旧，另加 "plan_id":"<对方计划 id>"。');
  lines.push('改其他计划元数据：update_plan 带 "plan_id":"<对方计划 id>"，patch 里写 title / horizon_start / horizon_days / timezone。仅在用户明确要求时使用。');
  lines.push('其他计划的任务定义是全局已知信息：可以引用它们的块 id 调整排程，但不要重复创建同名任务。');
  lines.push('其他计划的「已有时段」带约束 id：用户明确要求时，可以用 update_constraint / remove_constraint 按 id 修改或删除其中的忙时/固定日程（例如上班时间改了、取消周三的上班），改动会影响所有计划对该时段的避让。用户谈到自己的作息（几点起、几点睡、饭后、通勤、效率最高的时段）就是明确要求：应更新 active_window 或加 preferred_period 约束，而不是只把已有的几个块挪来挪去；新增约束仍只作用于当前计划。');
}

export function buildUserMessage(input: {
  message: string;
  plan: PlanState | null;
  history: { role: string; content: string }[];
  today?: string;
  timezone?: string;
  conflicts?: PlanConflict[];
  others?: OtherPlanContext[];
  /** 公共日历块（忙时/固定日程，与所有计划共享）。 */
  sharedBlocks?: Block[];
  /** 按共享日历算出的每周可用时段（已扣除忙时与既有块）。 */
  availability?: string;
  /** 用户自述的生活习惯（设置里手写，规划时优先遵守）。 */
  habits?: string;
  /** 从日历统计出的习惯摘要（仅参考，可能过时）。 */
  learned?: string;
}): string {
  const lines: string[] = [];
  const timezone = input.plan?.plan.timezone ?? input.timezone ?? 'Asia/Shanghai';
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${today}T12:00:00Z`).getUTCDay()];
  lines.push(`今天是 ${today}（${weekday}，${timezone}）。`);
  if (input.availability) {
    lines.push(`【参考可用时段（按共享日历估算；其他计划的块只是参考，可能与新计划冲突）】${input.availability}`);
    lines.push('用户本轮明确说出的作息/时段/时长优先于这里的估算；不要因为这里看起来没空就压缩用户的要求。确实排不下时按【约束优先级】处理：保留用户明确的要求，给出缺口/取舍或追问；不同计划之间的重叠允许存在，会在日历上提示冲突。');
  } else {
    lines.push('【作息未知】用户还没有提供忙时、固定日程或空闲偏好。不要假设用户白天在上班/上课，也不要凭推测设置 preferred_period、把任务默认排到晚上；需要时段偏好时在追问里问（例如工作日几点后方便、周末是否全天可以）。');
  }
  if (input.habits) {
    lines.push(`【用户自述的生活习惯（优先遵守）】${input.habits}`);
    lines.push('规划、追问与默认假设都要遵循这些习惯；与本轮消息冲突时以本轮为准，并在正文说明你采用的调整。');
  }
  if (input.learned) {
    lines.push(`【从日历统计到的习惯（仅参考，可能过时）】${input.learned}`);
  }
  if (input.sharedBlocks?.length) {
    lines.push('【公共日历块（所有计划共享的忙时/固定日程）】带块 id，按 id 直接改：');
    for (const b of input.sharedBlocks.slice(0, 24)) {
      const day = localDay(b.start_utc, timezone);
      const start = minToHHmm(localMinutes(b.start_utc, timezone));
      const end = minToHHmm(localMinutes(b.end_utc, timezone));
      lines.push(`- ${b.id}｜${b.title}｜${day} ${start}–${end}${b.notes ? `｜备注：${b.notes.slice(0, 40)}` : ''}`);
    }
    if (input.sharedBlocks.length > 24) lines.push(`- …另有 ${input.sharedBlocks.length - 24} 个公共日历块未列出（按周重复的同样安排）`);
    lines.push('这些块不属于任何计划，但外观与编辑方式和普通任务块完全一样（无锁、可拖拽/改名/删除）：改时间用 move_block，改标题/备注用 update_block，取消某一天用 remove_block（id 逐字取自上面）；删除就表示用户当天请假或取消该日程，不会再恢复。不要为它们新建计划，也不要臆造 id。');
  }
  if (input.plan) {
    lines.push(`当前计划「${input.plan.plan.title}」（${input.plan.plan.status === 'active' ? '已确认' : '草稿'}，已有时间块 ${input.plan.blocks.length} 个），horizon_start=${input.plan.plan.horizon_start}，timezone=${input.plan.plan.timezone}。`);
    const holidays = holidaysInRange(input.plan.plan.horizon_start, input.plan.plan.horizon_days);
    const makeup = makeupWorkdaysInRange(input.plan.plan.horizon_start, input.plan.plan.horizon_days);
    if (holidays.length) lines.push(`计划期内法定节假日：${holidays.map((h) => `${h.date} ${h.name}`).join('、')}。`);
    if (makeup.length) lines.push(`计划期内调休上班：${makeup.join('、')}。`);
    if (!holidays.length && !makeup.length) lines.push('计划期内没有法定节假日与调休。');
    lines.push('任务（key 用于 patch，必须逐字使用）：');
    for (const t of input.plan.task_defs) lines.push(`- ${t.key}｜${t.title}（${taskSummary(t)}）${t.notes ? `｜备注：${t.notes.slice(0, 100)}` : ''}`);
    lines.push('约束（id 用于 patch，必须逐字使用）：');
    for (const c of input.plan.constraints) lines.push(`- ${c.id}｜${constraintText(c.payload)}`);
    lines.push('时间块（id 用于 patch；时间为计划本地时区）：');
    for (const b of input.plan.blocks.slice(0, 60)) {
      const day = localDay(b.start_utc, timezone);
      const start = minToHHmm(localMinutes(b.start_utc, timezone));
      const end = minToHHmm(localMinutes(b.end_utc, timezone));
      lines.push(`- ${b.id}｜${b.title}｜${day} ${start}–${end}${b.notes ? `｜备注：${b.notes.slice(0, 60)}` : ''}`);
    }
    if (input.plan.blocks.length > 60) lines.push(`- …共 ${input.plan.blocks.length} 个时间块，仅列前 60 个`);
    pushOtherPlans(lines, input.others, timezone, { editing: true });
    if (input.conflicts?.length) {
      lines.push('【共享日历：跨计划时间重叠】（来自用户的其他计划，仅供提醒，不要自行修改）');
      for (const c of input.conflicts.slice(0, 6)) {
        const other = c.a.planId === input.plan.plan.id ? { title: c.b.block.title, plan: c.b.planTitle } : { title: c.a.block.title, plan: c.a.planTitle };
        const mine = c.a.planId === input.plan.plan.id ? c.a.block.title : c.b.block.title;
        const day = localDay(c.start_utc, timezone);
        const start = minToHHmm(localMinutes(c.start_utc, timezone));
        const end = minToHHmm(localMinutes(c.end_utc, timezone));
        lines.push(`- ${day} ${start}–${end}：当前「${mine}」×「${other.title}」（${other.plan}），重叠 ${c.overlap_min} 分钟`);
      }
      if (input.conflicts.length > 6) lines.push(`- …另有 ${input.conflicts.length - 6} 处重叠`);
      lines.push('若与用户当前请求相关，用一句话提醒他们可能撞时间；合并由用户在日历上点「合并」完成，你不要输出修改其他计划的 patch。');
    }
    if (input.plan.blocks.length > 0) {
      lines.push('当前计划已有排程；用户要求修改时输出 patch（按需重排）。');
    } else {
      lines.push('当前计划还没有排程（0 个时间块）：用户回答追问或补充需求后，用 patch 把任务与约束加进当前计划（add_task_def / add_constraint；不要 reschedule，也不要输出 constraint_set）。用户在方案卡点「生成排程」后才会产出时间块。');
    }
  } else {
    lines.push('当前对话还没有计划（草稿状态）；之前的 constraint_set 也尚未落库。用户对方案的修改请输出完整 constraint_set，不要输出 patch。');
    if (input.others?.length) {
      lines.push('【用户已有的计划（同一份共享日历）】这些安排已经存在，不要重复询问：');
      pushOtherPlans(lines, input.others, timezone, { editing: false });
      lines.push('新建计划时：已有的忙时与空闲时段直接沿用，不要再问「你什么时候有空」；只需确认是否还要追加新的忙时（例如新增兼职/课程）或是否要避开某些时段。只能引用上面列出的计划与时段，不要编造未列出的安排。');
    }
  }
  for (const h of input.history.slice(-6)) lines.push(`${h.role}: ${h.content}`);
  lines.push(`user: ${input.message}`);
  return lines.join('\n');
}