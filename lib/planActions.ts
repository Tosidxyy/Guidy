import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { diffPlanCard, planFromArtifact } from '@/lib/planCard';
import { applyPatch } from '@/shared/engine';
import { acceptPairs, pairKey, removePairs } from '@/lib/parallel';
import { planController } from '@/lib/planRuntime';
import { queryClient } from '@/lib/queryClient';
import { pickUndoSource } from '@/lib/undoPriority';
import { usePlanStore } from '@/store/usePlanStore';
import { useChatStore } from '@/store/useChatStore';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { ApplyOp, ConstraintPayload, PlanState, TaskDef } from '@/shared/types';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { PlanConflict } from '@/shared/engine';

export interface ActionResult {
  ok: boolean;
  planId: string | null;
  reason?: string;
}

type LocalFallback = (store: ReturnType<typeof usePlanStore.getState>) => void;

async function runOps(ops: ApplyOp[], label: string, local: LocalFallback): Promise<ActionResult> {
  const store = usePlanStore.getState();
  const planId = store.state.plan.id;
  if (!planId) {
    local(store);
    return { ok: true, planId: null };
  }
  const next = applyPatch(store.state, ops).state;
  const r = await planController.apply({
    planId,
    ops,
    label,
    optimistic: { plan: next.plan, task_defs: next.task_defs, constraints: next.constraints, blocks: next.blocks },
  });
  if (!r.ok) {
    toast.error(r.reason ?? '保存失败');
    return { ok: false, planId };
  }
  return { ok: true, planId };
}

export function undoToastAction(planId: string | null) {
  if (!planId) return { label: '撤销', onClick: () => { usePlanStore.getState().undo(); } };
  return {
    label: '撤销',
    onClick: () => {
      void planController.undo(planId).then((label) => { if (label) toast.success(`已撤销：${label}`); });
    },
  };
}

/** 活动计划下一次撤销/重做的来源与文案：服务端历史与本地元数据取较新者。 */
export function peekUndo(redo = false): { label: string | null; source: 'block' | 'local' | null } {
  const store = usePlanStore.getState();
  const planId = store.state.plan.id;
  const batch = planId ? useBlockHistory.getState()[redo ? 'redo' : 'entries'][planId] : undefined;
  const blockEntry = batch?.at(-1);
  const localEntry = (redo ? store.redoStack : store.undoStack).at(-1);
  const source = pickUndoSource(blockEntry?.at, localEntry?.at);
  return { label: source === 'block' ? blockEntry?.label ?? null : localEntry?.label ?? null, source };
}

export async function undoActivePlan(redo = false): Promise<string | null> {
  const store = usePlanStore.getState();
  const planId = store.state.plan.id;
  if (peekUndo(redo).source === 'block' && planId) {
    const r = redo ? await planController.redoDetailed(planId) : await planController.undoDetailed(planId);
    // 撤销失败必须给出原因，不能静默无反应。
    if (!r.label && r.reason) toast.error(`无法${redo ? '重做' : '撤销'}：${r.reason}`);
    return r.label;
  }
  return redo ? store.redo() : store.undo();
}

export function addTaskDefAction(task: TaskDef) {
  return runOps([{ op: 'add_task_def', value: task }], `新增任务「${task.title}」`, (s) => s.addTaskDef(task));
}

export function deleteTaskDefAction(key: string, title: string) {
  return runOps([{ op: 'remove_task_def', key }], `删除任务「${title}」`, (s) => s.deleteTaskDef(key));
}

export function addConstraintAction(payload: ConstraintPayload) {
  const clientId = crypto.randomUUID();
  return runOps(
    [{ op: 'add_constraint', client_id: clientId, value: payload, source: 'user', enabled: true }],
    '新增约束',
    (s) => s.addConstraint(payload),
  );
}

export function updateConstraintAction(id: string, patch: { payload?: ConstraintPayload; enabled?: boolean }) {
  return runOps([{ op: 'update_constraint', id, patch }], '修改约束', (s) => s.updateConstraint(id, patch));
}

export function deleteConstraintAction(id: string) {
  return runOps([{ op: 'remove_constraint', id }], '删除约束', (s) => s.deleteConstraint(id));
}

export function renamePlanAction(title: string) {
  const next = title.slice(0, 60);
  return runOps([{ op: 'update_plan', patch: { title: next } }], '重命名计划', (s) => s.renamePlan(next));
}

/** 保存尚未落库的草稿：整份快照提交，不跑求解，保留手放块与备注。 */
const draftSaveInFlight: { current: Promise<{ ok: boolean; planId?: string; reason?: string }> | null; revision: number } = { current: null, revision: -1 };

