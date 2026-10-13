import type { Interval, PreviewTask } from "./preview.ts";
export type WeeklyTask = PreviewTask & {
  title: string;
  ordinal: number;
  repeat_count: number;
  series_id: string;
  max_per_day: 1;
};
type TemplateTask = {
  id: string;
  title: string;
  duration_minutes: number;
  frequency_per_week: number;
  depends_on: string[];
};
/** Explicit one-week trial. Dependency order means all prerequisite trial instances first. */
export function weeklyTrial(
  tasks: TemplateTask[],
  windows: Interval[],
  timezone: "Asia/Shanghai" | "UTC",
) {
  if (
    !windows.length ||
    !tasks.length ||
    tasks.length > 6 ||
    !["UTC", "Asia/Shanghai"].includes(timezone)
  )
    return null;
  const offset = timezone === "Asia/Shanghai" ? 8 * 3600000 : 0;
  const start_at =
    Math.floor((windows[0].start_at + offset) / 86400000) * 86400000 - offset;
  const period = { start_at, end_at: start_at + 7 * 86400000 };
  if (
    windows.some(
      (window) =>
        window.start_at < period.start_at || window.end_at > period.end_at,
    )
  )
    return null;
  const expanded: WeeklyTask[] = [];
  for (const task of tasks) {
    if (
      !Number.isInteger(task.frequency_per_week) ||
      task.frequency_per_week < 1 ||
      task.frequency_per_week > 7 ||
      task.depends_on.some((id) => !tasks.some((parent) => parent.id === id))
    )
      return null;
    const prerequisites = task.depends_on.flatMap((id) => {
      const parent = tasks.find((parent) => parent.id === id)!;
      return Array.from(
        { length: parent.frequency_per_week },
        (_, index) => `${id}_${index + 1}`,
      );
    });
    for (let ordinal = 1; ordinal <= task.frequency_per_week; ordinal++) {
      expanded.push({
        id: `${task.id}_${ordinal}`,
        title: task.title,
        duration_minutes: task.duration_minutes,
        depends_on: [
          ...prerequisites,
          ...(ordinal > 1 ? [`${task.id}_${ordinal - 1}`] : []),
        ],
        series_id: task.id,
        max_per_day: 1,
        ordinal,
        repeat_count: task.frequency_per_week,
      });
    }
  }
  return { tasks: expanded, period };
}
