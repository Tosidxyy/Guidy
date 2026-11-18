import type { PatchArtifact } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';

export interface PlanTarget {
  planId: string;
  ops: PatchArtifact['ops'];
}

type Op = PatchArtifact['ops'][number];

function opTargetId(op: Op): string | null {
  switch (op.op) {
    case 'move_block':
    case 'update_block':
    case 'remove_block':
    case 'update_constraint':
    case 'remove_constraint':
      return op.id;
    default:
      return null;
  }
}

/**
 * AI 的 ops 只带 id，不带计划。块 id 与约束 id 是 UUID，跨计划唯一；
 * 任务 key 只在计划内唯一，因此只有带 id 的 op 参与跨计划寻址；未知 id 落回当前计划。
 */
export function resolvePatchTargets(ops: PatchArtifact['ops'], active: PlanState, layers: PlanState[]): PlanTarget[] {
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

  const groups = new Map<string, PlanTarget>();
  for (const op of ops) {
    const id = opTargetId(op);
    const planId = (id && owner.get(id)) || activeId;
    const group = groups.get(planId) ?? { planId, ops: [] };
    group.ops.push(op);
    groups.set(planId, group);
  }
  return [...groups.values()];
}

/** 当前计划里找不到 id 的 op 数量，用于确认卡片提示。 */
export function countExternalOps(ops: PatchArtifact['ops'], active: PlanState): number {
  const known = new Set<string>();
  for (const b of active.blocks) known.add(b.id);
  for (const c of active.constraints) known.add(c.id);
  return ops.filter((op) => {
    const id = opTargetId(op);
    return id !== null && !known.has(id);
  }).length;
}