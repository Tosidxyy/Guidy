import { applyPatch, inheritUnavailableDates } from '@/shared/engine';
import { resolvePatchTargets, SHARED_PLAN_ID } from '@/lib/patchTargets';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { Block, PlanState } from '@/shared/types';

export interface PlanUndoDeps {
  apply(req: { planId: string; ops: any[]; label: string; optimistic: Partial<PlanState>; record: false; undo?: boolean }): Promise<{ ok: boolean; reason?: string }>;
  getPlanState(planId: string): PlanState | undefined;
  /** AI 调整可能同时改公共日历（细化替换共享块）：撤销/重做要把这部分路由回共享通道。 */
  getSharedBlocks?(): (Pick<Block, 'id'> & Partial<Block>)[];
  applyShared?(ops: any[]): Promise<{ ok: boolean; reason?: string }>;
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
    const originalOps = from === 'entries' ? entry.inverseOps : entry.forwardOps;
    const sharedBlocks = deps.getSharedBlocks?.() ?? [];
    const completeShared = sharedBlocks.filter((b): b is Block => !!b.start_utc && !!b.end_utc && !!b.title);
    const ops = inheritUnavailableDates([...plan.blocks, ...completeShared], originalOps, plan.plan.timezone);
    if (!ops.length) return { label: null, reason: '这条记录没有可逆操作' };
    const sharedOps = deps.applyShared
      ? resolvePatchTargets(ops as any, plan, [], deps.getSharedBlocks?.() ?? []).find((g) => g.planId === SHARED_PLAN_ID)?.ops ?? []
      : [];
    const planOps = sharedOps.length ? ops.filter((op) => !sharedOps.includes(op as any)) : ops;
    const label = `${from === 'entries' ? '撤销' : '重做'}：${entry.label}`;
    if (planOps.length) {
      const patched = applyPatch(plan, planOps).state;
      const optimistic = { plan: patched.plan, task_defs: patched.task_defs, constraints: patched.constraints, blocks: patched.blocks };
      // 撤销与重做都走 undo 通道：快照式记录（确认生成）可超过 30 条 ops，且恢复历史块不做落位校验。
      const r = await deps.apply({ planId, ops: planOps, label, optimistic, record: false, undo: true });
      if (!r.ok) return { label: null, reason: r.reason ?? '服务端拒绝了这次操作' };
    }
    if (sharedOps.length) {
      const r = await deps.applyShared!(sharedOps.map((op: any) => {
        const { plan_id, ...rest } = op;
        return plan_id === SHARED_PLAN_ID ? rest : op;
      }));
      if (!r.ok) return { label: null, reason: r.reason ?? '公共日历恢复失败' };
    }
    useBlockHistory.getState().transfer(planId, from);
    return { label: entry.label };
  }

  return {
    undo: (planId: string) => run(planId, 'entries').then((r) => r.label),
    redo: (planId: string) => run(planId, 'redo').then((r) => r.label),
    undoDetailed: (planId: string) => run(planId, 'entries'),
    redoDetailed: (planId: string) => run(planId, 'redo'),
  };
}