import { create } from 'zustand';
import type { ApplyOp } from '@/shared/types';

export interface BlockHistoryEntry {
  at: number;
  label: string;
  forwardOps: ApplyOp[];
  inverseOps: ApplyOp[];
}

interface BlockHistoryState {
  entries: Record<string, BlockHistoryEntry[]>;
  redo: Record<string, BlockHistoryEntry[]>;
  push(planId: string, entry: BlockHistoryEntry): void;
  forget(planId: string): void;
}

export const useBlockHistory = create<BlockHistoryState>((set) => ({
  entries: {},
  redo: {},
  push: (planId, entry) => set((s) => ({
    entries: { ...s.entries, [planId]: [...(s.entries[planId] ?? []), entry] },
    redo: { ...s.redo, [planId]: [] },
  })),
  forget: (planId) => set((s) => {
    const entries = { ...s.entries };
    const redo = { ...s.redo };
    delete entries[planId];
    delete redo[planId];
    return { entries, redo };
  }),
}));