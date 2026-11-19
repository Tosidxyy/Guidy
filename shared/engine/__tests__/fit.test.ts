import { describe, expect, it } from 'vitest';
import { artifactFeasible, trimArtifactToFit } from '../fit';
import type { ConstraintSetArtifact } from '../../schemas';

const meta = { horizon_start: '2026-11-16', timezone: 'Asia/Shanghai' };
const task = (over: any) => ({
  key: 'x', title: '任务', category: 'other', duration_min: 60,
  frequency: { type: 'once' as const }, priority: 'mid' as const, splittable: false, sort_order: 0, ...over,
});
const draft = (tasks: any[], horizon: number, window = { start: '07:00', end: '08:00' }): ConstraintSetArtifact => ({
  type: 'constraint_set', plan_title: 't', horizon_days: horizon,
  task_defs: tasks, constraints: [{ type: 'active_window', start: window.start, end: window.end }], clarifications_needed: [],
});

describe('trimArtifactToFit（服务端自动取舍）', () => {
  it('真实复杂案例同款：次数超容量自动降次并交付可行方案', () => {
    const d = draft([task({ key: 'en', title: '学英语', frequency: { type: 'per_week', count: 9 } })], 7);
    expect(artifactFeasible(d, meta)).toBe(false);
    const r = trimArtifactToFit(d, meta);
    expect(r).not.toBeNull();
    expect(r!.draft.task_defs[0].frequency).toEqual({ type: 'per_week', count: 7 });
    expect(artifactFeasible(r!.draft, meta)).toBe(true);
  });
  it('低优先级任务先被暂缓，高优先级保留', () => {
    const d = draft([
      task({ key: 'a', title: '阅读', priority: 'low' }),
      task({ key: 'b', title: '报告', priority: 'high', sort_order: 1 }),
    ], 1);
    const r = trimArtifactToFit(d, meta);
    expect(r!.draft.task_defs.map((t) => t.key)).toEqual(['b']);
  });
  it('可行时不动', () => {
    const d = draft([task({ key: 'a' })], 7, { start: '07:00', end: '23:00' });
    expect(trimArtifactToFit(d, meta)).toBeNull();
  });
});
