import { create } from 'zustand';

interface PlanSyncState {
  serverVersions: Record<string, number>;
  setServerVersion(planId: string, version: number): void;
  forget(planId: string): void;
}

export const usePlanSync = create<PlanSyncState>((set) => ({
  serverVersions: {},
  setServerVersion: (planId, version) => set((s) => ({ serverVersions: { ...s.serverVersions, [planId]: version } })),
  forget: (planId) => set((s) => {
    const next = { ...s.serverVersions };
    delete next[planId];
    return { serverVersions: next };
  }),
}));