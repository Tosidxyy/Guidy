import { describe, expect, it } from 'vitest';
import { artifactFromPlan, planFromArtifact } from '@/lib/planCard';
import type { PlanState } from '@/shared/types';

const plan: PlanState = {
  plan: { id: 'p1', title: '考研', horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 3, created_at: '', updated_at: '' },
  task_defs: [{ key: 'math', title: '数学真题', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [
    { id: 'c-active', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true },
    { id: 'c-buffer', payload: { type: 'buffer', minutes: 5 }, source: 'ai', enabled: false },
  ],
  blocks: [],
};

describe('planCard', () => {
  it('artifactFromPlan 只暴露卡片需要的字段', () => {
    const a = artifactFromPlan(plan);
    expect(a.plan_title).toBe('考研');
    expect(a.horizon_days).toBe(7);
    expect(a.constraints).toEqual([
      { type: 'active_window', start: '07:00', end: '23:00' },
      { type: 'buffer', minutes: 5 },
    ]);
    expect(a.task_defs[0].key).toBe('math');
  });

  it('未改动的约束保持 id/source/enabled，新增给临时 id，删除的自然消失', () => {
    const draft = artifactFromPlan(plan);
    draft.constraints = [draft.constraints[0], { type: 'deadline', date: '2026-11-30', label: '报名截止' }];
    draft.plan_title = '考研冲刺';
    draft.horizon_days = 14;

    const next = planFromArtifact(plan, draft);
    expect(next.plan.title).toBe('考研冲刺');
    expect(next.plan.horizon_days).toBe(14);
    expect(next.constraints).toHaveLength(2);
    expect(next.constraints[0]).toMatchObject({ id: 'c-active', source: 'user', enabled: true });
    expect(next.constraints[1]).toMatchObject({ id: 'draft-c-1', source: 'user', enabled: true });
    expect(next.constraints.some((c) => c.id === 'c-buffer')).toBe(false);
  });

  it('约束顺序变化不影响 id 匹配', () => {
    const draft = artifactFromPlan(plan);
    draft.constraints = [draft.constraints[1], draft.constraints[0]];
    const next = planFromArtifact(plan, draft);
    expect(next.constraints.map((c) => c.id)).toEqual(['c-buffer', 'c-active']);
  });
});