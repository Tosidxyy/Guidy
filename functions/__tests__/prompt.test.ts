import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildUserMessage } from '../prompt';
import { findConflicts } from '../../shared/engine/conflicts';
import type { Block, PlanState } from '../../shared/types';

const block = (id: string, title: string, start: string, end: string): Block => ({
  id, title, category: 'study', start_utc: start, end_utc: end, priority: 'mid', pinned: false, origin: 'engine',
});
const plan: PlanState = {
  plan: { id: 'p1', title: '考研', horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [],
  constraints: [],
  blocks: [block('a1', '数学真题', '2026-11-19T23:00:00.000Z', '2026-11-20T00:00:00.000Z')],
};
const other = {
  id: 'p2', title: '健身', horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai',
  blocks: [block('b1', '核心训练', '2026-11-19T23:30:00.000Z', '2026-11-20T00:30:00.000Z')],
};

describe('buildUserMessage — 跨计划上下文', () => {
  it('日期摘要不把一个周末旅游误当每周周末；后段日期不能被截断', () => {
    const blocks = Array.from({ length: 28 }, (_, i) => {
      const day = new Date(Date.parse('2026-11-18T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
      return block(`travel-${i}`, i === 27 ? '最后一天安排' : '日程', `${day}T00:00:00Z`, `${day}T01:00:00Z`);
    });
    const text = buildUserMessage({ message: '排新任务', plan: null, history: [], today: '2026-11-18', timezone: 'Asia/Shanghai', others: [{ ...other, horizon_days: 28, blocks }] });
    expect(text).toContain('travel-27｜最后一天安排');
    expect(text).toContain('2026-11-18：07:00–08:00、09:00–23:00');
    expect(text).not.toContain('仅列前');
  });

  it('细化子块明确保留整天不可用提示，避免在行程间隙塞任务', () => {
    const child = { ...block('trip-child', '西湖', '2026-11-21T05:00:00Z', '2026-11-21T07:00:00Z'), unavailable_date: '2026-11-21' };
    const text = buildUserMessage({ message: '练吉他', plan: null, history: [], today: '2026-11-18', sharedBlocks: [child] });
    expect(text).toContain('【整天不安排任务】2026-11-21');
    expect(text).toContain('2026-11-21：全天不可安排');
  });

  it('没有作息上下文时明确提示不要假设上班时间或默认排到晚上', () => {
    const text = buildUserMessage({ message: '下周开始健身', plan: null, history: [], today: '2026-11-18' });
    expect(text).toContain('【作息未知】');
    expect(text).toContain('不要假设用户白天在上班/上课');
    expect(buildSystemPrompt()).toContain('不要假设用户白天要上班/上课');
  });
  it('公共日历块带 id 与写规则进入上下文', () => {
    const text = buildUserMessage({
      message: '明天请假',
      plan,
      history: [],
      today: '2026-11-18',
      sharedBlocks: [block('s1', '上班', '2026-11-19T01:00:00.000Z', '2026-11-19T09:30:00.000Z')],
    });
    expect(text).toContain('【公共日历块');
    expect(text).toContain('s1｜上班');
    expect(text).toContain('remove_block');
  });
  it('有冲突时列出时段、双方标题与其他计划名，并说明合并由用户完成', () => {
    const conflicts = findConflicts([{ id: 'p1', title: '考研', blocks: plan.blocks }, other], { onlyPlanId: 'p1' });
    const text = buildUserMessage({ message: '今天怎么安排？', plan, history: [], today: '2026-11-18', conflicts });
    expect(text).toContain('【共享日历：跨计划时间重叠】');
    expect(text).toContain('数学真题');
    expect(text).toContain('核心训练');
    expect(text).toContain('健身');
    expect(text).toContain('不要输出修改其他计划的 patch');
  });

  it('无冲突时不出现该段', () => {
    const text = buildUserMessage({ message: '今天怎么安排？', plan, history: [], today: '2026-11-18', conflicts: [] });
    expect(text).not.toContain('【共享日历：跨计划时间重叠】');
  });

  it('计划期内的节假日与调休进入上下文', () => {
    const holidayPlan: PlanState = { ...plan, plan: { ...plan.plan, horizon_start: '2026-02-14', horizon_days: 7 } };
    const text = buildUserMessage({ message: '这周怎么排？', plan: holidayPlan, history: [], today: '2026-02-14' });
    expect(text).toContain('计划期内法定节假日');
    expect(text).toContain('2026-02-17 春节');
    expect(text).toContain('计划期内调休上班：2026-02-14');
  });

  it('时间块的备注进入上下文', () => {
    const withNotes: PlanState = { ...plan, blocks: [{ ...plan.blocks[0], notes: '错题复盘：线代第二章' }] };
    const text = buildUserMessage({ message: '今天怎么安排？', plan: withNotes, history: [], today: '2026-11-18' });
    expect(text).toContain('备注：错题复盘：线代第二章');
  });

  it('其他计划的块 id 与跨计划规则进入上下文', () => {
    const text = buildUserMessage({ message: '把健身计划周三的训练挪到晚上', plan, history: [], today: '2026-11-18', others: [other] });
    expect(text).toContain('【共享日历中的其他计划】');
    expect(text).toContain('按 id 修改其中的块');
    expect(text).toContain('新建块或改计划元数据要带该计划的 plan id');
    expect(text).toContain('plan id p2');
    expect(text).toContain('开始日 2026-11-18');
    expect(text).toContain('b1');
    expect(text).toContain('健身');
    expect(text).toContain('move_block / update_block / remove_block 直接使用上面的块 id');
    expect(text).toContain('add_block 的 value 照旧，另加 "plan_id"');
    expect(text).toContain('update_plan 带 "plan_id"');
    expect(text).toContain('其他计划的任务定义是全局已知信息');
  });

  it('新对话（无当前计划）也注入已有计划与忙时，并禁止重复询问', () => {
    const withWindows = { ...other, windows: [{ id: 'c-busy', text: '周三 18:00–22:00 兼职' }] };
    const text = buildUserMessage({ message: '再帮我排一个计划', plan: null, history: [], today: '2026-11-18', timezone: 'Asia/Shanghai', others: [withWindows] });
    expect(text).toContain('【用户已有的计划（同一份共享日历）】');
    expect(text).toContain('健身');
    expect(text).toContain('周三 18:00–22:00 兼职');
    expect(text).toContain('不要再问「你什么时候有空」');
    expect(text).toContain('追加新的忙时');
  });
  it('当前计划存在时，其他计划的已有时段也进入上下文', () => {
    const withWindows = { ...other, windows: [{ id: 'c-busy', text: '周三 18:00–22:00 兼职' }] };
    const text = buildUserMessage({ message: '帮我安排', plan, history: [], today: '2026-11-18', others: [withWindows] });
    expect(text).toContain('已有时段：c-busy｜周三 18:00–22:00 兼职');
    expect(text).toContain('按 id 修改或删除');
    expect(text).toContain('不要重复问用户什么时候有空');
  });
  it('信息不足时要求输出 question_card 契约', () => {
    const text = buildSystemPrompt();
    expect(text).toContain('【question_card 契约】');
    expect(text).toContain('输出 question_card 的这一轮不要再输出 constraint_set 或 patch');
  });
  it('system prompt 要求先推断、单轮合并追问再生成方案', () => {
    const text = buildSystemPrompt();
    expect(text).toContain('必要信息清单');
    expect(text).toContain('先穷尽推断');
    expect(text).toContain('最多 3 问');
    expect(text).toContain('不再追加第二轮');
    expect(text).toContain('修改已有计划的明确指令');
  });
  it('system prompt 约束语气去 AI 腔', () => {
    const text = buildSystemPrompt();
    expect(text).toContain('像一位有经验的规划师朋友');
    expect(text).toContain('不叙述自己的动作');
  });
  it('system prompt 的截止日跨度规则可计算', () => {
    const text = buildSystemPrompt();
    expect(text).toContain('实际自然天数');
    expect(text).toContain('不得越过截止日');
    expect(text).toContain('未表述时默认 30');
  });
  it('注入可安排时段并约束追问选项', () => {
    const text = buildUserMessage({ message: '帮我排训练', plan, history: [], today: '2026-11-18', availability: '周一至周五：无可安排时段；周六、周日：09:00–22:00' });
    expect(text).toContain('按日期的剩余时段');
    expect(text).toContain('2026-11-20：08:00–23:00');
    expect(text).not.toContain('周一至周五：无可安排时段');
    expect(text).toContain('固定时间冲突时先给 question_card');
  });
  it('没有时间块时用 patch 补齐任务与约束，由方案卡生成排程', () => {
    const emptyPlan: PlanState = { ...plan, plan: { ...plan.plan, status: 'draft' }, blocks: [] };
    const emptyText = buildUserMessage({ message: '补一个腿部任务', plan: emptyPlan, history: [], today: '2026-11-18' });
    expect(emptyText).toContain('已有时间块 0 个');
    expect(emptyText).toContain('还没有排程（0 个时间块）');
    expect(emptyText).toContain('不要 reschedule，也不要输出 constraint_set');
    expect(emptyText).toContain('生成排程');

    const scheduled: PlanState = { ...plan, plan: { ...plan.plan, status: 'active' } };
    const scheduledText = buildUserMessage({ message: '把数学挪到下午', plan: scheduled, history: [], today: '2026-11-18' });
    expect(scheduledText).toContain('当前计划已有排程');
    expect(scheduledText).toContain('输出 patch（按需重排）');
  });
  it('其他计划的任务定义进入上下文（只读知识）', () => {
    const withTasks = { ...other, tasks: [{ key: 'leetcode', title: '力扣', category: 'study' as const, duration_min: 60, frequency: { type: 'daily' as const }, priority: 'mid' as const, splittable: false, sort_order: 0 }] };
    const text = buildUserMessage({ message: '另一个计划在做什么？', plan, history: [], today: '2026-11-18', others: [withTasks] });
    expect(text).toContain('任务：leetcode｜力扣');
    expect(text).toContain('其他计划的任务定义是全局已知信息');
  });
  it('长期计划与任务备注的契约写进 prompt', () => {
    const text = buildSystemPrompt();
    expect(text).toContain('horizon_days:int(1–365)');
    expect(text).toContain('未表述时默认 30');
    expect(text).toContain('task_defs[].notes');
  });
  it('没有其他计划时不出现该段', () => {
    const text = buildUserMessage({ message: 'hi', plan, history: [], today: '2026-11-18' });
    expect(text).not.toContain('【共享日历中的其他计划】');
  });
});
describe('buildUserMessage — 生活习惯注入', () => {
  it('用户自述优先注入；学到画像作为参考注入', () => {
    const text = buildUserMessage({
      message: '下周安排点训练', plan: null, history: [], today: '2026-11-19',
      habits: '早上不出门，晚上 11 点前睡', learned: '工作日平均 60 分钟；常见活动：上班',
    });
    expect(text).toContain('用户自述的生活习惯（优先遵守）');
    expect(text).toContain('早上不出门');
    expect(text).toContain('从日历统计到的习惯');
    expect(text).toContain('常见活动：上班');
  });
  it('没有习惯时不出现相关段落', () => {
    const text = buildUserMessage({ message: 'hi', plan: null, history: [], today: '2026-11-19' });
    expect(text).not.toContain('生活习惯');
    expect(text).not.toContain('统计到的习惯');
  });
});
