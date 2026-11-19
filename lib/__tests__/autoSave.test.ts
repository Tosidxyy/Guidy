import { describe, expect, it } from 'vitest';
import { shouldAutoSave } from '@/lib/useAutoSaveDraft';
import type { PlanState } from '@/shared/types';

const base: PlanState = {
  plan: { id: null, title: '', horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'draft', version: 1, created_at: '', updated_at: '' },
  task_defs: [],
  constraints: [],
  blocks: [],
};
const block = { id: 'b1', title: 'x', category: 'rest' as const, start_utc: '2026-11-20T12:00:00.000Z', end_utc: '2026-11-20T12:30:00.000Z', priority: 'mid' as const, pinned: false, origin: 'manual' as const };

describe('shouldAutoSave', () => {
  it('有内容的草稿需要自动保存', () => {
    expect(shouldAutoSave({ ...base, blocks: [block] })).toBe(true);
    expect(shouldAutoSave({ ...base, task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }] })).toBe(true);
  });

  it('空草稿与已保存计划不触发', () => {
    expect(shouldAutoSave(base)).toBe(false);
    expect(shouldAutoSave({ ...base, plan: { ...base.plan, id: 'p1' }, blocks: [block] })).toBe(false);
  });

  it('仅默认 07:00–23:00 时段的空计划不自动保存；改过时段或加了任务才保存', () => {
    const defaults: PlanState = { ...base, constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }] };
    expect(shouldAutoSave(defaults)).toBe(false);
    const widened: PlanState = { ...base, constraints: [{ id: 'c1', payload: { type: 'active_window', start: '08:00', end: '22:00' }, source: 'user', enabled: true }] };
    expect(shouldAutoSave(widened)).toBe(true);
  });
});