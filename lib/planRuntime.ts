import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { createPlanMutations } from '@/lib/planMutations';
import { createPlanUndo } from '@/lib/planUndo';
import { usePlanStore } from '@/store/usePlanStore';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { PlanState } from '@/shared/types';

const apply = createPlanMutations({
  patch: (body) => api.applyPatch(body),
  fetchPlan: (id) => api.plan(id) as Promise<PlanState>,
  getActivePlanId: () => usePlanStore.getState().state.plan.id,
  getActiveState: () => usePlanStore.getState().state,
  applyActiveState: (patch) => usePlanStore.getState().applyServerState(patch),
  getLayer: (id) => queryClient.getQueryData<PlanState>(['plan', id]),
  applyLayerState: (id, patch) => queryClient.setQueryData<PlanState>(['plan', id], (old) => old ? { ...old, ...patch } : old),
  pushHistory: (id, entry) => useBlockHistory.getState().push(id, entry),
  invalidatePlans: () => { void queryClient.invalidateQueries({ queryKey: ['plans'] }); },
});

const undoer = createPlanUndo({
  apply: (req) => apply(req),
  getPlanState: (id) => {
    const active = usePlanStore.getState().state;
    if (active.plan.id === id) return active;
    return queryClient.getQueryData<PlanState>(['plan', id]);
  },
});

export const planController = {
  apply,
  undo: (planId: string) => undoer.undo(planId),
  redo: (planId: string) => undoer.redo(planId),
  undoDetailed: (planId: string) => undoer.undoDetailed(planId),
  redoDetailed: (planId: string) => undoer.redoDetailed(planId),
};