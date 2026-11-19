import type { Block, TaskDef } from '../types.ts';

export interface TaskProgress {
  key: string;
  title: string;
  /** 计划工作量（目标 = 频次 × 单次时长）。 */
  target_minutes: number;
  /** 已排进日历的计划时长（Σ 该任务所有块的计划时长）。 */
  scheduled_minutes: number;
  /** 用户上报的实际完成分钟（唯一可信的“实际”数据）。 */
  actual_done_minutes: number;
  /** completed 但未上报实际耗时时，按计划块时长推断的完成量（不是实际耗时）。 */
  inferred_done_minutes: number;
  /** 完成量 = actual + inferred；剩余 = max(0, target − 完成量)。 */
  done_minutes: number;
  remaining_minutes: number;
  /** 是否收到过任何实际时长上报。 */
  actual_known: boolean;
  completion: 'not_started' | 'in_progress' | 'partial' | 'completed';
  last_completed_at: string | null;
}

function targetCount(t: TaskDef, horizonDays: number): number {
  if (t.frequency.type === 'once') return 1;
  if (t.frequency.type === 'daily') return horizonDays;
  let n = 0;
  for (let i = 0; i < horizonDays; i += 7) {
    const len = Math.min(7, horizonDays - i);
    n += len === 7 ? t.frequency.count : Math.max(1, Math.round((t.frequency.count * len) / 7));
  }
  return n;
}

const minutesOf = (b: Block) => Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000);

/**
 * 任务级进度 = 汇总该任务所有时间块。字段语义严格区分：
 * - scheduled_minutes：计划（排程）时长，不代表已执行；
 * - actual_done_minutes：仅用户/系统上报的实际分钟；
 * - inferred_done_minutes：completed 且未上报时按计划时长推断的完成量（不得当作实际耗时）。
 * cancelled / skipped 不计入完成量。
 */
export function taskProgress(task_defs: TaskDef[], blocks: Block[], horizonDays: number): TaskProgress[] {
  return task_defs.map((t) => {
    const target = targetCount(t, horizonDays) * t.duration_min;
    let scheduled = 0;
    let actual = 0;
    let inferred = 0;
    let sawInProgress = false;
    let sawPartial = false;
    let lastCompletedAt: string | null = null;
    for (const b of blocks) {
      if (b.task_key !== t.key) continue;
      const slot = minutesOf(b);
      const status = b.status ?? 'planned';
      if (status !== 'cancelled' && status !== 'skipped') scheduled += slot;
      if (status === 'completed') {
        if (b.actual_duration_min != null) actual += Number(b.actual_duration_min);
        else inferred += slot;
        if (b.completed_at && (!lastCompletedAt || b.completed_at > lastCompletedAt)) lastCompletedAt = b.completed_at;
      } else if (status === 'in_progress') {
        if (b.actual_duration_min != null) actual += Number(b.actual_duration_min);
        sawInProgress = true;
      } else if (status === 'partial') {
        if (b.actual_duration_min != null) actual += Number(b.actual_duration_min);
        sawPartial = true;
      }
    }
    const done = actual + inferred;
    const remaining = Math.max(0, target - done);
    const completion: TaskProgress['completion'] = done >= target
      ? 'completed'
      : sawPartial ? 'partial' : sawInProgress ? 'in_progress' : done > 0 ? 'in_progress' : 'not_started';
    return {
      key: t.key,
      title: t.title,
      target_minutes: target,
      scheduled_minutes: scheduled,
      actual_done_minutes: actual,
      inferred_done_minutes: inferred,
      done_minutes: done,
      remaining_minutes: remaining,
      actual_known: actual > 0,
      completion,
      last_completed_at: lastCompletedAt,
    };
  });
}