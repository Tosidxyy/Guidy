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

  it('没有其他计划时不出现该段', () => {
    const text = buildUserMessage({ message: 'hi', plan, history: [], today: '2026-11-18' });
    expect(text).not.toContain('【共享日历中的其他计划】');
  });
});