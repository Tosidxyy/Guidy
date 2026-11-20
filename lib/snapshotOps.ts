import type { ApplyOp, PlanState } from '@/shared/types';

/** 把一个计划的完整内容表达成可逆的 patch 操作序列（用于 AI 提交后的撤销/重做）。 */
export function snapshotOps(state: PlanState): ApplyOp[] {
  const ops: ApplyOp[] = [{ op: 'clear_plan' } as ApplyOp];
  for (const t of state.task_defs) ops.push({ op: 'add_task_def', value: t } as unknown as ApplyOp);
  for (const c of state.constraints) {
    ops.push({ op: 'add_constraint', client_id: c.id, value: c.payload, source: c.source, enabled: c.enabled } as unknown as ApplyOp);
  }
  for (const b of state.blocks) {
    ops.push({
      op: 'add_block',
      client_id: b.id,
      value: {
        title: b.title,
        category: b.category,
        start_utc: b.start_utc,
        end_utc: b.end_utc,
        priority: b.priority,
        pinned: b.pinned,
        ...(b.notes ? { notes: b.notes } : {}),
      },
    } as unknown as ApplyOp);
  }
  return ops;
}