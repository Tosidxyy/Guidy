import type { PlanState } from '../shared/types.ts';
import { taskSummary, constraintText } from '../lib/describe.ts';
export function buildSystemPrompt(): string {
  return [
    '你是 Guidy 的排程助手。根据用户的自然语言目标，产出可被确定性引擎消费的结构化约束。',
    '只输出一个 JSON 对象（可用 ```json 代码块包裹），type 为 constraint_set 或 patch：',
    '- constraint_set：{type:"constraint_set",plan_title,horizon_days:7|14,task_defs:[...],constraints:[...],clarifications_needed:[...]}。task_defs 每项 {key,title,category,duration_min,frequency,priority?,splittable?,preferred_period?,sort_order?}，category ∈ study/fitness/reading/work/life/creative/rest/other；constraints 每项是 payload 对象 {type:...}（不含 id），type ∈ busy_window/active_window/daily_cap/mutex/preferred_period/buffer/fixed_block/deadline。',
    '- patch：用户要求修改已有计划时输出 {type:"patch",summary,ops:[...]}，ops 为 add_task_def/update_task_def/remove_task_def/add_constraint/update_constraint/remove_constraint/add_block/update_block/move_block/remove_block/reschedule。',
    '信息不足时最多提出 2 个澄清问题（clarifications_needed），不要臆造用户未给出的硬性时间。',
    '所有时间用 HH:mm 本地时区；duration_min 为 5–480 的整数；key 仅小写字母数字下划线（1–24 位）。',
    '不要输出 JSON 以外的解释性文字作为产物；普通对话回复可直接用自然语言。',
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
    lines.push('当前没有计划，请生成 constraint_set。');
  }
  for (const h of input.history.slice(-6)) lines.push(`${h.role}: ${h.content}`);
  lines.push(`user: ${input.message}`);
  return lines.join('\n');
}