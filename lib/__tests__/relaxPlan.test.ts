import { describe, expect, it } from 'vitest';
import { relaxDraft } from '@/lib/relaxPlan';
import { solveArtifact } from '@/lib/preview';
import type { ConstraintSetArtifact } from '@/shared/schemas';

const plan = { horizon_start: '2026-11-19', timezone: 'Asia/Shanghai' };
const base: ConstraintSetArtifact = {
  type: 'constraint_set',
  plan_title: '容量验证',
  horizon_days: 7,
  task_defs: [
    { key: 'a', title: '数学', category: 'study', duration_min: 480, frequency: { type: 'daily' }, priority: 'high', splittable: false, sort_order: 0 },
    { key: 'b', title: '英语', category: 'study', duration_min: 120, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 1 },
  ],
  constraints: [
    { type: 'active_window', start: '07:00', end: '23:00' },
    { type: 'daily_cap', category: 'study', max_minutes: 120 },
  ],
  clarifications_needed: [],
};

describe('relaxDraft', () => {
  it('不可行方案给出透明放宽且放宽后可行', () => {
    const before = solveArtifact(base, plan, []);
    expect(before.output.violations.length).toBeGreaterThan(0);
    const r = relaxDraft(base, plan, []);
    expect(r).not.toBeNull();
    expect(r!.changes.length).toBeGreaterThan(0);
    expect(r!.changes.some((c) => c.includes('每日上限'))).toBe(true);
    const after = solveArtifact(r!.draft, plan, []);
    expect(after.output.violations).toHaveLength(0);
  });

  it('无容量冲突时不放宽', () => {
    const ok: ConstraintSetArtifact = {
      ...base,
      task_defs: [{ key: 'a', title: '背单词', category: 'study', duration_min: 40, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
      constraints: [{ type: 'active_window', start: '06:00', end: '23:00' }],
    };
    expect(relaxDraft(ok, plan, [])).toBeNull();
  });
});