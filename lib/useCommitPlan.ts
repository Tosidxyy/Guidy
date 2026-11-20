import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildCommitInput } from '@/lib/commitInput';
import { stableHash, stableJson } from '@/lib/stableKey';
import { solveArtifact } from '@/lib/preview';
import { trimArtifactToFit } from '@/shared/engine/fit';
import { relaxDraft } from '@/lib/relaxPlan';
import { usePlanStore } from '@/store/usePlanStore';
import { localLearnProfile } from '@/lib/local/domain';
import { usePlanSync } from '@/store/usePlanSync';
import { useChatStore } from '@/store/useChatStore';
import { useBlockHistory } from '@/store/useBlockHistory';
import { snapshotOps } from '@/lib/snapshotOps';
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
      const before = store.state;
      const resp = await api.commit(body);
      return { resp, before };
    },
    onError: (err, draft) => {
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '提交失败，请重试');
      const details = e.details as any;
      // 排不下时优先给「自动放宽重试」，不能被缺口详情短路。
      if (e.code === 'engine_infeasible' && draft) {
        const store = usePlanStore.getState();
        const meta = { horizon_start: store.state.plan.horizon_start, timezone: store.state.plan.timezone };
        const blocks = store.state.blocks;
        const relaxed = relaxDraft(draft, meta, blocks);
        const trimmed = trimArtifactToFit(draft, meta, blocks);
        const relaxedTrimmed = relaxed ? trimArtifactToFit(relaxed.draft, meta, blocks) : null;
        const candidates: { draft: ConstraintSetArtifact; changes: string[] }[] = [];
        if (relaxed) candidates.push({ draft: relaxed.draft, changes: relaxed.changes });
        if (trimmed) candidates.push({ draft: trimmed.draft, changes: trimmed.changes });
        if (relaxed && relaxedTrimmed) candidates.push({ draft: relaxedTrimmed.draft, changes: [...relaxed.changes, ...relaxedTrimmed.changes] });
        const fit = candidates.find((c) => solveArtifact(c.draft, meta, blocks).output.violations.length === 0) ?? candidates[0];
        const gap: string[] = [];
        for (const u of (details?.unplaced ?? []).slice(0, 3)) gap.push(`「${u.title}」缺 ${u.missing_minutes} 分钟`);
        if (fit) {
          toast.error('当前约束下排不下全部任务', {
            description: [`可自动放宽：${Array.from(new Set(fit.changes)).join('；')}`, ...gap].join(String.fromCharCode(10)),
            duration: 12000,
            action: { label: '自动放宽重试', onClick: () => mutation.mutate(fit.draft) },
          });
          return;
        }
      }
      const lines: string[] = [];
      if (details?.feasibility) lines.push(`可行性：${details.feasibility}`);
      for (const u of (details?.unplaced ?? []).slice(0, 4)) lines.push(`「${u.title}」目标 ${u.target_minutes} 分钟，只排了 ${u.placed_minutes}，缺 ${u.missing_minutes}${u.reason ? `：${u.reason}` : ''}`);
      for (const v of (details?.violations ?? []).slice(0, 4)) lines.push(v.reason);
      if (e.code === 'write_verification_failed') lines.push('服务端写入校验失败，本次未生效，原有日程保持不变');
      if (lines.length) {
        toast.error(e.message, { description: lines.join(String.fromCharCode(10)), duration: 12000 });
        return;
      }
      toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
    },
    onSuccess: ({ resp: serverPlan, before }: any) => {
      const store = usePlanStore.getState();
      const next: PlanState = {
        plan: serverPlan.plan,
        task_defs: serverPlan.task_defs,
        constraints: serverPlan.constraints,
        blocks: serverPlan.blocks,
      };
      store.importState(next);
      usePlanSync.getState().setServerVersion(serverPlan.plan.id, serverPlan.plan.version);
      // 确认生成同样可撤销：撤销=恢复提交前的任务/约束/块，重做=再次应用这次结果。
      useBlockHistory.getState().push(serverPlan.plan.id, {
        at: Date.now(),
        label: `确认生成：${serverPlan.plan.title}`.slice(0, 40),
        forwardOps: snapshotOps(next),
        inverseOps: snapshotOps(before),
      });
      qc.invalidateQueries({ queryKey: ['plans'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      // 有新计划生成/调整后自动更新习惯画像（只用过去的块）。
      void localLearnProfile().then(() => qc.invalidateQueries({ queryKey: ['profile'] })).catch(() => null);
      toast.success(serverPlan.server_authoritative ? '已按最新结果保存计划' : '计划已保存到本机');
      if (Array.isArray(serverPlan.warnings) && serverPlan.warnings.length) toast.info(serverPlan.warnings[0], { duration: 8000 });
      onSaved?.(serverPlan.plan.id);
    },
  });
  return {
    commit: (draft: ConstraintSetArtifact) => mutation.mutate(draft),
    isPending: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
  };
}