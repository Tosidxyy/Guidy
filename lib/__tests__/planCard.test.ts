import { describe, expect, it } from 'vitest';
import { artifactFromPlan, canGenerateSchedule, diffPlanCard, patchFitsPlanCard, planFromArtifact, scheduleInputsChanged, stagePatchOnDraft } from '@/lib/planCard';
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

describe('diffPlanCard', () => {
  it('没有改动 → 不产生 ops', () => {
    expect(diffPlanCard(plan, artifactFromPlan(plan))).toEqual([]);
  });

  it('任务只带改动字段，新增/删除各一条', () => {
    const draft = artifactFromPlan(plan);
    draft.task_defs[0] = { ...draft.task_defs[0], duration_min: 90 };
    draft.task_defs.push({ key: 'eng', title: '英语', category: 'study', duration_min: 30, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 1 });
    const ops = diffPlanCard(plan, draft);
    expect(ops).toContainEqual({ op: 'update_task_def', key: 'math', patch: { duration_min: 90 } });
    expect(ops).toContainEqual({ op: 'add_task_def', value: expect.objectContaining({ key: 'eng' }) });

    const removed = artifactFromPlan({ ...plan, task_defs: [] });
    expect(diffPlanCard(plan, removed)).toContainEqual({ op: 'remove_task_def', key: 'math' });
  });

  it('约束就地编辑沿用原 id，新增与删除各一条', () => {
    const edited = artifactFromPlan(plan);
    edited.constraints = [{ type: 'active_window', start: '08:00', end: '22:00' }];
    const ops = diffPlanCard(plan, edited);
    expect(ops).toContainEqual({ op: 'update_constraint', id: 'c-active', patch: { payload: { type: 'active_window', start: '08:00', end: '22:00' } } });
    expect(ops).toContainEqual({ op: 'remove_constraint', id: 'c-buffer' });

    const added = artifactFromPlan(plan);
    added.constraints.push({ type: 'deadline', date: '2026-11-30', label: '报名截止' });
    expect(diffPlanCard(plan, added)).toEqual([
      { op: 'add_constraint', value: { type: 'deadline', date: '2026-11-30', label: '报名截止' }, source: 'user', enabled: true },
    ]);
  });

  it('开始日期变化 → update_plan', () => {
    const draft = { ...artifactFromPlan(plan), horizon_start: '2026-11-20' };
    expect(diffPlanCard(plan, draft)).toEqual([{ op: 'update_plan', patch: { horizon_start: '2026-11-20' } }]);
  });
});

describe('canGenerateSchedule', () => {
  it('有任务且还没有块时为 true，其余为 false', () => {
    expect(canGenerateSchedule(plan)).toBe(true);
    expect(canGenerateSchedule({ ...plan, task_defs: [] })).toBe(false);
    expect(canGenerateSchedule({ ...plan, blocks: [{ id: 'b', title: 'x', category: 'study', start_utc: '2026-11-18T01:00:00.000Z', end_utc: '2026-11-18T02:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }] })).toBe(false);
  });
});

describe('patchFitsPlanCard', () => {
  const patch = (ops: any[]) => ({ type: 'patch' as const, summary: '调整', ops });
  it('只改任务/约束/计划元数据的 patch 交给方案卡', () => {
    expect(patchFitsPlanCard(patch([{ op: 'update_task_def', key: 'math', patch: { duration_min: 90 } }]), 'p1')).toBe(true);
    expect(patchFitsPlanCard(patch([{ op: 'remove_constraint', id: 'c-buffer' }]), 'p1')).toBe(true);
    expect(patchFitsPlanCard(patch([{ op: 'update_plan', patch: { title: '新标题' } }]), 'p1')).toBe(true);
  });
  it('含块操作、重排或指向其他计划的 patch 留在聊天确认', () => {
    expect(patchFitsPlanCard(patch([{ op: 'remove_block', id: 'b1' }]), 'p1')).toBe(false);
    expect(patchFitsPlanCard(patch([{ op: 'reschedule', scope: 'all', keep_pinned: true }]), 'p1')).toBe(false);
    expect(patchFitsPlanCard(patch([{ op: 'update_plan', plan_id: 'p2', patch: { title: 'x' } }]), 'p1')).toBe(false);
    expect(patchFitsPlanCard(patch([]), 'p1')).toBe(false);
  });
});
describe('stagePatchOnDraft', () => {
  const mk = (ops: any[]) => ({ type: 'patch', summary: 's', ops } as any);
  it('保留卡片未保存编辑：draft 删掉的任务不被 fitting patch 复活', () => {
    const draft = { ...artifactFromPlan(plan), task_defs: [] };
    const staged = stagePatchOnDraft(plan, draft, mk([{ op: 'update_task_def', key: 'math', patch: { duration_min: 90 } }]));
    expect(staged.task_defs).toHaveLength(0);
  });
  it('无 draft 时按当前计划应用 patch', () => {
    const staged = stagePatchOnDraft(plan, null, mk([{ op: 'update_task_def', key: 'math', patch: { duration_min: 90 } }]));
    expect(staged.task_defs[0].duration_min).toBe(90);
  });
});

describe('scheduleInputsChanged', () => {
  const base = artifactFromPlan(plan);
  it('标题/备注编辑不触发重排（保护已应用的时间块调整）', () => {
    const next = { ...base, plan_title: '新名字', task_defs: base.task_defs.map((t) => ({ ...t, notes: '改备注', title: '改标题' })) };
    expect(scheduleInputsChanged(base, next)).toBe(false);
  });
  it('时长/约束/horizon 变化触发重排', () => {
    expect(scheduleInputsChanged(base, { ...base, task_defs: base.task_defs.map((t) => ({ ...t, duration_min: 90 })) })).toBe(true);
    expect(scheduleInputsChanged(base, { ...base, constraints: [...base.constraints, { type: 'buffer', minutes: 10 }] })).toBe(true);
    expect(scheduleInputsChanged(base, { ...base, horizon_start: '2026-11-19' })).toBe(true);
  });
  it('完全相同不触发', () => {
    expect(scheduleInputsChanged(base, artifactFromPlan(plan))).toBe(false);
  });
});
