import { toast } from 'sonner';
import { applyPatch } from '@/shared/engine';
import { planController } from '@/lib/planRuntime';
import { pickUndoSource } from '@/lib/undoPriority';
import { usePlanStore } from '@/store/usePlanStore';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { ApplyOp, ConstraintPayload, TaskDef } from '@/shared/types';

export interface ActionResult {
  ok: boolean;
  planId: string | null;
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
  const planPatch: { horizon_start?: string; horizon_days?: 7 | 14 } = {};
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