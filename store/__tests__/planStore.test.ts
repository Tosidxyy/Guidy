import { describe, expect, it } from 'vitest';
import { usePlanStore } from '../usePlanStore';
import { localDay } from '@/shared/engine';
import type { PlanState } from '@/shared/types';
import type { ConstraintSetArtifact, PatchArtifact } from '@/shared/schemas';

describe('全新加载不再预置示例计划', () => {
  it('初始计划为空，无数学示例任务', () => {
    const s = usePlanStore.getState().state;
    expect(s.task_defs).toHaveLength(0);
    expect(s.blocks).toHaveLength(0);
    expect(s.task_defs.some((t) => t.key === 'math')).toBe(false);
    expect(s.plan.title).toBe('我的新计划');
  });
});

const seeded: PlanState = {
  plan: { id: 'p1', title: '测试', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  blocks: [],
};

describe('previewPatch', () => {
  it('update_task_def+reschedule 设 preview，reason=summary，diff 非空', () => {
    usePlanStore.getState().importState(seeded);
    const patch: PatchArtifact = { type: 'patch', summary: '数学改120分钟', ops: [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }] };
    usePlanStore.getState().previewPatch(patch);
    const p = usePlanStore.getState().preview;
    expect(p).not.toBeNull();
    expect(p!.reason).toBe('数学改120分钟');
    expect(p!.output.blocks.length).toBeGreaterThan(0);
  });
});

describe('previewArtifact 开始日期', () => {
  it('应用预览后计划开始日/天数跟随产物，块落在新开始日之后', () => {
    usePlanStore.getState().importState(seeded);
    const artifact: ConstraintSetArtifact = {
      type: 'constraint_set', plan_title: '下周腹肌', horizon_start: '2026-11-23', horizon_days: 7,
      task_defs: [{ key: 'core', title: '核心', category: 'fitness', duration_min: 30, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
      constraints: [{ type: 'active_window', start: '18:30', end: '22:30' }],
      clarifications_needed: [],
    };
    usePlanStore.getState().previewArtifact(artifact);
    expect(usePlanStore.getState().preview?.horizon_start).toBe('2026-11-23');
    usePlanStore.getState().applyPreview();
    const s = usePlanStore.getState().state;
    expect(s.plan.horizon_start).toBe('2026-11-23');
    expect(s.plan.horizon_days).toBe(7);
    expect(s.blocks.length).toBeGreaterThan(0);
    expect(s.blocks.every((b) => localDay(b.start_utc, s.plan.timezone) >= '2026-11-23')).toBe(true);
  });
});

describe('replaceStateKeepUndo', () => {
  it('保留撤销栈顶 before，after 更新为 next', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().commit('测试编辑', (d) => { d.plan.title = '改名'; });
    const before = usePlanStore.getState().undoStack[0].before;
    const next = { ...seeded, plan: { ...seeded.plan, title: '服务端名', version: 2 } };
    usePlanStore.getState().replaceStateKeepUndo(next);
    const st = usePlanStore.getState();
    expect(st.state.plan.title).toBe('服务端名');
    expect(st.undoStack).toHaveLength(1);
    expect(st.undoStack[0].before).toEqual(before);
    expect(st.undoStack[0].after.plan.title).toBe('服务端名');
  });
});

describe('dirty 标记', () => {
  it('importState 后 dirty=false', () => {
    usePlanStore.getState().importState(seeded);
    expect(usePlanStore.getState().dirty).toBe(false);
  });
  it('commit（renamePlan）后 dirty=true', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().renamePlan('新名');
    expect(usePlanStore.getState().dirty).toBe(true);
  });
  it('undo/redo 后 dirty=true', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().renamePlan('x');
    usePlanStore.getState().undo();
    expect(usePlanStore.getState().dirty).toBe(true);
    usePlanStore.getState().redo();
    expect(usePlanStore.getState().dirty).toBe(true);
  });
  it('replaceStateKeepUndo 后 dirty=false', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().renamePlan('x');
    usePlanStore.getState().replaceStateKeepUndo(seeded);
    expect(usePlanStore.getState().dirty).toBe(false);
  });
  it('resetAll 后 dirty=false', () => {
    usePlanStore.getState().renamePlan('x');
    usePlanStore.getState().resetAll();
    expect(usePlanStore.getState().dirty).toBe(false);
  });
});