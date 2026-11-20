import { ApiError } from '@/lib/api';
import { stableHash, stableJson } from '@/lib/stableKey';
import { ENGINE_VERSION } from '@/shared/constants';
import type { ApplyOp, PlanState } from '@/shared/types';
import type { BlockHistoryEntry } from '@/store/useBlockHistory';

export interface PlanMutationDeps {
  patch(body: unknown): Promise<any>;
  fetchPlan(planId: string): Promise<PlanState>;
  getActivePlanId(): string | null;
  getActiveState(): PlanState;
  applyActiveState(patch: Partial<PlanState>): void;
  getLayer(planId: string): PlanState | undefined;
  applyLayerState(planId: string, patch: Partial<PlanState>): void;
  pushHistory(planId: string, entry: BlockHistoryEntry): void;
  invalidatePlans(): void;
}

export interface PlanOpRequest {
  planId: string;
  ops: ApplyOp[];
  label: string;
  /** 只替换给出的切片；其余保持本地现状，等响应覆盖。 */
  optimistic: Partial<PlanState>;
  record?: boolean;
  undo?: boolean;
}

function serverState(resp: any, previous: PlanState): Partial<PlanState> {
  const plan = resp.plan
    ? { ...resp.plan, version: resp.version }
    : { ...previous.plan, version: resp.version, updated_at: new Date().toISOString() };
  return {
    plan,
    ...(resp.task_defs ? { task_defs: resp.task_defs } : {}),
    ...(resp.constraints ? { constraints: resp.constraints } : {}),
    ...(resp.blocks ? { blocks: resp.blocks } : {}),
  };
}

/** 同一意图的稳定幂等键：网络抖动后重试不会撞 version_conflict，也不会重复落 ops。 */
export function previewIdFor(planId: string, baseVersion: number, ops: ApplyOp[], undo = false): string {
  return `pv-${stableHash(stableJson({ plan: planId, base: baseVersion, ops, undo }))}`;
}

export function createPlanMutations(deps: PlanMutationDeps) {
  return async function applyPlanOps(req: PlanOpRequest): Promise<{ ok: boolean; reason?: string; resp?: any }> {
    const active = deps.getActivePlanId() === req.planId;
    const previous = active ? deps.getActiveState() : deps.getLayer(req.planId);
    if (!previous) return { ok: false, reason: '计划数据未就绪' };
    const version = previous.plan.version;
    const applyState = (patch: Partial<PlanState>) => active
      ? deps.applyActiveState(patch)
      : deps.applyLayerState(req.planId, patch);
    applyState(req.optimistic);
    try {
      const resp = await deps.patch({
        preview_id: previewIdFor(req.planId, version, req.ops, !!req.undo), plan_id: req.planId, base_version: version,
        ops: req.ops, result_hash: null, engine_version: ENGINE_VERSION,
        ...(req.undo ? { undo: true } : {}),
      });
      applyState(serverState(resp, previous));
      const inverse = Array.isArray(resp.inverse_ops) ? resp.inverse_ops : [];
      if (req.record !== false && inverse.length > 0) {
        deps.pushHistory(req.planId, { at: Date.now(), label: req.label, forwardOps: req.ops, inverseOps: inverse });
      }
      deps.invalidatePlans();
      return { ok: true, resp };
    } catch (err) {
      applyState(previous);
      if (err instanceof ApiError && err.code === 'patch_target_missing') {
        const details = err.details as any;
        try {
          const fresh = details?.plan && Array.isArray(details.blocks)
            ? ({ plan: details.plan, task_defs: details.task_defs ?? previous.task_defs, constraints: details.constraints ?? previous.constraints, blocks: details.blocks } as PlanState)
            : await deps.fetchPlan(req.planId);
          applyState(fresh);
        } catch { /* 保持回滚后的本地状态 */ }
        return { ok: false, reason: '目标已变化，已刷新到最新状态，请重试' };
      }
      return { ok: false, reason: err instanceof ApiError ? err.message : '操作失败，已恢复原状态' };
    }
  };
}