export function saveDraftAction(): Promise<{ ok: boolean; planId?: string; reason?: string }> {
  // 自动保存与「应用调整/保存卡片」可能同时触发：并发调用共享同一次保存，
  // 否则 plan_id=null 的两次请求会在云端各建一个草稿计划，后续提交必然版本冲突。
  if (draftSaveInFlight.current) {
    if (draftSaveInFlight.revision === usePlanStore.getState().selectionRevision) return draftSaveInFlight.current;
    return draftSaveInFlight.current.then(() => saveDraftAction());
  }
  draftSaveInFlight.revision = usePlanStore.getState().selectionRevision;
  const run = doSaveDraftAction().finally(() => { draftSaveInFlight.current = null; });
  draftSaveInFlight.current = run;
  return run;
}

export async function flushDraftSave(): Promise<void> {
  while (draftSaveInFlight.current) await draftSaveInFlight.current;
}

async function doSaveDraftAction(): Promise<{ ok: boolean; planId?: string; reason?: string }> {
  const store = usePlanStore.getState();
  if (store.state.plan.id) return { ok: true, planId: store.state.plan.id };
  const revision = store.selectionRevision;
  const conversationId = useChatStore.getState().conversationId;
  let savedId: string | null = null;
  try {
    while (usePlanStore.getState().selectionRevision === revision) {
      await store.flush();
      if (usePlanStore.getState().selectionRevision !== revision) break;
      const state = usePlanStore.getState().state;
      const resp = await api.saveDraft({
        plan_id: savedId,
        conversation_id: conversationId,
        input: {
          title: state.plan.title,
          horizon_start: state.plan.horizon_start,
          horizon_days: state.plan.horizon_days,
          timezone: state.plan.timezone,
          task_defs: state.task_defs,
          constraints: state.constraints,
          blocks: state.blocks,
        },
      });
      savedId = resp.plan.id;
      void queryClient.invalidateQueries({ queryKey: ['plans'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
      const current = usePlanStore.getState();
      if (current.selectionRevision !== revision) break;
      // An edit during the write must be saved to the same new ID before adopting it.
      if (current.state !== state) continue;
      store.importState({ plan: resp.plan, task_defs: resp.task_defs, constraints: resp.constraints, blocks: resp.blocks }, true);
      await store.flush();
      return { ok: true, planId: resp.plan.id };
    }
    return { ok: false, reason: '当前计划已切换，未替换新的草稿' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : '保存失败，请重试' };
  }
}

/**
 * 合并两个计划的重叠块 = 接受并行：只登记并行对，显示层合成一张「A + B」卡。
 * 不改任何一侧的时间/标题/钉住：并集窗口会把短任务拉成超长块，且两计划同块并列像重复任务。
 */
export async function mergeConflictAction(conflict: PlanConflict): Promise<{ ok: boolean; reason?: string; pairKeys: string[] }> {
  const key = pairKey(conflict.a.block.id, conflict.b.block.id);
  acceptPairs([key]);
  return { ok: true, pairKeys: [key] };
}

/** 撤销合并 = 移除并行对登记：显示层回到重叠并列，冲突条重新提示；不涉及计划数据，必然可撤。 */
export async function undoMergedPlans(pairKeys: string[]): Promise<{ undone: number; failures: string[] }> {
  return { undone: removePairs(pairKeys), failures: [] };
}

/**
 * 方案卡保存：草稿整份落库；已保存计划用 diff 生成 ops，走同一 patch 通道（可撤销）。
 */
export async function savePlanCardAction(draft: ConstraintSetArtifact): Promise<ActionResult> {
  const store = usePlanStore.getState();
  const state = store.state;
  if (!state.plan.id) {
    store.importState(planFromArtifact(state, draft));
    const r = await saveDraftAction();
    return { ok: r.ok, planId: r.planId ?? null, reason: r.reason };
  }
  const ops = diffPlanCard(state, draft);
  if (!ops.length) return { ok: true, planId: state.plan.id };
  const optimistic = applyPatch(state, ops).state;
  const r = await planController.apply({
    planId: state.plan.id,
    ops,
    label: '保存方案卡修改',
    optimistic: { plan: optimistic.plan, task_defs: optimistic.task_defs, constraints: optimistic.constraints, blocks: optimistic.blocks },
  });
  return { ok: r.ok, planId: state.plan.id, reason: r.reason };
}

/** 方案卡里的「生成排程」：任务与约束先在计划里，用户按需产出时间块。 */
export async function generateScheduleAction(): Promise<ActionResult> {
  const store = usePlanStore.getState();
  if (!store.state.plan.id) {
    const saved = await saveDraftAction();
    if (!saved.ok) return { ok: false, planId: null, reason: saved.reason };
  }
  const current = usePlanStore.getState().state;
  const planId = current.plan.id;
  if (!planId) return { ok: false, planId: null, reason: '计划尚未保存' };
  const r = await planController.apply({
    planId,
    ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }],
    label: '生成排程',
    optimistic: {},
  });
  const warnings: string[] = Array.isArray(r.resp?.warnings) ? r.resp.warnings : [];
  if (warnings.length) toast.info(warnings[0], { duration: 8000 });
  return r.ok ? { ok: true, planId } : { ok: false, planId, reason: r.reason };
}
