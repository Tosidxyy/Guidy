import { applyPatch } from '@/shared/engine';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { PlanState } from '@/shared/types';

export interface PlanUndoDeps {
  apply(req: { planId: string; ops: any[]; label: string; optimistic: Partial<PlanState>; record: false; undo?: boolean }): Promise<{ ok: boolean; reason?: string }>;
  getPlanState(planId: string): PlanState | undefined;
}

export interface UndoResult {
  label: string | null;
  reason?: string;
}

export function createPlanUndo(deps: PlanUndoDeps) {
  async function run(planId: string, from: 'entries' | 'redo'): Promise<UndoResult> {
    const state = useBlockHistory.getState();
    const stack = state[from][planId] ?? [];
    const entry = stack[stack.length - 1];
    if (!entry) return { label: null };
    const plan = deps.getPlanState(planId);
    if (!plan) return { label: null, reason: '计划数据未就绪' };
    const ops = from === 'entries' ? entry.inverseOps : entry.forwardOps;
    if (!ops.length) return { label: null, reason: '这条记录没有可逆操作' };
    const patched = applyPatch(plan, ops).state;
    const optimistic = { plan: patched.plan, task_defs: patched.task_defs, constraints: patched.constraints, blocks: patched.blocks };
    const r = await deps.apply({ planId, ops, label: `${from === 'entries' ? '撤销' : '重做'}：${entry.label}`, optimistic, record: false, undo: from === 'entries' });
    if (!r.ok) return { label: null, reason: r.reason ?? '服务端拒绝了这次操作' };
    const to = from === 'entries' ? 'redo' : 'entries';
    useBlockHistory.setState((s) => ({
      [from]: { ...s[from], [planId]: stack.slice(0, -1) },
      [to]: { ...s[to], [planId]: [...(s[to][planId] ?? []), entry] },
    }) as any);
    return { label: entry.label };
  }

  return {
    undo: (planId: string) => run(planId, 'entries').then((r) => r.label),
    redo: (planId: string) => run(planId, 'redo').then((r) => r.label),
    undoDetailed: (planId: string) => run(planId, 'entries'),
    redoDetailed: (planId: string) => run(planId, 'redo'),
  };
}