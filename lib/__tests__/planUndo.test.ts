import { describe, expect, it, vi } from 'vitest';
import { createPlanUndo } from '@/lib/planUndo';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { PlanState } from '@/shared/types';

const plan: PlanState = {
  plan: { id: 'p1', title: '', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [],
  constraints: [],
  blocks: [],
};

function setup() {
  useBlockHistory.setState({ entries: {}, redo: {} });
  useBlockHistory.getState().push('p1', {
    at: 1,
    label: '移动',
    forwardOps: [{ op: 'remove_block', id: 'b1' }],
    inverseOps: [{ op: 'add_block', client_id: 'b1', value: { title: 'x', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z', priority: 'mid', pinned: false } }],
  });
  const apply = vi.fn(async () => ({ ok: true }));
  const undo = createPlanUndo({ apply, getPlanState: () => plan });
  return { apply, undo };
}

describe('createPlanUndo', () => {
  it('undo 应用 inverseOps，入口移入 redo', async () => {
    const { apply, undo } = setup();
    const label = await undo.undo('p1');
    expect(label).toBe('移动');
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ planId: 'p1', ops: expect.any(Array), record: false, optimistic: expect.any(Object) }));
    expect(useBlockHistory.getState().entries.p1).toHaveLength(0);
    expect(useBlockHistory.getState().redo.p1).toHaveLength(1);
  });
  it('redo 应用 forwardOps，入口移回 undo', async () => {
    const { undo } = setup();
    await undo.undo('p1');
    const label = await undo.redo('p1');
    expect(label).toBe('移动');
    expect(useBlockHistory.getState().redo.p1).toHaveLength(0);
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });
  it('失败不改栈', async () => {
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', { at: 1, label: '移动', forwardOps: [], inverseOps: [] });
    const apply = vi.fn(async () => ({ ok: false, reason: '409' }));
    const undo = createPlanUndo({ apply, getPlanState: () => plan });
    expect(await undo.undo('p1')).toBeNull();
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });
  it('元数据逆操作同样可撤销', async () => {
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', {
      at: 1,
      label: '重命名计划',
      forwardOps: [{ op: 'update_plan', patch: { title: '新标题' } }],
      inverseOps: [{ op: 'update_plan', patch: { title: '' } }],
    });
    const constPlan: PlanState = { ...plan, plan: { ...plan.plan, title: '新标题' } };
    const apply = vi.fn(async () => ({ ok: true }));
    const undo = createPlanUndo({ apply, getPlanState: () => constPlan });
    expect(await undo.undo('p1')).toBe('重命名计划');
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      ops: [{ op: 'update_plan', patch: { title: '' } }],
      optimistic: expect.objectContaining({ plan: expect.objectContaining({ title: '' }) }),
    }));
  });

  it('undoDetailed 在服务端拒绝时返回原因（供跨计划撤销逐个回报）', async () => {
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', { at: 1, label: '合并', forwardOps: [], inverseOps: [{ op: 'remove_block', id: 'b1' }] });
    const apply = vi.fn(async () => ({ ok: false, reason: '计划已被更新，请刷新后重试' }));
    const undo = createPlanUndo({ apply, getPlanState: () => plan });
    const r = await undo.undoDetailed('p1');
    expect(r.label).toBeNull();
    expect(r.reason).toContain('计划已被更新');
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });

  it('redo 应用 forwardOps，入口移回 undo', async () => {
    const { undo } = setup();
    await undo.undo('p1');
    const label = await undo.redo('p1');
    expect(label).toBe('移动');
    expect(useBlockHistory.getState().redo.p1).toHaveLength(0);
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });
  it('失败不改栈', async () => {
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', { at: 1, label: '移动', forwardOps: [], inverseOps: [] });
    const apply = vi.fn(async () => ({ ok: false, reason: '409' }));
    const undo = createPlanUndo({ apply, getPlanState: () => plan });
    expect(await undo.undo('p1')).toBeNull();
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });
  it('元数据逆操作同样可撤销', async () => {
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', {
      at: 1,
      label: '重命名计划',
      forwardOps: [{ op: 'update_plan', patch: { title: '新标题' } }],
      inverseOps: [{ op: 'update_plan', patch: { title: '' } }],
    });
    const constPlan: PlanState = { ...plan, plan: { ...plan.plan, title: '新标题' } };
    const apply = vi.fn(async () => ({ ok: true }));
    const undo = createPlanUndo({ apply, getPlanState: () => constPlan });
    expect(await undo.undo('p1')).toBe('重命名计划');
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      ops: [{ op: 'update_plan', patch: { title: '' } }],
      optimistic: expect.objectContaining({ plan: expect.objectContaining({ title: '' }) }),
    }));
  });

  it('undoDetailed 在服务端拒绝时返回原因（供跨计划撤销逐个回报）', async () => {
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', { at: 1, label: '合并', forwardOps: [], inverseOps: [{ op: 'remove_block', id: 'b1' }] });
    const apply = vi.fn(async () => ({ ok: false, reason: '计划已被更新，请刷新后重试' }));
    const undo = createPlanUndo({ apply, getPlanState: () => plan });
    const r = await undo.undoDetailed('p1');
    expect(r.label).toBeNull();
    expect(r.reason).toContain('计划已被更新');
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });

});
describe('公共日历操作的撤销/重做路由', () => {
  const tripBlock = { title: '杭州旅游', category: 'life' as const, start_utc: '2026-11-28T00:00:00.000Z', end_utc: '2026-11-28T14:00:00.000Z', priority: 'mid' as const, pinned: true };
  const childBlock = { title: '西湖', category: 'life' as const, start_utc: '2026-11-28T04:00:00.000Z', end_utc: '2026-11-28T08:00:00.000Z', priority: 'mid' as const, pinned: false };
  function setupShared() {
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', {
      at: 1,
      label: '细化旅游',
      forwardOps: [
        { op: 'remove_block', id: 'trip1' },
        { op: 'add_block', client_id: 'c1', value: childBlock },
      ],
      inverseOps: [
        { op: 'remove_block', id: 'c1' },
        { op: 'add_block', client_id: 'trip1', plan_id: '__shared__', value: tripBlock },
      ],
    });
    const apply = vi.fn(async () => ({ ok: true }));
    const applyShared = vi.fn(async () => ({ ok: true }));
    return { apply, applyShared };
  }
  it('撤销：带 __shared__ 标记的逆操作走共享通道（剥掉标记），其余走计划通道', async () => {
    const { apply, applyShared } = setupShared();
    const undo = createPlanUndo({ apply, getPlanState: () => plan, getSharedBlocks: () => [], applyShared });
    const r = await undo.undoDetailed('p1');
    expect(r.label).toBe('细化旅游');
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ ops: [{ op: 'remove_block', id: 'c1' }], undo: true }));
    expect(applyShared).toHaveBeenCalledWith([{ op: 'add_block', client_id: 'trip1', value: tripBlock }]);
    expect(useBlockHistory.getState().redo.p1).toHaveLength(1);
  });
  it('重做：forward 的 remove_block 按共享块 id 反查路由回共享通道', async () => {
    const { apply, applyShared } = setupShared();
    const undo = createPlanUndo({ apply, getPlanState: () => plan, getSharedBlocks: () => [{ id: 'trip1' }], applyShared });
    await undo.undo('p1');
    apply.mockClear(); applyShared.mockClear();
    const label = await undo.redo('p1');
    expect(label).toBe('细化旅游');
    expect(applyShared).toHaveBeenCalledWith([{ op: 'remove_block', id: 'trip1' }]);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ ops: [{ op: 'add_block', client_id: 'c1', value: childBlock }] }));
  });
  it('重做共享整天块替换时，子块继承整天不排任务的来源', async () => {
    const { apply, applyShared } = setupShared();
    const undo = createPlanUndo({ apply, getPlanState: () => plan,
      getSharedBlocks: () => [{ ...tripBlock, id: 'trip1', origin: 'manual', unavailable_date: '2026-11-28' }], applyShared });
    await undo.undo('p1');
    apply.mockClear();
    await undo.redo('p1');
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ ops: [expect.objectContaining({ op: 'add_block', value: expect.objectContaining({ unavailable_date: '2026-11-28' }) })] }));
  });

  it('共享日历恢复失败 → 不改栈并给出原因', async () => {
    const { apply } = setupShared();
    const applyShared = vi.fn(async () => ({ ok: false, reason: '公共日历保存失败' }));
    const undo = createPlanUndo({ apply, getPlanState: () => plan, getSharedBlocks: () => [], applyShared });
    const r = await undo.undoDetailed('p1');
    expect(r.label).toBeNull();
    expect(r.reason).toContain('公共日历');
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });
});

describe('撤销/重做通道与持久化', () => {
  it('undo 与 redo 都带 undo:true（快照可超 30 条 ops，恢复不做落位校验）', async () => {
    const { apply, undo } = setup();
    await undo.undo('p1');
    await undo.redo('p1');
    expect(apply).toHaveBeenCalledTimes(2);
    for (const call of apply.mock.calls) expect((call as any[])[0]).toMatchObject({ undo: true, record: false });
  });

  it('撤销后的栈转移随计划落库，刷新后可继续重做', async () => {
    const { __resetMemory } = await import('@/lib/local/db');
    const { flushBlockHistoryWrites } = await import('@/store/useBlockHistory');
    __resetMemory();
    const { undo } = setup();
    await undo.undo('p1');
    await flushBlockHistoryWrites();
    useBlockHistory.setState({ entries: {}, redo: {} });
    await useBlockHistory.getState().hydrate();
    expect(useBlockHistory.getState().redo.p1).toHaveLength(1);
    const label = await undo.redo('p1');
    expect(label).toBe('移动');
  });
});
