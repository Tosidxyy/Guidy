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
        ...(b.recurrence_weekday !== undefined ? { recurrence_weekday: b.recurrence_weekday } : {}),
        ...(b.unavailable_date ? { unavailable_date: b.unavailable_date } : {}),
        // 撤销/重做要还原任务归属、移动保留语义与进度，不能只还原标题和时间。
        ...(b.task_key ? { task_key: b.task_key } : {}),
        ...(b.origin ? { origin: b.origin } : {}),
        ...(b.status ? { status: b.status } : {}),
        ...(b.completed_at != null ? { completed_at: b.completed_at } : {}),
        ...(b.actual_duration_min != null ? { actual_duration_min: b.actual_duration_min } : {}),
        ...(b.progress_updated_at != null ? { progress_updated_at: b.progress_updated_at } : {}),
      },
    } as unknown as ApplyOp);
  }
  return ops;
}