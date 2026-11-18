import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildPatchBody } from '@/lib/patchInput';
import { applyPatch } from '@/shared/engine';
import { planController } from '@/lib/planRuntime';
import { resolvePatchTargets } from '@/lib/patchTargets';
import { usePlanStore, type ReschedulePreview } from '@/store/usePlanStore';
import { usePlanSync } from '@/store/usePlanSync';
import type { PatchArtifact } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';

export function useApplyPatch() {
  const qc = useQueryClient();
  // onMutate clears store.preview via applyPreview before mutationFn runs, so
  // the preview being committed must be captured there and handed over here.
  const pendingPreview = useRef<ReschedulePreview | null>(null);
  const pendingBase = useRef<number>(0);

  const layerStates = () => qc.getQueriesData<PlanState>({ queryKey: ['plan'] })
    .map(([, data]) => data)
    .filter((s): s is PlanState => !!s?.plan?.id);

  const mutation = useMutation({
    mutationFn: async (patch: PatchArtifact) => {
      const store = usePlanStore.getState();
      const preview = pendingPreview.current;
      if (!preview) throw new ApiError('validation_failed', 422, '请先生成预览');
      const activeId = store.state.plan.id;
      if (!activeId) throw new ApiError('plan_not_saved', 409, '当前计划尚未保存');

      const groups = resolvePatchTargets(patch.ops, store.state, layerStates());
      const activeOps = groups.find((g) => g.planId === activeId)?.ops ?? [];
      const foreign = groups.filter((g) => g.planId !== activeId);

      let resp: any = null;
      if (activeOps.length) {
        const body = await buildPatchBody({
          patch: { ...patch, ops: activeOps },
          blocks: preview.output.blocks,
          previewId: crypto.randomUUID(),
          planId: activeId,
          baseVersion: pendingBase.current,
        });
        resp = await api.applyPatch(body);
      }

      const foreignOps = foreign.reduce((n, g) => n + g.ops.length, 0);
      for (const group of foreign) {
        const layer = layerStates().find((s) => s.plan.id === group.planId);
        const optimistic = layer ? { blocks: applyPatch(layer, group.ops).state.blocks } : {};
        const r = await planController.apply({ planId: group.planId, ops: group.ops, label: `AI 编辑：${patch.summary.slice(0, 24)}`, optimistic });
        if (!r.ok) {
          throw new ApiError('service_unavailable', 503,
            resp ? `当前计划已保存，但其他计划未保存：${r.reason ?? '未知原因'}` : `其他计划未保存：${r.reason ?? '未知原因'}`);
        }
      }
      return { resp, foreignOps, foreignPlans: foreign.length };
    },
    onMutate: async () => {
      const store = usePlanStore.getState();
      const snapshot = JSON.parse(JSON.stringify(store.state)) as PlanState;
      const hadPreview = store.preview;
      pendingPreview.current = hadPreview;
      const activeId = store.state.plan.id;
      pendingBase.current = (activeId ? usePlanSync.getState().serverVersions[activeId] : undefined) ?? store.state.plan.version;
      store.applyPreview();
      return { snapshot, hadPreview };
    },
    onError: (err, _patch, ctx) => {
      const store = usePlanStore.getState();
      pendingPreview.current = null;
      if (ctx?.snapshot) store.importState(ctx.snapshot);
      if (ctx?.hadPreview) usePlanStore.setState({ preview: ctx.hadPreview });
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '提交失败，请重试');
      toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
    },
    onSuccess: ({ resp, foreignOps }: { resp: any; foreignOps: number }) => {
      const store = usePlanStore.getState();
      pendingPreview.current = null;
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
      const suffix = foreignOps ? `（含其他计划 ${foreignOps} 项）` : '';
      toast.success(resp?.server_authoritative ? `已按服务端结果保存调整${suffix}` : `调整已保存到云端${suffix}`);
    },
  });
  return {
    apply: (patch: PatchArtifact) => mutation.mutate(patch),
    isPending: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
  };
}