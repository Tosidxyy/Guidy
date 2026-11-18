import { describe, expect, it, vi } from 'vitest';
import { createPlanManager } from '@/lib/planManagerCore';
import type { PlanState } from '@/shared/types';

const serverPlan: PlanState = { plan: { id: 'p2', title: 't', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' }, task_defs: [], constraints: [], blocks: [] };
function fakeDeps(over: Record<string, unknown> = {}) {
  return {
    fetchPlan: vi.fn(async () => serverPlan),
    deletePlan: vi.fn(async () => ({ ok: true })),
    fetchHistory: vi.fn(async () => ({ conversation: {}, messages: [{ seq: 1, role: 'assistant', kind: 'text', content: 'hi' }] })),
    getPlanState: () => ({ plan: { id: 'p1' } } as PlanState),
    importState: vi.fn(),
    getConversations: () => [{ id: 'c2', plan_id: 'p2', status: 'active' }],
    setConversation: vi.fn(),
    setChatState: vi.fn(),
    newConversation: vi.fn(),
    resume: vi.fn(),
    isStreaming: () => false,
    invalidatePlans: vi.fn(),
    listPlans: vi.fn(async () => [{ id: 'p3' }]),
    ...over,
  };
}
describe('createPlanManager', () => {
  it('switchPlan 流式中 → no-op', async () => {
    const d = fakeDeps({ isStreaming: () => true });
    await createPlanManager(d).switchPlan('p2');
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
  it('switchPlan 正常 → fetchPlan + importState + 恢复对话 + resume', async () => {
    const d = fakeDeps();
    await createPlanManager(d).switchPlan('p2');
    expect(d.fetchPlan).toHaveBeenCalledWith('p2');
    expect(d.importState).toHaveBeenCalledWith(serverPlan);
    expect(d.setConversation).toHaveBeenCalledWith('c2', expect.any(Array));
    expect(d.resume).toHaveBeenCalled();
  });
  it('switchPlan 同 id → 不 fetchPlan', async () => {
    const d = fakeDeps();
    await createPlanManager(d).switchPlan('p1');
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
  it('newPlan → importState 空计划 + newConversation', () => {
    const d = fakeDeps();
    createPlanManager(d).newPlan();
    expect(d.importState).toHaveBeenCalled();
    expect(d.newConversation).toHaveBeenCalled();
  });
  it('deletePlan 非当前 → 删除 + invalidate，不切换', async () => {
    const d = fakeDeps();
    await createPlanManager(d).deletePlan('p9');
    expect(d.deletePlan).toHaveBeenCalledWith('p9');
    expect(d.invalidatePlans).toHaveBeenCalled();
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
  it('deletePlan 当前且有剩余 → 切到首个剩余', async () => {
    const d = fakeDeps();
    await createPlanManager(d).deletePlan('p1');
    expect(d.fetchPlan).toHaveBeenCalledWith('p3');
  });
  it('deletePlan 当前且无剩余 → newPlan', async () => {
    const d = fakeDeps({ listPlans: vi.fn(async () => []) });
    await createPlanManager(d).deletePlan('p1');
    expect(d.newConversation).toHaveBeenCalled();
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
  it('restoreConversation 无匹配 → newConversation', async () => {
    const d = fakeDeps({ getConversations: () => [] });
    await createPlanManager(d).restoreConversation('p2');
    expect(d.newConversation).toHaveBeenCalled();
  });
  it('restoreConversation 使用异步刷新的会话列表（commit 绑定后缓存可能过期）', async () => {
    const d = fakeDeps({ getConversations: vi.fn(async () => [{ id: 'c2', plan_id: 'p2', status: 'active' }]) });
    await createPlanManager(d).restoreConversation('p2');
    expect(d.fetchHistory).toHaveBeenCalledWith('c2');
    expect(d.newConversation).not.toHaveBeenCalled();
  });
  it('switchPlan fetch 失败 → 不覆盖活动态 + invalidate + 抛出', async () => {
    const d = fakeDeps({ fetchPlan: vi.fn(async () => { throw Object.assign(new Error('gone'), { status: 404 }); }) });
    await expect(createPlanManager(d).switchPlan('p2')).rejects.toThrow('gone');
    expect(d.importState).not.toHaveBeenCalled();
    expect(d.invalidatePlans).toHaveBeenCalled();
  });
  it('deletePlan 404 → 按已不在处理：invalidate + 兜底切换', async () => {
    const d = fakeDeps({ deletePlan: vi.fn(async () => { throw Object.assign(new Error('not found'), { status: 404 }); }) });
    await createPlanManager(d).deletePlan('p1');
    expect(d.invalidatePlans).toHaveBeenCalled();
    expect(d.fetchPlan).toHaveBeenCalledWith('p3');
  });
  it('deletePlan 非 404 失败 → 抛出，不做兜底切换', async () => {
    const d = fakeDeps({ deletePlan: vi.fn(async () => { throw Object.assign(new Error('boom'), { status: 503 }); }) });
    await expect(createPlanManager(d).deletePlan('p1')).rejects.toThrow('boom');
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });
});