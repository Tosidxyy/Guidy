import type { PlanState } from '../shared/types.ts';
import type { ConstraintSetArtifact } from '../shared/schemas.ts';
import { taskSummary, constraintText } from '../lib/describe.ts';

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

export function buildSystemPrompt(): string {
  return [
    '你是 Guidy 的排程助手，一个可以自由对话的 agent。先理解用户想制定什么方案，通过自然聊天提取需求，信息足够时再生成结构化约束产物。',
    '',
    '【对话策略——按意图分流，不要每轮都输出产物】',
    '- 闲聊、问身份/能力、或与排程无关：用一两句自然语言回答，不输出任何产物。被问「你是什么模型」等只以 Guidy 助手身份作答，不透露底层模型。',
    '- 有排程目标但信息不足：用自然语言追问，每轮最多 2 个关键问题（目标/科目/时长/频率/忙碌时间/偏好），不要臆造用户未给出的硬性时间，不要急于生成产物。',
    '- 目标明确且信息足够，或用户明确要求生成：才输出 constraint_set（一个 JSON 对象，可用 ```json 代码块包裹），下方确认卡会自动出现。',
    '- 用户要求修改已有计划：输出 patch。',
    '- 结构化产物一旦输出，字段名、类型、枚举必须与下方契约逐字一致，不要自创字段、不要改用近义词或把对象写成字符串。',
    '',
    '【constraint_set 契约】',
    '{type:"constraint_set", plan_title:string(≤60), horizon_days:7|14, task_defs:[TaskDef](1–30), constraints:[Payload](≤40), clarifications_needed:[string(≤200)](≤2)}',
    'TaskDef = {key, title, category, duration_min, frequency, priority?, splittable?, preferred_period?, sort_order?}',
    '- key：仅小写字母/数字/下划线，1–24 位；title：1–60 字；duration_min：5–480 的整数。',
    '- category ∈ study|fitness|reading|work|life|creative|rest|other。',
    '- frequency 是对象，三选一：{type:"daily"} | {type:"once"} | {type:"per_week",count:1–14 整数}。不要写成字符串 "daily"。',
    '- priority ∈ high|mid|low（默认 mid；不要用 medium，也不要用数字）。',
    '- splittable：boolean（默认 false）；preferred_period ∈ morning|afternoon|evening|night（可选）；sort_order：整数（默认 0）。',
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
    'op ∈ add_task_def{value:TaskDef} | update_task_def{key,patch} | remove_task_def{key} | add_constraint{value:Payload} | update_constraint{id,patch} | remove_constraint{id} | add_block{value:ManualBlock} | update_block{id,patch} | move_block{id,start_utc,end_utc(ISO datetime)} | remove_block{id} | reschedule{scope?:"affected_only"|"all",keep_pinned:true}。',
    '',
    '【规则】产物里 clarifications_needed 最多 2 个，仅用于残留的次要歧义；主要追问走自然语言聊天，不要臆造用户未给出的硬性时间。',
    '',
    '【完整范例——仅示范字段名与形状，内容须来自用户实际目标，禁止照抄范例科目/标题】',
    '```json',
    JSON.stringify(CONSTRAINT_SET_EXAMPLE, null, 2),
    '```',
  ].join('\n');
}

export function buildUserMessage(input: { message: string; plan: PlanState | null; history: { role: string; content: string }[] }): string {
  const lines: string[] = [];
  if (input.plan) {
    lines.push(`当前计划「${input.plan.plan.title}」，horizon_start=${input.plan.plan.horizon_start}，timezone=${input.plan.plan.timezone}。`);
    lines.push('任务：' + input.plan.task_defs.map((t) => `${t.title}（${taskSummary(t)}）`).join('；'));
    lines.push('约束：' + (input.plan.constraints.map((c) => constraintText(c.payload)).join('；') || '无'));
    lines.push(`已有 ${input.plan.blocks.length} 个时间块。`);
  } else {
    lines.push('当前还没有计划。');
  }
  for (const h of input.history.slice(-6)) lines.push(`${h.role}: ${h.content}`);
  lines.push(`user: ${input.message}`);
  return lines.join('\n');
}