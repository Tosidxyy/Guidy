import { ApiError } from '@/lib/api';
import { ENGINE_VERSION } from '@/shared/constants';
import type { ApplyOp, PlanState } from '@/shared/types';
import type { BlockHistoryEntry } from '@/store/useBlockHistory';

export interface PlanMutationDeps {
  patch(body: unknown): Promise<any>;
  getServerVersion(planId: string): number | undefined;
  fetchPlan(planId: string): Promise<PlanState>;
  setServerVersion(planId: string, version: number): void;
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

export function createPlanMutations(deps: PlanMutationDeps) {
  return async function applyPlanOps(req: PlanOpRequest): Promise<{ ok: boolean; reason?: string; resp?: any }> {
    let version = deps.getServerVersion(req.planId);
    if (version === undefined) {
      try {
        const plan = await deps.fetchPlan(req.planId);
        version = plan.plan.version;
        deps.setServerVersion(req.planId, version);
      } catch (err) {
        return { ok: false, reason: err instanceof ApiError ? err.message : '无法读取计划版本' };
      }
    }
    const active = deps.getActivePlanId() === req.planId;
    const previous = active ? deps.getActiveState() : deps.getLayer(req.planId);
    if (!previous) return { ok: false, reason: '计划数据未就绪' };
    const applyState = (patch: Partial<PlanState>) => active
      ? deps.applyActiveState(patch)
      : deps.applyLayerState(req.planId, patch);
    applyState(req.optimistic);
    try {
      const resp = await deps.patch({
        preview_id: crypto.randomUUID(), plan_id: req.planId, base_version: version,
        ops: req.ops, result_hash: null, engine_version: ENGINE_VERSION,
        ...(req.undo ? { undo: true } : {}),
      });
      applyState(serverState(resp, previous));
      deps.setServerVersion(req.planId, resp.version);
      const inverse = Array.isArray(resp.inverse_ops) ? resp.inverse_ops : [];
      if (req.record !== false && inverse.length > 0) {
        deps.pushHistory(req.planId, { at: Date.now(), label: req.label, forwardOps: req.ops, inverseOps: inverse });
      }
      deps.invalidatePlans();
      return { ok: true, resp };
    } catch (err) {
      applyState(previous);
      if (err instanceof ApiError && err.code === 'patch_target_missing') {
        // 目标 ID 已被云端替换（历史数据或并发保存）：拉一次，把本地对齐到云端。
        try {
          const fresh = await deps.fetchPlan(req.planId);
          applyState(fresh);
          deps.setServerVersion(req.planId, fresh.plan.version);
        } catch { /* 保持回滚后的本地状态 */ }
        return { ok: false, reason: '目标已在云端变化，已刷新到最新状态，请重试' };
      }
      return { ok: false, reason: err instanceof ApiError ? err.message : '操作失败，已恢复原状态' };
    }
  };
}