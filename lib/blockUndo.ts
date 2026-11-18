import { applyPatch } from '@/shared/engine';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { PlanState } from '@/shared/types';

export interface BlockUndoDeps {
  apply(req: { planId: string; ops: any[]; label: string; optimisticBlocks: any[]; record: false }): Promise<{ ok: boolean; reason?: string }>;
  getPlanState(planId: string): PlanState | undefined;
}

export function createBlockUndo(deps: BlockUndoDeps) {
  async function run(planId: string, from: 'entries' | 'redo'): Promise<string | null> {
    const state = useBlockHistory.getState();
    const stack = state[from][planId] ?? [];
    const entry = stack[stack.length - 1];
    if (!entry) return null;
    const plan = deps.getPlanState(planId);
    if (!plan) return null;
    const ops = from === 'entries' ? entry.inverseOps : entry.forwardOps;
    const optimisticBlocks = applyPatch(plan, ops).state.blocks;
    const r = await deps.apply({ planId, ops, label: `${from === 'entries' ? '撤销' : '重做'}：${entry.label}`, optimisticBlocks, record: false });
    if (!r.ok) return null;
    const to = from === 'entries' ? 'redo' : 'entries';
    useBlockHistory.setState((s) => ({
      [from]: { ...s[from], [planId]: stack.slice(0, -1) },
      [to]: { ...s[to], [planId]: [...(s[to][planId] ?? []), entry] },
    }) as any);
    return entry.label;
  }

  return {
    undo: (planId: string) => run(planId, 'entries'),
    redo: (planId: string) => run(planId, 'redo'),
  };
}