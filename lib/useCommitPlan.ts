import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildCommitInput } from '@/lib/commitInput';
import { solveArtifact } from '@/lib/preview';
import { relaxDraft } from '@/lib/relaxPlan';
import { usePlanStore } from '@/store/usePlanStore';
import { usePlanSync } from '@/store/usePlanSync';
import { useChatStore } from '@/store/useChatStore';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';

/** 方案卡确认：本地求一次排程算 hash，直接落库生成计划与时间块（不再需要单独的预览步骤）。 */
export function useCommitPlan(onSaved?: (planId: string) => void) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (draft: ConstraintSetArtifact) => {
      const store = usePlanStore.getState();
      const plan = { horizon_start: store.state.plan.horizon_start, timezone: store.state.plan.timezone };
      const { output } = solveArtifact(draft, plan, store.state.blocks);
      const body = await buildCommitInput({
        draft,
        plan,
        blocks: output.blocks,
        previewId: crypto.randomUUID(),
        planId: store.state.plan.id ?? null,
        conversationId: useChatStore.getState().conversationId,
      });
      return api.commit(body);
    },
    onError: (err, draft) => {
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '提交失败，请重试');
      if (e.code === 'engine_infeasible' && draft) {
        const store = usePlanStore.getState();
        const relaxed = relaxDraft(draft, { horizon_start: store.state.plan.horizon_start, timezone: store.state.plan.timezone }, store.state.blocks);
        if (relaxed) {
          toast.error('当前约束下排不下全部任务', {
            description: `可自动放宽：${relaxed.changes.join('；')}`,
            duration: 12000,
            action: { label: '自动放宽重试', onClick: () => mutation.mutate(relaxed.draft) },
          });
          return;
        }
      }
      toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
    },
    onSuccess: (serverPlan: any) => {
      const store = usePlanStore.getState();
      const next: PlanState = {
        plan: serverPlan.plan,
        task_defs: serverPlan.task_defs,
        constraints: serverPlan.constraints,
        blocks: serverPlan.blocks,
      };
      store.importState(next);
      usePlanSync.getState().setServerVersion(serverPlan.plan.id, serverPlan.plan.version);
      qc.invalidateQueries({ queryKey: ['plans'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      toast.success(serverPlan.server_authoritative ? '已按服务端结果保存计划' : '计划已保存到云端');
      onSaved?.(serverPlan.plan.id);
    },
  });
  return {
    commit: (draft: ConstraintSetArtifact) => mutation.mutate(draft),
    isPending: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
  };
}