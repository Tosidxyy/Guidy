import { describe, expect, it } from 'vitest';
import { trimDraftToFit } from '@/lib/relaxPlan';
import type { ConstraintSetArtifact } from '@/shared/schemas';

const meta = { horizon_start: '2026-11-16', timezone: 'Asia/Shanghai' };
const task = (over: any) => ({
  key: 'x', title: '任务', category: 'other', duration_min: 60,
  frequency: { type: 'once' as const }, priority: 'mid' as const, splittable: false, sort_order: 0, ...over,
});
const draft = (tasks: any[], horizon: number, window = { start: '07:00', end: '08:00' }): ConstraintSetArtifact => ({
  type: 'constraint_set', plan_title: 't', horizon_days: horizon,
  task_defs: tasks, constraints: [{ type: 'active_window', start: window.start, end: window.end }], clarifications_needed: [],
});

describe('trimDraftToFit（超容量取舍）', () => {
  it('先降 per_week 次数直到可行', () => {
    const d = draft([task({ key: 'en', title: '学英语', frequency: { type: 'per_week', count: 9 } })], 7);
    const r = trimDraftToFit(d, meta, []);
    expect(r).not.toBeNull();
    const t = r!.draft.task_defs[0];
    expect(t.frequency).toEqual({ type: 'per_week', count: 7 });
    expect(r!.changes.join()).toContain('每周次数降为 7');
  });
  it('再暂缓低优先级的 once 任务', () => {
    const d = draft([
      task({ key: 'a', title: '阅读', priority: 'low' }),
      task({ key: 'b', title: '报告', priority: 'high', sort_order: 1 }),
    ], 1);
    const r = trimDraftToFit(d, meta, []);
    expect(r).not.toBeNull();
    expect(r!.draft.task_defs.map((t) => t.key)).toEqual(['b']);
    expect(r!.changes.join()).toContain('暂缓「阅读」');
  });
  it('本身可行时返回 null（不乱动）', () => {
    const d = draft([task({ key: 'a', title: '阅读' })], 7, { start: '07:00', end: '23:00' });
    expect(trimDraftToFit(d, meta, [])).toBeNull();
  });
});
