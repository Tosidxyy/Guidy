import { describe, expect, it } from 'vitest';
import { usePlanStore } from '../usePlanStore';
import type { PlanState } from '@/shared/types';
import type { PatchArtifact } from '@/shared/schemas';

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