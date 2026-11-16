import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildCommitInput } from '@/lib/commitInput';
import { usePlanStore, type ReschedulePreview } from '@/store/usePlanStore';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';

export function useCommitPlan() {
  // onMutate clears store.preview via applyPreview before mutationFn runs, so
  // the preview being committed must be captured there and handed over here.
  const pendingPreview = useRef<ReschedulePreview | null>(null);
  const mutation = useMutation({
    mutationFn: async (draft: ConstraintSetArtifact) => {
      const store = usePlanStore.getState();
      const preview = pendingPreview.current;
      if (!preview) throw new ApiError('validation_failed', 422, '请先生成预览');
      const body = await buildCommitInput({
        draft,
        plan: { horizon_start: store.state.plan.horizon_start, timezone: store.state.plan.timezone },
        blocks: preview.output.blocks,
        previewId: crypto.randomUUID(),
        planId: store.state.plan.id ?? null,
      });
      return api.commit(body);
    },
    onMutate: async () => {
      const store = usePlanStore.getState();
      const snapshot = JSON.parse(JSON.stringify(store.state)) as PlanState;
      const hadPreview = store.preview;
      pendingPreview.current = hadPreview;
      store.applyPreview();
      return { snapshot, hadPreview };
    },
    onError: (err, _draft, ctx) => {
      const store = usePlanStore.getState();
      pendingPreview.current = null;
      if (ctx?.snapshot) store.importState(ctx.snapshot);
      if (ctx?.hadPreview) usePlanStore.setState({ preview: ctx.hadPreview });
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '提交失败，请重试');
      toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
    },
    onSuccess: (serverPlan: any) => {
      const store = usePlanStore.getState();
      pendingPreview.current = null;
      const next: PlanState = {
        plan: serverPlan.plan,
        task_defs: serverPlan.task_defs,
        constraints: serverPlan.constraints,
        blocks: serverPlan.blocks,
      };
      store.importState(next);
      usePlanStore.setState({ preview: null });
      toast.success(serverPlan.server_authoritative ? '已按服务端结果保存计划' : '计划已保存到云端');
    },
  });
  return {
    commit: (draft: ConstraintSetArtifact) => mutation.mutate(draft),
    isPending: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
  };
}