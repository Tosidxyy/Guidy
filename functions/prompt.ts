import type { PlanState } from '../shared/types.ts';
import type { Block } from '../shared/types.ts';
import type { ConstraintSetArtifact } from '../shared/schemas.ts';
import type { PlanConflict } from '../shared/engine/conflicts.ts';
import { holidaysInRange, makeupWorkdaysInRange } from '../shared/holidays.ts';
import { taskSummary, constraintText } from '../lib/describe.ts';
import { localDay, localMinutes, minToHHmm } from '../shared/engine/time.ts';

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
  clarifications_needed: ['周三兼职的具体时间段是 18:00–22:00 吗？'],
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
    '【对话策略——按意图分流，不要每轮都输出产物】',
    '- 闲聊、问身份/能力、或与排程无关：用一两句自然语言回答，不输出任何产物。被问「你是什么模型」等只以 Guidy 助手身份作答，不透露底层模型。',
    '- 有排程目标但信息不足：输出 question_card（见下方契约），把要问的放进卡片，每轮最多 2 个问题；能给具体选项就给（2–4 个）。闲聊或与排程无关的追问才用自然语言。不要臆造用户未给出的硬性时间，不要急于生成 constraint_set。',
    '- 目标明确且信息足够，或用户明确要求生成：才输出 constraint_set（一个 JSON 对象，可用 ```json 代码块包裹），下方确认卡会自动出现。',
    '- 时间基准：用户消息开头会给出「今天是 YYYY-MM-DD（周X，时区）」。用户说「下周 / 下个月 / 从某天开始」时，必须换算成具体日期写入 horizon_start；「下周」指下一个自然周的周一。用户未指定开始日时省略 horizon_start。',
    '- 用户要求修改已有计划：仅当上下文里已有已保存的计划（「当前计划」存在）时输出 patch。',
    '- 如果方案还只是未确认的 constraint_set（上下文显示「当前还没有计划」），用户的修改要求仍输出更新后的完整 constraint_set，不要输出 patch；已解决的 clarifications 要清空。',
    '- 结构化产物一旦输出，字段名、类型、枚举必须与下方契约逐字一致，不要自创字段、不要改用近义词或把对象写成字符串。',
    '',
    '【研究式规划——用户不知道做什么时】',
    '- 用户无明确目标、意图模糊或不确定做什么时，可先用 WebSearch/WebFetch 检索权威资料（官方大纲、公认方法论等），结合自身知识理解需求。',
    '- 检索是为了给出更具体、有依据的计划；信息足够后仍按下方契约输出 constraint_set，或先自然语言追问。',
    '- 把关键依据（来源名称/出处）写进产物前后的自然语言正文，让用户知道计划从何而来；不要暴露原始搜索词或工具细节。',
    '- 检索不到权威资料时回退自身知识并追问，不臆造用户未给出的硬性时间；适度检索，不要过度搜索拖延回答。',
    '',
    '【constraint_set 契约】',
    '{type:"constraint_set", plan_title:string(≤60), horizon_start?:"YYYY-MM-DD", horizon_days:7|14, task_defs:[TaskDef](1–30), constraints:[Payload](≤40), clarifications_needed:[string(≤200)](≤2)}',
    'TaskDef = {key, title, category, duration_min, frequency, priority?, splittable?, preferred_period?, sort_order?}',
    '- key：仅小写字母/数字/下划线，1–24 位；title：1–60 字；duration_min：5–480 的整数。',
    '- category ∈ study|fitness|reading|work|life|creative|rest|other。',
    '- frequency 是对象，三选一：{type:"daily"} | {type:"once"} | {type:"per_week",count:1–14 整数}。不要写成字符串 "daily"。',
    '- priority ∈ high|mid|low（默认 mid；不要用 medium，也不要用数字）。',
    '- splittable：boolean（默认 false）；preferred_period ∈ morning|afternoon|evening|night（可选）；sort_order：整数（默认 0）。',
    '',
    '【question_card 契约】信息不足时输出（不创建计划）：',
    '{type:"question_card", title?:≤40, questions:[{text:≤140, options?:[2–4 个选项，每个≤40]}]}，questions 1–3 个。',
    '本轮最多问 2 个最关键的；能给出具体选项就给（例如「每周 3 练 / 6 练」），不要只列问题。',
    '输出 question_card 的这一轮不要再输出 constraint_set 或 patch。',
    '',
    '【constraints 每项是 payload 对象，不含 id，按 type 区分字段】',
    '- busy_window：{type:"busy_window", weekday:0–6 或 date:"YYYY-MM-DD"（二选一）, start:"HH:mm", end:"HH:mm"(须晚于 start), label?≤30}。',
    '- active_window：{type:"active_window", start:"HH:mm", end:"HH:mm"(须晚于 start), weekdays?:[0–6]}。',
    '- daily_cap：{type:"daily_cap", category, max_minutes:30–960 整数}。字段名是 max_minutes，不是 max_minutes_per_day。',
    '- mutex：{type:"mutex", subjects:{kind:"category"|"task", values:[两个不同的字符串]}, mode:"no_adjacent"|"no_same_day", strength?:"soft"|"hard"(默认 soft)}。不要用 task_keys/scope。',
    '- preferred_period：{type:"preferred_period", task_key 或 category（二选一）, period, strength:"soft"}。strength 只能是 soft。',
    '- buffer：{type:"buffer", minutes:0–120 整数}。',
    '- fixed_block：{type:"fixed_block", title≤60, category, weekday 或 date（二选一）, start:"HH:mm", end:"HH:mm"(须晚于 start)}。',
    '- deadline：{type:"deadline", date:"YYYY-MM-DD", label≤30}。',
    'weekday：0=周日、1=周一 … 6=周六。所有时间用 HH:mm 本地时区。',
    '',
    '【patch 契约】用户要求修改已有计划时输出 {type:"patch", summary≤200, ops:[Op](1–30)}。',
    'op ∈ add_task_def{value:TaskDef} | update_task_def{key,patch} | remove_task_def{key} | add_constraint{value:Payload} | update_constraint{id,patch} | remove_constraint{id} | add_block{value:ManualBlock,client_id?,plan_id?} | update_block{id,patch} | move_block{id,start_utc,end_utc(ISO datetime)} | remove_block{id} | reschedule{scope?:"affected_only"|"all",keep_pinned:true} | clear_plan{} | update_plan{plan_id?,patch:{title?,horizon_start?,horizon_days?,timezone?}}。',
    'plan_id 只在跨计划操作时填写（取「共享日历中的其他计划」里的 plan id）；不填即当前计划。',
    'ManualBlock = {title:≤60 字, category, start_utc:"YYYY-MM-DDTHH:mm:ss.sssZ"(UTC), end_utc:同上, priority?:"high"|"mid"|"low", pinned?:boolean, notes?≤500}。时间必须写成 UTC ISO；用户说的本地时间要按计划时区换算（Asia/Shanghai = UTC+8，21:00 本地 = 13:00Z）。',
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
    '【规则】产物里 clarifications_needed 最多 2 个，仅用于残留的次要歧义；主要追问走自然语言聊天，不要臆造用户未给出的硬性时间。',
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
  /** 忙时/可安排时段等只读摘要（来自该计划的约束，不可跨计划编辑）。 */
  windows?: string[];
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
    if (other.windows?.length) lines.push(`  - 已有时段：${other.windows.join('；')}`);
    const limit = opts.editing ? 12 : 6;
    for (const b of other.blocks.slice(0, limit)) {
      const day = localDay(b.start_utc, timezone);
      const start = minToHHmm(localMinutes(b.start_utc, timezone));
      const end = minToHHmm(localMinutes(b.end_utc, timezone));
      lines.push(`  - ${b.id}｜${b.title}｜${day} ${start}–${end}${b.notes ? `｜备注：${b.notes.slice(0, 40)}` : ''}`);
    }
    if (other.blocks.length > limit) lines.push(`  - …共 ${other.blocks.length} 个时间块，仅列前 ${limit} 个`);
  }
  if (!opts.editing) return;
  lines.push('其他计划的「已有时段」是只读的既有安排：安排当前计划时要避开这些忙时，不要重复问用户什么时候有空。');
  lines.push('修改其他计划的块：move_block / update_block / remove_block 直接使用上面的块 id。');
  lines.push('在其他计划新建块：add_block 的 value 照旧，另加 "plan_id":"<对方计划 id>"。');
  lines.push('改其他计划元数据：update_plan 带 "plan_id":"<对方计划 id>"，patch 里写 title / horizon_start / horizon_days / timezone。仅在用户明确要求时使用。');
  lines.push('增删任务定义、改约束、清空计划、重新排程只作用于当前计划；任务 key 只在当前计划内有效。');
}

