import { describe, expect, it } from 'vitest';
import { relaxPatchOps } from '@/lib/relaxPlan';
import type { PlanState } from '@/shared/types';
import type { PatchArtifact } from '@/shared/schemas';

const state: PlanState = {
  plan: { id: 'p1', title: '生活', horizon_start: '2026-11-23', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [
    { key: 'meal', title: '吃饭', category: 'life', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 },
    { key: 'trip', title: '旅游', category: 'life', duration_min: 480, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 1 },
  ],
  constraints: [{ id: 'c0', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  blocks: [],
};
const hardMutex: PatchArtifact = {
  type: 'patch',
  summary: '旅游当天不排其他活动',
  ops: [
    { op: 'add_constraint', value: { type: 'mutex', subjects: { kind: 'task', values: ['trip', 'meal'] }, mode: 'no_same_day', strength: 'hard' }, source: 'ai', enabled: true },
    { op: 'reschedule', scope: 'all', keep_pinned: true },
  ],
};

describe('relaxPatchOps', () => {
  it('与每日任务冲突的硬互斥放宽为软性，并本地验证可行', () => {
    const r = relaxPatchOps(hardMutex, state);
    expect(r).not.toBeNull();
    expect(r!.changes.join()).toContain('互斥');
    const added = r!.patch.ops.find((o) => o.op === 'add_constraint') as any;
    expect(added.value.strength).toBe('soft');
  });
  it('没有可放宽项时返回 null', () => {
    const patch: PatchArtifact = { type: 'patch', summary: '改时长', ops: [{ op: 'update_task_def', key: 'meal', patch: { duration_min: 70 } }] };
    expect(relaxPatchOps(patch, state)).toBeNull();
  });
});