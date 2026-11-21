import { api, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { applyPatch } from '@/shared/engine';
import { usePlanStore } from '@/store/usePlanStore';
import { useSharedCalendar } from '@/store/useSharedCalendar';
import type { ApplyOp, Block, PlanState } from '@/shared/types';

/** 公共日历块（忙时/固定日程）没有计划，但引擎的 patch 需要一个计划上下文。 */
export function sharedPlanState(blocks: Block[] = useSharedCalendar.getState().busyBlocks): PlanState {
  const timezone = usePlanStore.getState().state.plan.timezone;
  const now = new Date().toISOString();
  return {
    plan: { id: null, title: '共享日历', horizon_start: now.slice(0, 10), horizon_days: 90, timezone, status: 'active', version: 1, created_at: now, updated_at: now },
    task_defs: [],
    constraints: [],
    blocks,
  };
}

let lastInverse: ApplyOp[] = [];

export async function applySharedOps(ops: ApplyOp[]): Promise<{ ok: boolean; reason?: string; inverseOps?: ApplyOp[] }> {
  const store = useSharedCalendar.getState();
  const previous = store.busyBlocks;
  store.setBusyBlocks(applyPatch(sharedPlanState(previous), ops).state.blocks);
  try {
    const resp = await api.sharedBlocks({ ops });
    useSharedCalendar.getState().setBusyBlocks(resp.blocks as Block[]);
    lastInverse = (resp.inverse_ops ?? []) as ApplyOp[];
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    return { ok: true, inverseOps: lastInverse };
  } catch (err) {
    useSharedCalendar.getState().setBusyBlocks(previous);
    return { ok: false, reason: err instanceof ApiError ? err.message : '公共日历保存失败，已恢复原状态' };
  }
}

export async function undoSharedOps(): Promise<{ ok: boolean; reason?: string }> {
  if (!lastInverse.length) return { ok: false, reason: '没有可撤销的公共日历操作' };
  const ops = lastInverse;
  lastInverse = [];
  return applySharedOps(ops);
}