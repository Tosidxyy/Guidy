import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { createBlockMutations } from '@/lib/blockMutations';
import { createBlockUndo } from '@/lib/blockUndo';
import { usePlanStore } from '@/store/usePlanStore';
import { usePlanSync } from '@/store/usePlanSync';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { PlanState } from '@/shared/types';

const apply = createBlockMutations({
  patch: (body) => api.applyPatch(body),
  getServerVersion: (id) => usePlanSync.getState().serverVersions[id],
  fetchPlan: (id) => api.plan(id) as Promise<PlanState>,
  setServerVersion: (id, v) => usePlanSync.getState().setServerVersion(id, v),
  getActivePlanId: () => usePlanStore.getState().state.plan.id,
  getActiveBlocks: () => usePlanStore.getState().state.blocks,
  applyActiveBlocks: (blocks) => usePlanStore.getState().applyServerBlocks(blocks),
  getLayer: (id) => queryClient.getQueryData<PlanState>(['plan', id]),
  setLayerBlocks: (id, blocks) => queryClient.setQueryData<PlanState>(['plan', id], (old) => old ? { ...old, blocks } : old),
  pushHistory: (id, entry) => useBlockHistory.getState().push(id, entry),
  invalidatePlans: () => { void queryClient.invalidateQueries({ queryKey: ['plans'] }); },
});

const undoer = createBlockUndo({
  apply: (req) => apply(req),
  getPlanState: (id) => {
    const active = usePlanStore.getState().state;
    if (active.plan.id === id) return active;
    return queryClient.getQueryData<PlanState>(['plan', id]);
  },
});

export const blockController = {
  apply,
  undo: (planId: string) => undoer.undo(planId),
  redo: (planId: string) => undoer.redo(planId),
};