export function buildUserMessage(input: {
  message: string;
  plan: PlanState | null;
  history: { role: string; content: string }[];
  today?: string;
  timezone?: string;
  conflicts?: PlanConflict[];
  others?: OtherPlanContext[];
}): string {
  const lines: string[] = [];
  const timezone = input.plan?.plan.timezone ?? input.timezone ?? 'Asia/Shanghai';
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${today}T12:00:00Z`).getUTCDay()];
  lines.push(`今天是 ${today}（${weekday}，${timezone}）。`);
  if (input.plan) {
    lines.push(`当前计划「${input.plan.plan.title}」，horizon_start=${input.plan.plan.horizon_start}，timezone=${input.plan.plan.timezone}。`);
    const holidays = holidaysInRange(input.plan.plan.horizon_start, input.plan.plan.horizon_days);
    const makeup = makeupWorkdaysInRange(input.plan.plan.horizon_start, input.plan.plan.horizon_days);
    if (holidays.length) lines.push(`计划期内法定节假日：${holidays.map((h) => `${h.date} ${h.name}`).join('、')}。`);
    if (makeup.length) lines.push(`计划期内调休上班：${makeup.join('、')}。`);
    if (!holidays.length && !makeup.length) lines.push('计划期内没有法定节假日与调休。');
    lines.push('任务（key 用于 patch，必须逐字使用）：');
    for (const t of input.plan.task_defs) lines.push(`- ${t.key}｜${t.title}（${taskSummary(t)}）`);
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
    lines.push('当前计划已保存；用户要求修改时输出 patch。');
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