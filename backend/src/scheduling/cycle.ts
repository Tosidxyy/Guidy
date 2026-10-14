import type { Interval, PreviewTask } from "./preview.ts";

type Template = {
  id: string;
  stage: number;
  title: string;
  duration_minutes: number;
  frequency_per_week: number;
  depends_on: string[];
};
export type StageWeeks = { stage: number; weeks: number };
export type CycleTask = PreviewTask & {
  title: string;
  stage: number;
  week: number;
  ordinal: number;
  repeat_count: number;
  series_id: string;
  max_per_day: 1;
};
const DAY = 86400000;

/** Expand every stage and week; deadlines prevent packing missed work into later weeks. */
export function planCycle(
  tasks: Template[],
  stageWeeks: StageWeeks[] | undefined,
  start: number,
) {
  if (
    !tasks.length ||
    tasks.length > 6 ||
    !Number.isSafeInteger(start) ||
    start < 0
  )
    return null;
  const stages = [...new Set(tasks.map((t) => t.stage))].sort((a, b) => a - b);
  const weeks = stageWeeks ?? stages.map((stage) => ({ stage, weeks: 1 }));
  if (
    weeks.length !== stages.length ||
    weeks.some(
      (s, i) =>
        s.stage !== stages[i] ||
        !Number.isInteger(s.weeks) ||
        s.weeks < 1 ||
        s.weeks > 12,
    ) ||
    weeks.reduce((n, s) => n + s.weeks, 0) > 12 ||
    new Set(tasks.map((t) => t.id)).size !== tasks.length
  )
    return null;
  const expanded: CycleTask[] = [];
  const periods: (StageWeeks & Interval)[] = [];
  let elapsed = 0;
  for (const phase of weeks) {
    const begin = start + elapsed * 7 * DAY;
    periods.push({
      ...phase,
      start_at: begin,
      end_at: begin + phase.weeks * 7 * DAY,
    });
    const current = tasks.filter((t) => t.stage === phase.stage);
    for (let week = 0; week < phase.weeks; week++)
      for (const task of current) {
        if (
          !Number.isInteger(task.frequency_per_week) ||
          task.frequency_per_week < 1 ||
          task.frequency_per_week > 7 ||
          task.depends_on.some(
            (id) =>
              !tasks.some(
                (t) => t.id === id && t.stage <= task.stage && t.id !== task.id,
              ),
          )
        )
          return null;
        const dependencies = task.depends_on.flatMap((id) => {
          const parent = tasks.find((t) => t.id === id)!;
          if (parent.stage === phase.stage)
            return Array.from(
              { length: parent.frequency_per_week },
              (_, i) => `${id}_${week * parent.frequency_per_week + i + 1}`,
            );
          const parentWeeks = weeks.find(
            (s) => s.stage === parent.stage,
          )!.weeks;
          return Array.from(
            { length: parentWeeks * parent.frequency_per_week },
            (_, i) => `${id}_${i + 1}`,
          );
        });
        for (let repeat = 1; repeat <= task.frequency_per_week; repeat++) {
          const ordinal = week * task.frequency_per_week + repeat;
          expanded.push({
            id: `${task.id}_${ordinal}`,
            title: task.title,
            stage: phase.stage,
            week: elapsed + week + 1,
            duration_minutes: task.duration_minutes,
            depends_on: [
              ...dependencies,
              ...(repeat > 1 ? [`${task.id}_${ordinal - 1}`] : []),
            ],
            earliest_at: begin + week * 7 * DAY,
            deadline_at: begin + (week + 1) * 7 * DAY,
            series_id: task.id,
            max_per_day: 1,
            ordinal,
            repeat_count: phase.weeks * task.frequency_per_week,
          });
        }
      }
    elapsed += phase.weeks;
  }
  return {
    tasks: expanded,
    period: { start_at: start, end_at: start + elapsed * 7 * DAY },
    stages: periods,
    period_basis: stageWeeks
      ? ("agent_draft_v1" as const)
      : ("assumed_one_week_per_stage_v1" as const),
  };
}
