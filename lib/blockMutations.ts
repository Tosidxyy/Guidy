import { ApiError } from '@/lib/api';
import { ENGINE_VERSION } from '@/shared/constants';
import type { Block, PatchOp, PlanState } from '@/shared/types';

export interface BlockMutationDeps {
  patch(body: unknown): Promise<any>;
  getServerVersion(planId: string): number | undefined;
  fetchPlan(planId: string): Promise<PlanState>;
  setServerVersion(planId: string, version: number): void;
  getActivePlanId(): string | null;
  getActiveBlocks(): Block[];
  applyActiveBlocks(blocks: Block[]): void;
  getLayer(planId: string): PlanState | undefined;
  setLayerBlocks(planId: string, blocks: Block[]): void;
  pushHistory(planId: string, entry: { at: number; label: string; forwardOps: PatchOp[]; inverseOps: PatchOp[] }): void;
  invalidatePlans(): void;
}

export interface BlockOpRequest {
  planId: string;
  ops: PatchOp[];
  label: string;
  optimisticBlocks: Block[];
  record?: boolean;
}

export function createBlockMutations(deps: BlockMutationDeps) {
  return async function applyBlockOps(req: BlockOpRequest): Promise<{ ok: boolean; reason?: string; resp?: any }> {
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
    const previous = active ? deps.getActiveBlocks() : deps.getLayer(req.planId)?.blocks;
    if (!previous) return { ok: false, reason: '计划数据未就绪' };
    const applyBlocks = (blocks: Block[]) => active ? deps.applyActiveBlocks(blocks) : deps.setLayerBlocks(req.planId, blocks);
    applyBlocks(req.optimisticBlocks);
    try {
      const resp = await deps.patch({
        preview_id: crypto.randomUUID(), plan_id: req.planId, base_version: version,
        ops: req.ops, result_hash: null, engine_version: ENGINE_VERSION,
      });
      applyBlocks(resp.blocks);
      deps.setServerVersion(req.planId, resp.version);
      if (req.record !== false) {
        deps.pushHistory(req.planId, { at: Date.now(), label: req.label, forwardOps: req.ops, inverseOps: resp.inverse_ops });
      }
      deps.invalidatePlans();
      return { ok: true, resp };
    } catch (err) {
      applyBlocks(previous);
      return { ok: false, reason: err instanceof ApiError ? err.message : '块操作失败，已恢复原位置' };
    }
  };
}