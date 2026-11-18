import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Constraint, PlanState } from '@/shared/types';
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