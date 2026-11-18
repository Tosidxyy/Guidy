import { describe, expect, it } from 'vitest';
import { buildUserMessage } from '../prompt';
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
    expect(text).toContain('任务 key 只在当前计划内有效');
  });

  it('新对话（无当前计划）也注入已有计划与忙时，并禁止重复询问', () => {
    const withWindows = { ...other, windows: ['周三 18:00–22:00 兼职'] };
    const text = buildUserMessage({ message: '再帮我排一个计划', plan: null, history: [], today: '2026-11-18', timezone: 'Asia/Shanghai', others: [withWindows] });
    expect(text).toContain('【用户已有的计划（同一份共享日历）】');
    expect(text).toContain('健身');
    expect(text).toContain('周三 18:00–22:00 兼职');
    expect(text).toContain('不要再问「你什么时候有空」');
    expect(text).toContain('追加新的忙时');
  });
  it('当前计划存在时，其他计划的已有时段也进入上下文', () => {
    const withWindows = { ...other, windows: ['周三 18:00–22:00 兼职'] };
    const text = buildUserMessage({ message: '帮我安排', plan, history: [], today: '2026-11-18', others: [withWindows] });
    expect(text).toContain('已有时段：周三 18:00–22:00 兼职');
    expect(text).toContain('不要重复问用户什么时候有空');
  });
  it('没有其他计划时不出现该段', () => {
    const text = buildUserMessage({ message: 'hi', plan, history: [], today: '2026-11-18' });
    expect(text).not.toContain('【共享日历中的其他计划】');
  });
});