import { useState } from 'react';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { usePlanStore } from '@/store/usePlanStore';
import { usePlanSync } from '@/store/usePlanSync';
import { useChatStore } from '@/store/useChatStore';
import { chatController } from '@/lib/chatRuntime';
import { createPlanManager } from '@/lib/planManagerCore';

export interface PlanListItem { id: string; title: string; status: string; horizon_start: string; horizon_days: number; timezone: string; version: number; updated_at: string }

export function usePlanManager() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['plans'], queryFn: () => api.plans(), retry: false });
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.conversations(), retry: false });
  const [pending, setPending] = useState(false);
  const manager = createPlanManager({
    fetchPlan: (id) => api.plan(id),
    deletePlan: (id) => api.deletePlan(id),
    fetchHistory: (id) => api.history(id),
    getPlanState: () => usePlanStore.getState().state,
    importState: (s) => usePlanStore.getState().importState(s),
    getConversations: async () => {
      // commit 会在服务端把当前对话绑定到新计划；缓存可能仍是绑定前的列表，
      // 因此切换计划前先刷新，否则同一会话内新建的计划切回去会丢对话。
      const r = await conversations.refetch().catch(() => null);
      return r?.data?.items ?? conversations.data?.items ?? [];
    },
    setConversation: (id, msgs) => useChatStore.getState().setConversation(id, msgs),
    setChatState: (patch) => useChatStore.setState(patch),
    newConversation: () => chatController.newConversation(),
    resume: () => chatController.resume(),
    isStreaming: () => useChatStore.getState().streaming,
    invalidatePlans: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
    listPlans: async () => (await api.plans()).items,
  });
  const run = async (fn: () => void | Promise<void>) => {
    setPending(true);
    try { await fn(); }
    catch (err) {
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '操作失败，请重试');
      toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
    }
    finally { setPending(false); }
  };
  return {
    plans: (query.data?.items ?? []) as PlanListItem[],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    switchPlan: (id: string) => run(async () => {
      await manager.switchPlan(id);
      const plan = usePlanStore.getState().state.plan;
      if (plan.id === id) usePlanSync.getState().setServerVersion(id, plan.version);
    }),
    newPlan: () => run(() => manager.newPlan()),
    deletePlan: (id: string) => run(async () => {
      await manager.deletePlan(id);
      // 删除后服务端已解绑该计划的对话，列表缓存须同步失效。
      qc.invalidateQueries({ queryKey: ['conversations'] });
    }),
    isPending: pending,
  };
}