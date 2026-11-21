import { create } from 'zustand';
import { LIMITS } from '@/shared/constants';
import { getBlockHistory, putBlockHistory } from '@/lib/local/repo';
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
  /** 撤销/重做成功后把栈顶条目移到另一侧，并随计划持久化。 */
  transfer(planId: string, from: 'entries' | 'redo'): void;
  /** 启动时从 IndexedDB 恢复各计划的撤销/重做历史。 */
  hydrate(): Promise<void>;
  clear(): void;
}

// 写入串行化：连续 push/transfer 时后一次快照必须覆盖前一次，不能被乱序落库回退。
let writeChain: Promise<void> = Promise.resolve();
function persist(s: Pick<BlockHistoryState, 'entries' | 'redo'>) {
  const snapshot = { entries: s.entries, redo: s.redo };
  writeChain = writeChain.then(() => putBlockHistory(snapshot)).catch(() => { /* 落库失败不阻断交互 */ });
}
export function flushBlockHistoryWrites(): Promise<void> { return writeChain; }

export const useBlockHistory = create<BlockHistoryState>((set, get) => ({
  entries: {},
  redo: {},
  push: (planId, entry) => {
    set((s) => ({
      entries: { ...s.entries, [planId]: [...(s.entries[planId] ?? []), entry].slice(-LIMITS.undoDepth) },
      redo: { ...s.redo, [planId]: [] },
    }));
    persist(get());
  },
  forget: (planId) => {
    set((s) => {
      const entries = { ...s.entries };
      const redo = { ...s.redo };
      delete entries[planId];
      delete redo[planId];
      return { entries, redo };
    });
    persist(get());
  },
  transfer: (planId, from) => {
    const to = from === 'entries' ? 'redo' : 'entries';
    set((s) => {
      const stack = s[from][planId] ?? [];
      const entry = stack[stack.length - 1];
      if (!entry) return s;
      return {
        [from]: { ...s[from], [planId]: stack.slice(0, -1) },
        [to]: { ...s[to], [planId]: [...(s[to][planId] ?? []), entry] },
      } as Partial<BlockHistoryState>;
    });
    persist(get());
  },
  hydrate: async () => {
    const stored = await getBlockHistory();
    set({ entries: stored.entries ?? {}, redo: stored.redo ?? {} });
  },
  clear: () => {
    set({ entries: {}, redo: {} });
    persist(get());
  },
}));