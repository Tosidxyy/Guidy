import { describe, expect, it } from 'vitest';
import { usePlanStore } from '../usePlanStore';
import { localDay, utcAt } from '@/shared/engine';
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

const multi: PlanState = {
  plan: { id: 'p2', title: '多选', horizon_start: '2026-11-23', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [],
  constraints: [{ id: 'c1', payload: { type: 'active_window', start: '08:00', end: '22:00' }, source: 'user', enabled: true }],
  blocks: [
    { id: 'b1', title: '数学', category: 'study', start_utc: utcAt('2026-11-23', 9 * 60, 'Asia/Shanghai'), end_utc: utcAt('2026-11-23', 10 * 60, 'Asia/Shanghai'), priority: 'mid', pinned: false, origin: 'engine' },
    { id: 'b2', title: '英语', category: 'study', start_utc: utcAt('2026-11-23', 11 * 60, 'Asia/Shanghai'), end_utc: utcAt('2026-11-23', 12 * 60, 'Asia/Shanghai'), priority: 'mid', pinned: false, origin: 'engine' },
  ],
};

describe('整组移动与删除', () => {
  it('moveBlocks 一次提交移动全部，撤销一次全部还原', () => {
    usePlanStore.getState().importState(multi);
    const r = usePlanStore.getState().moveBlocks(['b1', 'b2'], 1, 60);
    expect(r.ok).toBe(true);
    const s = usePlanStore.getState();
    expect(s.undoStack).toHaveLength(1);
    const b1 = s.state.blocks.find((b) => b.id === 'b1')!;
    const b2 = s.state.blocks.find((b) => b.id === 'b2')!;
    expect(localDay(b1.start_utc, 'Asia/Shanghai')).toBe('2026-11-24');
    expect(localDay(b2.start_utc, 'Asia/Shanghai')).toBe('2026-11-24');
    usePlanStore.getState().undo();
    const restored = usePlanStore.getState().state.blocks;
    expect(localDay(restored.find((b) => b.id === 'b1')!.start_utc, 'Asia/Shanghai')).toBe('2026-11-23');
    expect(localDay(restored.find((b) => b.id === 'b2')!.start_utc, 'Asia/Shanghai')).toBe('2026-11-23');
  });

  it('moveBlocks 校验失败不提交、不动 undo 栈', () => {
    usePlanStore.getState().importState(multi);
    const r = usePlanStore.getState().moveBlocks(['b1'], 0, -3 * 60);
    expect(r.ok).toBe(false);
    expect(usePlanStore.getState().undoStack).toHaveLength(0);
  });

  it('deleteBlocks 一次删除多个，撤销一次全部还原', () => {
    usePlanStore.getState().importState(multi);
    usePlanStore.getState().deleteBlocks(['b1', 'b2']);
    expect(usePlanStore.getState().state.blocks).toHaveLength(0);
    expect(usePlanStore.getState().undoStack).toHaveLength(1);
    usePlanStore.getState().undo();
    expect(usePlanStore.getState().state.blocks).toHaveLength(2);
  });
});

describe('applyServerBlocks', () => {
  it('只替换 blocks，不推本地撤销、不改 dirty，并更新快照 blocks', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().renamePlan('新名');
    const nextBlocks = [{
      id: 'srv-1', title: '服务端块', category: 'study' as const,
      start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z',
      priority: 'mid' as const, pinned: false, origin: 'engine' as const,
    }];
    usePlanStore.getState().applyServerBlocks(nextBlocks);
    const s = usePlanStore.getState();
    expect(s.state.blocks).toEqual(nextBlocks);
    expect(s.undoStack).toHaveLength(1);
    expect(s.undoStack[0].before.blocks).toEqual(nextBlocks);
    expect(s.undoStack[0].after.blocks).toEqual(nextBlocks);
    expect(s.dirty).toBe(true);
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