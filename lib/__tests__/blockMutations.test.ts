import { describe, expect, it, vi } from 'vitest';
import { createBlockMutations, type BlockMutationDeps } from '@/lib/blockMutations';

function deps(over: Partial<BlockMutationDeps> = {}): BlockMutationDeps {
  return {
    patch: vi.fn(async () => ({
      version: 2,
      blocks: [{ id: 'b1', title: 'x', category: 'study', start_utc: '2026-11-16T02:00:00.000Z', end_utc: '2026-11-16T03:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }],
      task_defs: [],
      constraints: [],
      inverse_ops: [],
    })),
    getServerVersion: () => 1,
    fetchPlan: vi.fn(),
    setServerVersion: vi.fn(),
    getActivePlanId: () => 'p1',
    getActiveBlocks: () => [],
    applyActiveBlocks: vi.fn(),
    getLayer: () => undefined,
    setLayerBlocks: vi.fn(),
    pushHistory: vi.fn(),
    invalidatePlans: vi.fn(),
    ...over,
  };
}

describe('createBlockMutations', () => {
  it('成功：乐观更新、提交正确 base_version、更新版本与历史', async () => {
    const d = deps();
    const apply = createBlockMutations(d);
    const r = await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimisticBlocks: [] });
    expect(r.ok).toBe(true);
    expect(d.patch).toHaveBeenCalledWith(expect.objectContaining({ plan_id: 'p1', base_version: 1 }));
    expect(d.applyActiveBlocks).toHaveBeenLastCalledWith(expect.any(Array));
    expect(d.setServerVersion).toHaveBeenCalledWith('p1', 2);
    expect(d.pushHistory).toHaveBeenCalledTimes(1);
  });

  it('失败：回滚乐观块，不写历史/版本', async () => {
    const d = deps({ patch: vi.fn(async () => { throw new Error('409'); }) });
    const apply = createBlockMutations(d);
    const r = await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimisticBlocks: [] });
    expect(r.ok).toBe(false);
    expect(d.applyActiveBlocks).toHaveBeenLastCalledWith([]);
    expect(d.setServerVersion).not.toHaveBeenCalled();
    expect(d.pushHistory).not.toHaveBeenCalled();
  });

  it('缺少版本时先拉取计划', async () => {
    const d = deps({
      getServerVersion: () => undefined,
      fetchPlan: vi.fn(async () => ({ plan: { id: 'p1', version: 4 }, task_defs: [], constraints: [], blocks: [] } as any)),
    });
    const apply = createBlockMutations(d);
    await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimisticBlocks: [] });
    expect(d.fetchPlan).toHaveBeenCalledWith('p1');
    expect(d.setServerVersion).toHaveBeenCalledWith('p1', 4);
  });

  it('409 时回滚乐观块，不写版本/历史', async () => {
    const d = deps({ patch: vi.fn(async () => { throw Object.assign(new Error('计划已被更新'), { status: 409 }); }) });
    const apply = createBlockMutations(d);
    const r = await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimisticBlocks: [] });
    expect(r.ok).toBe(false);
    expect(d.applyActiveBlocks).toHaveBeenLastCalledWith([]);
    expect(d.setServerVersion).not.toHaveBeenCalled();
    expect(d.pushHistory).not.toHaveBeenCalled();
  });

  it('record:false 不写历史（撤销/重做内部使用）', async () => {
    const d = deps();
    const apply = createBlockMutations(d);
    await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '撤销', optimisticBlocks: [], record: false });
    expect(d.pushHistory).not.toHaveBeenCalled();
  });
});