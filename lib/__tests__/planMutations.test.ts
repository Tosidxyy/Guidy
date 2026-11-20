import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { createPlanMutations, type PlanMutationDeps } from '@/lib/planMutations';
import type { PlanState } from '@/shared/types';

const plan = { id: 'p1', title: '计划', horizon_start: '2026-11-16', horizon_days: 7 as const, timezone: 'Asia/Shanghai', status: 'active' as const, version: 1, created_at: '', updated_at: '' };
const state = (): PlanState => ({ plan, task_defs: [], constraints: [], blocks: [] });

function deps(over: Partial<PlanMutationDeps> = {}): PlanMutationDeps {
  return {
    patch: vi.fn(async () => ({
      plan: { ...plan, version: 2 },
      version: 2,
      blocks: [{ id: 'b1', title: 'x', category: 'study', start_utc: '2026-11-16T02:00:00.000Z', end_utc: '2026-11-16T03:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }],
      task_defs: [],
      constraints: [],
      inverse_ops: [{ op: 'remove_block', id: 'b1' }],
    })),
    fetchPlan: vi.fn(async () => state()),
    getActivePlanId: () => 'p1',
    getActiveState: state,
    applyActiveState: vi.fn(),
    getLayer: () => undefined,
    applyLayerState: vi.fn(),
    pushHistory: vi.fn(),
    invalidatePlans: vi.fn(),
    ...over,
  };
}

describe('createPlanMutations', () => {
  it('成功：乐观更新、提交正确 base_version、应用服务端状态与历史', async () => {
    const d = deps();
    const apply = createPlanMutations(d);
    const optimistic = { blocks: [] };
    const r = await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimistic });
    expect(r.ok).toBe(true);
    expect(d.patch).toHaveBeenCalledWith(expect.objectContaining({ plan_id: 'p1', base_version: 1 }));
    expect(d.applyActiveState).toHaveBeenNthCalledWith(1, optimistic);
    expect(d.applyActiveState).toHaveBeenLastCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ version: 2 }),
      blocks: [expect.objectContaining({ id: 'b1' })],
    }));
    expect(d.pushHistory).toHaveBeenCalledTimes(1);
  });

  it('元数据响应同样应用到本地状态', async () => {
    const d = deps({
      patch: vi.fn(async () => ({
        plan: { ...plan, title: '新标题', version: 2 },
        version: 2,
        blocks: [],
        task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
        constraints: [{ id: '11111111-1111-4111-8111-111111111111', payload: { type: 'buffer', minutes: 10 }, source: 'user', enabled: true }],
        inverse_ops: [{ op: 'remove_constraint', id: '11111111-1111-4111-8111-111111111111' }],
      })),
    });
    const apply = createPlanMutations(d);
    const r = await apply({
      planId: 'p1',
      ops: [{ op: 'update_plan', patch: { title: '新标题' } }],
      label: '重命名计划',
      optimistic: { plan: { ...plan, title: '新标题' } },
    });
    expect(r.ok).toBe(true);
    expect(d.applyActiveState).toHaveBeenLastCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ title: '新标题' }),
      task_defs: expect.arrayContaining([expect.objectContaining({ key: 'math' })]),
      constraints: expect.arrayContaining([expect.objectContaining({ source: 'user' })]),
    }));
  });

  it('失败：回滚乐观状态，不写历史/版本', async () => {
    const d = deps({ patch: vi.fn(async () => { throw new Error('409'); }) });
    const apply = createPlanMutations(d);
    const r = await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimistic: { blocks: [] } });
    expect(r.ok).toBe(false);
    expect(d.applyActiveState).toHaveBeenLastCalledWith(expect.objectContaining({ plan }));
    expect(d.pushHistory).not.toHaveBeenCalled();
  });

  it('patch_target_missing 时重新拉取并对齐云端', async () => {
    const fresh: PlanState = { ...state(), plan: { ...plan, version: 5 } };
    const d = deps({
      patch: vi.fn(async () => { throw new ApiError('patch_target_missing', 422, '目标已变化'); }),
      fetchPlan: vi.fn(async () => fresh),
    });
    const apply = createPlanMutations(d);
    const r = await apply({ planId: 'p1', ops: [{ op: 'remove_constraint', id: 'gone' }], label: '删除约束', optimistic: { constraints: [] } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('刷新');
    expect(d.applyActiveState).toHaveBeenLastCalledWith(expect.objectContaining({ plan: expect.objectContaining({ version: 5 }) }));
  });

  it('同意图重试使用同一 preview_id（幂等），不同 base_version 则不同', async () => {
    const { previewIdFor } = await import('@/lib/planMutations');
    const ops: any[] = [{ op: 'remove_block', id: 'b1' }];
    expect(previewIdFor('p1', 3, ops)).toBe(previewIdFor('p1', 3, ops));
    expect(previewIdFor('p1', 3, ops)).not.toBe(previewIdFor('p1', 4, ops));
  });

  it('inverse_ops 为空时不写历史（reschedule 等不可逆操作）', async () => {
    const d = deps({ patch: vi.fn(async () => ({ plan: { ...plan, version: 2 }, version: 2, blocks: [], task_defs: [], constraints: [], inverse_ops: [] })) });
    const apply = createPlanMutations(d);
    await apply({ planId: 'p1', ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }], label: '重新排程', optimistic: {} });
    expect(d.pushHistory).not.toHaveBeenCalled();
  });

  it('record:false 不写历史（撤销/重做内部使用）', async () => {
    const d = deps();
    const apply = createPlanMutations(d);
    await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '撤销', optimistic: { blocks: [] }, record: false });
    expect(d.pushHistory).not.toHaveBeenCalled();
  });
});