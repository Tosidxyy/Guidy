import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { diffPlanCard, planFromArtifact } from '@/lib/planCard';
import { applyPatch, mergeConflictOps } from '@/shared/engine';
import { planController } from '@/lib/planRuntime';
import { queryClient } from '@/lib/queryClient';
import { pickUndoSource } from '@/lib/undoPriority';
import { usePlanStore } from '@/store/usePlanStore';
import { usePlanSync } from '@/store/usePlanSync';
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
    return redo ? planController.redo(planId) : planController.undo(planId);
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
export async function saveDraftAction(): Promise<{ ok: boolean; planId?: string; reason?: string }> {
  const store = usePlanStore.getState();
  const state = store.state;
  if (state.plan.id) return { ok: true, planId: state.plan.id };
  try {
    const resp = await api.saveDraft({
      plan_id: null,
      conversation_id: useChatStore.getState().conversationId,
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
    store.importState({ plan: resp.plan, task_defs: resp.task_defs, constraints: resp.constraints, blocks: resp.blocks });
    usePlanSync.getState().setServerVersion(resp.plan.id, resp.version);
    void queryClient.invalidateQueries({ queryKey: ['plans'] });
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    return { ok: true, planId: resp.plan.id };
  } catch (err) {
    return { ok: false, reason: err instanceof ApiError ? err.message : '保存失败，请重试' };
  }
}

function planStateOf(planId: string): PlanState | undefined {
  const active = usePlanStore.getState().state;
  if (active.plan.id === planId) return active;
  return queryClient.getQueryData<PlanState>(['plan', planId]);
}

/**
 * 合并两个计划的重叠块：先写非活动计划，再写活动计划。
 * 每侧一个 update_block（标题追加 + 并集窗口），各自进入该计划的撤销栈。
 */
export async function mergeConflictAction(conflict: PlanConflict): Promise<{ ok: boolean; reason?: string; planIds: string[] }> {
  const activeId = usePlanStore.getState().state.plan.id;
  const parts = mergeConflictOps(conflict).sort((p, q) => (p.planId === activeId ? 1 : 0) - (q.planId === activeId ? 1 : 0));
  const done: string[] = [];
  for (const part of parts) {
    const planState = planStateOf(part.planId);
    if (!planState) return { ok: false, reason: '计划数据未就绪，请刷新后重试', planIds: done };
    const optimistic = applyPatch(planState, part.ops).state;
    const r = await planController.apply({
      planId: part.planId,
      ops: part.ops,
      label: `合并「${conflict.merged_title}」`,
      optimistic: { blocks: optimistic.blocks },
    });
    if (!r.ok) {
      return {
        ok: false,
        reason: done.length ? `「${conflict.a.planTitle}」已合并，另一侧失败：${r.reason ?? '未知原因'}` : r.reason ?? '合并失败',
        planIds: done,
      };
    }
    done.push(part.planId);
  }
  return { ok: true, planIds: done };
}

/** 撤销一次跨计划合并：按合并顺序倒序撤销两侧的该条历史，逐个计划回报失败原因。 */
export async function undoMergedPlans(planIds: string[]): Promise<{ undone: number; failures: string[] }> {
  let undone = 0;
  const failures: string[] = [];
  for (const planId of [...planIds].reverse()) {
    const r = await planController.undoDetailed(planId);
    if (r.label) undone += 1;
    else if (r.reason) failures.push(r.reason);
  }
  return { undone, failures: Array.from(new Set(failures)) };
}

/** 应用「重新排程」预览：已保存计划走服务端 reschedule，未保存计划保持本地应用。 */
export async function applyRescheduleAction(): Promise<ActionResult> {
  const store = usePlanStore.getState();
  const preview = store.preview;
  if (!preview) return { ok: false, planId: null };
  const planId = store.state.plan.id;
  if (!planId) {
    store.applyPreview();
    return { ok: true, planId: null };
  }
  const ops: ApplyOp[] = [{ op: 'reschedule', scope: 'all', keep_pinned: true }];
  const planPatch: { horizon_start?: string; horizon_days?: 7 | 14 | 30 | 90 } = {};
  if (preview.horizon_start !== store.state.plan.horizon_start) planPatch.horizon_start = preview.horizon_start;
  if (preview.horizon_days !== store.state.plan.horizon_days) planPatch.horizon_days = preview.horizon_days;
  if (Object.keys(planPatch).length) ops.push({ op: 'update_plan', patch: planPatch });
  const r = await planController.apply({
    planId,
    ops,
    label: '重新排程',
    optimistic: {
      blocks: preview.output.blocks,
      plan: { ...store.state.plan, horizon_start: preview.horizon_start, horizon_days: preview.horizon_days },
    },
  });
  if (!r.ok) {
    toast.error(r.reason ?? '重新排程失败');
    return { ok: false, planId };
  }
  usePlanStore.setState({ preview: null, lastCompromises: preview.output.compromises });
  return { ok: true, planId };
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
  return r.ok ? { ok: true, planId } : { ok: false, planId, reason: r.reason };
}
