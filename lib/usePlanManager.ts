import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePlanStore } from '@/store/usePlanStore';
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
    getConversations: () => conversations.data?.items ?? [],
    setConversation: (id, msgs) => useChatStore.getState().setConversation(id, msgs),
    setChatState: (patch) => useChatStore.setState(patch),
    newConversation: () => chatController.newConversation(),
    resume: () => chatController.resume(),
    isStreaming: () => useChatStore.getState().streaming,
    invalidatePlans: () => { qc.invalidateQueries({ queryKey: ['plans'] }); },
    listPlans: async () => (await api.plans()).items,
  });
  const run = async (fn: () => void | Promise<void>) => { setPending(true); try { await fn(); } finally { setPending(false); } };
  return {
    plans: (query.data?.items ?? []) as PlanListItem[],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    switchPlan: (id: string) => run(() => manager.switchPlan(id)),
    newPlan: () => run(() => manager.newPlan()),
    deletePlan: (id: string) => run(() => manager.deletePlan(id)),
    isPending: pending,
  };
}