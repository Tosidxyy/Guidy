import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildCommitInput } from '@/lib/commitInput';
import { stableHash, stableJson } from '@/lib/stableKey';
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
      // 稳定幂等键：同一计划同一版本同一输入重复提交（含网络重试）不会创建重复事件。
      const idempotencyKey = stableHash(stableJson({
        v: 1,
        plan: store.state.plan.id ?? 'new',
        version: store.state.plan.version ?? 0,
        start: draft.horizon_start ?? plan.horizon_start,
        days: draft.horizon_days,
        tasks: draft.task_defs,
        constraints: draft.constraints,
      }));
      const body = await buildCommitInput({
        draft,
        plan,
        blocks: output.blocks,
        previewId: crypto.randomUUID(),
        planId: store.state.plan.id ?? null,
        conversationId: useChatStore.getState().conversationId,
        idempotencyKey,
      });
      return api.commit(body);
    },
    onError: (err, draft) => {
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '提交失败，请重试');
      const details = e.details as any;
      const lines: string[] = [];
      if (details?.feasibility) lines.push(`可行性：${details.feasibility}`);
      for (const u of (details?.unplaced ?? []).slice(0, 4)) lines.push(`「${u.title}」目标 ${u.target_minutes} 分钟，只排了 ${u.placed_minutes}，缺 ${u.missing_minutes}${u.reason ? `：${u.reason}` : ''}`);
      for (const v of (details?.violations ?? []).slice(0, 4)) lines.push(v.reason);
      if (e.code === 'write_verification_failed') lines.push('服务端写入校验失败，本次未生效，原有日程保持不变');
      if (lines.length) {
        toast.error(e.message, { description: lines.join(String.fromCharCode(10)), duration: 12000 });
        return;
      }
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