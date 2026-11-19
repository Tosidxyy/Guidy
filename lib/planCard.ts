import type { ApplyOp, Constraint, PlanState, TaskDef } from '@/shared/types';
import type { ConstraintSetArtifact, PatchArtifact } from '@/shared/schemas';
import { applyPatch } from '@/shared/engine';
import { canonical } from '@/lib/restoreChat';

/** 从当前计划生成方案卡内容（任务/约束/horizon 都复用同一套卡片编辑）。 */
export function artifactFromPlan(state: PlanState): ConstraintSetArtifact {
  return {
    type: 'constraint_set',
    plan_title: state.plan.title,
    horizon_start: state.plan.horizon_start,
    horizon_days: state.plan.horizon_days,
    task_defs: state.task_defs.map((t) => ({ ...t })),
    constraints: state.constraints.map((c) => c.payload),
    clarifications_needed: [],
  };
}

/**
 * 把方案卡的编辑结果写回计划：payload 未变的约束沿用原 id/source/enabled，
 * 新增的给临时 id（保存时服务端会重发），删除的自然消失。
 */
export function planFromArtifact(state: PlanState, draft: ConstraintSetArtifact): PlanState {
  const unused = [...state.constraints];
  const constraints: Constraint[] = draft.constraints.map((payload, i) => {
    const key = canonical(payload);
    const idx = unused.findIndex((c) => canonical(c.payload) === key);
    if (idx >= 0) {
      const [match] = unused.splice(idx, 1);
      return { ...match, payload };
    }
    return { id: `draft-c-${i}`, payload, source: 'user', enabled: true };
  });
  return {
    ...state,
    plan: {
      ...state.plan,
      title: draft.plan_title.trim() ? draft.plan_title.slice(0, 60) : state.plan.title,
      horizon_start: draft.horizon_start ?? state.plan.horizon_start,
      horizon_days: draft.horizon_days,
    },
    task_defs: draft.task_defs,
    constraints,
  };
}
const TASK_FIELDS: (keyof TaskDef)[] = ['title', 'category', 'duration_min', 'frequency', 'priority', 'splittable', 'preferred_period', 'sort_order', 'notes'];

/**
 * 已保存计划的方案卡改动 → 服务端 ops。
 * 约束先按 payload 精确配对（未改动的跳过），剩余按顺序配对视为「就地编辑」，
 * 多出的旧约束删除、多出的新约束新增；任务按 key 对齐。
 */
export function diffPlanCard(current: PlanState, draft: ConstraintSetArtifact): ApplyOp[] {
  const ops: ApplyOp[] = [];

  const planPatch: { title?: string; horizon_start?: string; horizon_days?: number } = {};
  const title = draft.plan_title.trim().slice(0, 60);
  if (title && title !== current.plan.title) planPatch.title = title;
  if (draft.horizon_start && draft.horizon_start !== current.plan.horizon_start) planPatch.horizon_start = draft.horizon_start;
  if (draft.horizon_days !== current.plan.horizon_days) planPatch.horizon_days = draft.horizon_days;
  if (Object.keys(planPatch).length) ops.push({ op: 'update_plan', patch: planPatch });

  const currentTasks = new Map(current.task_defs.map((t) => [t.key, t]));
  const draftKeys = new Set(draft.task_defs.map((t) => t.key));
  for (const task of draft.task_defs) {
    const old = currentTasks.get(task.key);
    if (!old) { ops.push({ op: 'add_task_def', value: task }); continue; }
    const patch: Partial<TaskDef> = {};
    for (const field of TASK_FIELDS) {
      if (canonical((old as any)[field] ?? null) !== canonical((task as any)[field] ?? null)) (patch as any)[field] = (task as any)[field];
    }
    if (Object.keys(patch).length) ops.push({ op: 'update_task_def', key: task.key, patch });
  }
  for (const task of current.task_defs) if (!draftKeys.has(task.key)) ops.push({ op: 'remove_task_def', key: task.key });

  const oldLeft = [...current.constraints];
  const newLeft: number[] = [];
  draft.constraints.forEach((payload, i) => {
    const idx = oldLeft.findIndex((c) => canonical(c.payload) === canonical(payload));
    if (idx >= 0) oldLeft.splice(idx, 1);
    else newLeft.push(i);
  });
  const pairs = Math.min(oldLeft.length, newLeft.length);
  for (let k = 0; k < pairs; k++) {
    const matched = oldLeft.shift()!;
    ops.push({ op: 'update_constraint', id: matched.id, patch: { payload: draft.constraints[newLeft[k]] } });
  }
  for (const c of oldLeft) ops.push({ op: 'remove_constraint', id: c.id });
  for (let k = pairs; k < newLeft.length; k++) {
    ops.push({ op: 'add_constraint', value: draft.constraints[newLeft[k]], source: 'user', enabled: true });
  }
  return ops;
}

/** 有任务、但还没有任何时间块：方案卡提供「生成排程」。 */
export function canGenerateSchedule(state: PlanState): boolean {
  return state.task_defs.length > 0 && state.blocks.length === 0;
}

const PLAN_CARD_OPS = new Set(['add_task_def', 'update_task_def', 'remove_task_def', 'add_constraint', 'update_constraint', 'remove_constraint', 'update_plan']);

/** fitting patch 暂存到卡片：叠加在用户未保存的编辑草稿上，避免服务端旧状态复活已删任务。 */
export function stagePatchOnDraft(current: PlanState, draft: ConstraintSetArtifact | null, patch: PatchArtifact): ConstraintSetArtifact {
  const base = draft ? planFromArtifact(current, draft) : current;
  return artifactFromPlan(applyPatch(base, patch.ops).state);
}

/** 只改任务/约束/计划元数据的 patch 交给方案卡；含块操作或重排的仍走聊天里的确认（需要绝对时间）。 */
export function patchFitsPlanCard(patch: PatchArtifact, activePlanId: string): boolean {
  if (!patch.ops.length) return false;
  return patch.ops.every((op) => {
    if (!PLAN_CARD_OPS.has(op.op)) return false;
    if (op.op === 'update_plan' && op.plan_id && op.plan_id !== activePlanId) return false;
    return true;
  });
}
