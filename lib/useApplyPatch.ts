import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildPatchBody } from '@/lib/patchInput';
import { applyPatch, solve } from '@/shared/engine';
import { ENGINE_VERSION } from '@/shared/constants';
import { mergeSharedWindows } from '@/lib/sharedCalendar';
import { planController } from '@/lib/planRuntime';
import { resolvePatchTargets, SHARED_PLAN_ID } from '@/lib/patchTargets';
import { applySharedOps } from '@/lib/sharedBlocks';
import { appliedPatches } from '@/lib/appliedPatches';
import { useChatStore } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';
import { usePlanSync } from '@/store/usePlanSync';
import { useSharedCalendar } from '@/store/useSharedCalendar';
import type { PatchArtifact } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';

/** AI 调整确认：一次点击就直接落库（不经过预览/二次确认），日历随服务端结果刷新。 */
export function useApplyPatch() {
  const qc = useQueryClient();

  const layerStates = () => qc.getQueriesData<PlanState>({ queryKey: ['plan'] })
    .map(([, data]) => data)
    .filter((s): s is PlanState => !!s?.plan?.id);

  const mutation = useMutation({
    mutationFn: async (patch: PatchArtifact) => {
      const store = usePlanStore.getState();
      const activeId = store.state.plan.id;
      if (!activeId) throw new ApiError('plan_not_saved', 409, '当前计划尚未保存');

      const groups = resolvePatchTargets(patch.ops, store.state, layerStates(), useSharedCalendar.getState().busyBlocks);
      const activeOps = groups.find((g) => g.planId === activeId)?.ops ?? [];
      const foreign = groups.filter((g) => g.planId !== activeId && g.planId !== SHARED_PLAN_ID);
      const shared = groups.find((g) => g.planId === SHARED_PLAN_ID)?.ops ?? [];

      let resp: any = null;
      if (activeOps.length) {
        // result_hash 由本地引擎算：服务端重排后据此判断是否需要以服务端结果为准。
        const local = applyPatch(store.state, activeOps);
        let hashBlocks = local.state.blocks;
        if (local.requiresReschedule) {
          hashBlocks = solve({
            engine_version: ENGINE_VERSION,
            horizon_start: local.state.plan.horizon_start,
            horizon_days: local.state.plan.horizon_days,
            timezone: local.state.plan.timezone,
            task_defs: local.state.task_defs,
            constraints: mergeSharedWindows(local.state.constraints, useSharedCalendar.getState().windows),
            pinned_blocks: local.state.blocks.filter((b) => b.pinned || b.origin === 'manual'),
          }).blocks;
        }
        const body = await buildPatchBody({
          patch: { ...patch, ops: activeOps },
          blocks: hashBlocks,
          previewId: crypto.randomUUID(),
          planId: activeId,
          baseVersion: usePlanSync.getState().serverVersions[activeId] ?? store.state.plan.version,
        });
        resp = await api.applyPatch(body);
      }

      const foreignOps = foreign.reduce((n, g) => n + g.ops.length, 0) + shared.length;
      if (!resp && !foreign.length && !shared.length) throw new ApiError('patch_target_missing', 422, '这条调整没有可应用的内容，请刷新后重试');
      for (const group of foreign) {
        const layer = layerStates().find((s) => s.plan.id === group.planId);
        const optimistic = layer ? { blocks: applyPatch(layer, group.ops).state.blocks } : {};
        const r = await planController.apply({ planId: group.planId, ops: group.ops, label: `AI 编辑：${patch.summary.slice(0, 24)}`, optimistic });
        if (!r.ok) {
          throw new ApiError('service_unavailable', 503,
            resp ? `当前计划已保存，但其他计划未保存：${r.reason ?? '未知原因'}` : `其他计划未保存：${r.reason ?? '未知原因'}`);
        }
      }
      if (shared.length) {
        const r = await applySharedOps(shared);
        if (!r.ok) {
          throw new ApiError('service_unavailable', 503,
            resp ? `当前计划已保存，但公共日历未保存：${r.reason ?? '未知原因'}` : `公共日历未保存：${r.reason ?? '未知原因'}`);
        }
      }
      return { resp, foreignOps };
    },
    onError: (err) => {
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '提交失败，请重试');
      toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
    },
    onSuccess: ({ resp, foreignOps }: { resp: any; foreignOps: number }, patch: PatchArtifact) => {
      const store = usePlanStore.getState();
      appliedPatches.mark(useChatStore.getState().conversationId, patch);
      if (resp) {
        const next: PlanState = {
          plan: { ...store.state.plan, version: resp.version, updated_at: new Date().toISOString() },
          task_defs: resp.task_defs,
          constraints: resp.constraints,
          blocks: resp.blocks,
        };
        store.replaceStateKeepUndo(next);
        const planId = store.state.plan.id;
        if (planId) usePlanSync.getState().setServerVersion(planId, resp.version);
      }
      qc.invalidateQueries({ queryKey: ['plans'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      const suffix = foreignOps ? `（含其他计划/公共日历 ${foreignOps} 项）` : '';
      toast.success(resp?.server_authoritative ? `已按服务端结果保存调整${suffix}` : `调整已保存到云端${suffix}`);
      useChatStore.setState({ patch: null });
    },
  });
  return {
    apply: (patch: PatchArtifact) => mutation.mutate(patch),
    isPending: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
  };
}