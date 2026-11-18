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
const other = { id: 'p2', title: '健身', blocks: [block('b1', '核心训练', '2026-11-19T23:30:00.000Z', '2026-11-20T00:30:00.000Z')] };

describe('buildUserMessage — 跨计划冲突上下文', () => {
  it('有冲突时列出时段、双方标题与其他计划名，并禁止改其他计划', () => {
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
});