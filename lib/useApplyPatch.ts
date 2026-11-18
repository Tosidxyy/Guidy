import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildPatchBody } from '@/lib/patchInput';
import { usePlanStore, type ReschedulePreview } from '@/store/usePlanStore';
import { usePlanSync } from '@/store/usePlanSync';
import type { PatchArtifact } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';

export function useApplyPatch() {
  const qc = useQueryClient();
  const pendingPreview = useRef<ReschedulePreview | null>(null);
  const pendingBase = useRef<number>(0);
  const mutation = useMutation({
    mutationFn: async (patch: PatchArtifact) => {
      const store = usePlanStore.getState();
      const preview = pendingPreview.current;
      if (!preview) throw new ApiError('validation_failed', 422, '请先生成预览');
      const body = await buildPatchBody({
        patch,
        blocks: preview.output.blocks,
        previewId: crypto.randomUUID(),
        planId: store.state.plan.id ?? null,
        baseVersion: pendingBase.current,
      });
      return api.applyPatch(body);
    },
    onMutate: async () => {
      const store = usePlanStore.getState();
      const snapshot = JSON.parse(JSON.stringify(store.state)) as PlanState;
      const hadPreview = store.preview;
      pendingPreview.current = hadPreview;
      pendingBase.current = store.state.plan.version;
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
    onSuccess: (resp: any) => {
      const store = usePlanStore.getState();
      pendingPreview.current = null;
      const next: PlanState = {
        plan: { ...store.state.plan, version: resp.version, updated_at: new Date().toISOString() },
        task_defs: resp.task_defs,
        constraints: resp.constraints,
        blocks: resp.blocks,
      };
      store.replaceStateKeepUndo(next);
      const planId = store.state.plan.id;
      if (planId) usePlanSync.getState().setServerVersion(planId, resp.version);
      qc.invalidateQueries({ queryKey: ['plans'] });
      toast.success(resp.server_authoritative ? '已按服务端结果保存调整' : '调整已保存到云端');
    },
  });
  return {
    apply: (patch: PatchArtifact) => mutation.mutate(patch),
    isPending: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
  };
}