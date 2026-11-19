import type { Block, TaskDef } from '../types.ts';

export interface TaskProgress {
  key: string;
  title: string;
  target_minutes: number;
  done_minutes: number;
  remaining_minutes: number;
  status: 'not_started' | 'in_progress' | 'partial' | 'completed';
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
 * 任务级进度 = Σ 该任务所有时间块的实际完成量。
 * completed 未上报实际时长时按块时长计；in_progress/partial 只计上报值；cancelled/skipped 不计。
 */
export function taskProgress(task_defs: TaskDef[], blocks: Block[], horizonDays: number): TaskProgress[] {
  return task_defs.map((t) => {
    const target = targetCount(t, horizonDays) * t.duration_min;
    let done = 0;
    let sawInProgress = false;
    let sawPartial = false;
    for (const b of blocks) {
      if (b.task_key !== t.key) continue;
      const status = b.status ?? 'planned';
      if (status === 'completed') done += b.actual_duration_min ?? minutesOf(b);
      else if (status === 'in_progress') { done += b.actual_duration_min ?? 0; sawInProgress = true; }
      else if (status === 'partial') { done += b.actual_duration_min ?? 0; sawPartial = true; }
    }
    const remaining = Math.max(0, target - done);
    const status: TaskProgress['status'] = done >= target
      ? 'completed'
      : sawPartial ? 'partial' : sawInProgress ? 'in_progress' : done > 0 ? 'in_progress' : 'not_started';
    return { key: t.key, title: t.title, target_minutes: target, done_minutes: done, remaining_minutes: remaining, status };
  });
}