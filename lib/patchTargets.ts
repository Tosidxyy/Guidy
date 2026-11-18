import type { PatchArtifact } from '@/shared/schemas';
import type { Block, PlanState } from '@/shared/types';

export interface PlanTarget {
  planId: string;
  ops: PatchArtifact['ops'];
}

/** 公共日历块的伪计划 id：它们不属于任何计划，写通道是 /api/calendar/blocks。 */
export const SHARED_PLAN_ID = '__shared__';

type Op = PatchArtifact['ops'][number];
type PlanRef = { kind: 'blockOrConstraint'; id: string } | { kind: 'plan'; planId: string } | null;

function planRef(op: Op): PlanRef {
  switch (op.op) {
    case 'move_block':
    case 'update_block':
    case 'remove_block':
    case 'update_constraint':
    case 'remove_constraint':
      return { kind: 'blockOrConstraint', id: op.id };
    // 新建块与改计划元数据没有可查的 id，用 op 自带的 plan_id 指路。
    case 'add_block':
    case 'update_plan':
      return op.plan_id ? { kind: 'plan', planId: op.plan_id } : null;
    default:
      return null;
  }
}

/**
 * AI 的 ops 不带计划：块 id 与约束 id 是 UUID，跨计划唯一，按 id 反查所属计划；
 * 公共日历块的 id 反查为伪计划；新建块与改计划元数据用 op.plan_id 指路；
 * 任务 key 只在计划内唯一，只落当前计划。
 */
export function resolvePatchTargets(
  ops: PatchArtifact['ops'],
  active: PlanState,
  layers: PlanState[],
  sharedBlocks: Pick<Block, 'id'>[] = [],
): PlanTarget[] {
  const activeId = active.plan.id;
  if (!activeId) return [];
  const owner = new Map<string, string>();
  for (const b of active.blocks) owner.set(b.id, activeId);
  for (const c of active.constraints) owner.set(c.id, activeId);
  for (const layer of layers) {
    if (!layer.plan.id || layer.plan.id === activeId) continue;
    for (const b of layer.blocks) if (!owner.has(b.id)) owner.set(b.id, layer.plan.id);
    for (const c of layer.constraints) if (!owner.has(c.id)) owner.set(c.id, layer.plan.id);
  }
  for (const b of sharedBlocks) if (!owner.has(b.id)) owner.set(b.id, SHARED_PLAN_ID);

  const groups = new Map<string, PlanTarget>();
  for (const op of ops) {
    const ref = planRef(op);
    const planId = ref?.kind === 'plan'
      ? ref.planId
      : (ref?.kind === 'blockOrConstraint' ? owner.get(ref.id) ?? activeId : activeId);
    const group = groups.get(planId) ?? { planId, ops: [] };
    group.ops.push(op);
    groups.set(planId, group);
  }
  return [...groups.values()];
}

/** 只会作用于当前计划的 ops；预览只应基于这些 ops 计算。 */
export function activeOpsOnly(
  ops: PatchArtifact['ops'],
  active: PlanState,
  layers: PlanState[],
  sharedBlocks: Pick<Block, 'id'>[] = [],
): PatchArtifact['ops'] {
  const activeId = active.plan.id;
  if (!activeId) return ops;
  return resolvePatchTargets(ops, active, layers, sharedBlocks).find((g) => g.planId === activeId)?.ops ?? [];
}

/** 当前计划里找不到目标（或显式指向其他计划）的 op 数量，用于确认卡片提示。 */
export function countExternalOps(ops: PatchArtifact['ops'], active: PlanState): number {
  const known = new Set<string>();
  for (const b of active.blocks) known.add(b.id);
  for (const c of active.constraints) known.add(c.id);
  const activeId = active.plan.id;
  return ops.filter((op) => {
    const ref = planRef(op);
    if (!ref) return false;
    if (ref.kind === 'plan') return ref.planId !== activeId;
    return !known.has(ref.id);
  }).length;
}