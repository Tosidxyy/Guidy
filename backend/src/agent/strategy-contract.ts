import { AgentError } from "./provider.ts";
import { planCycle } from "../scheduling/cycle.ts";
import { previewSchedule } from "../scheduling/preview.ts";
export function validateStrategy(
  draft: {
    stage_weeks?: { stage: number; weeks: number }[];
    tasks: {
      id: string;
      title: string;
      stage: number;
      segments?: unknown[];
      duration_minutes: number;
      frequency_per_week: number;
      depends_on: string[];
    }[];
    time_preferences?: {
      timezone: string;
      start_minute: number;
      end_minute: number;
      excluded_weekdays: number[];
    };
  },
  contract: unknown,
) {
  if (contract !== "strategy_21_v1") return;
  if (
    draft.tasks.length !== 3 ||
    draft.stage_weeks?.length !== 3 ||
    draft.stage_weeks.some((p, i) => p.stage !== i + 1 || p.weeks !== 1) ||
    [1, 2, 3].some((stage) => !draft.tasks.some((t) => t.stage === stage)) ||
    draft.tasks.some((t) => !t.segments?.length)
  )
    throw new AgentError("STRATEGY_CONTRACT_FAILED");
  // Same-session ordering belongs in segments. A series dependency means the
  // entire prerequisite series, so same-week chains can make recurrence impossible.
  if (
    draft.tasks.some((t) =>
      t.depends_on.some(
        (id) => draft.tasks.find((p) => p.id === id)?.stage === t.stage,
      ),
    )
  )
    throw new AgentError("STRATEGY_CAPACITY_FAILED");
  const preference = draft.time_preferences ?? {
    timezone: "Asia/Shanghai",
    start_minute: 1200,
    end_minute: 1260,
    excluded_weekdays: [],
  };
  const offset = preference.timezone === "UTC" ? 0 : 28800000;
  const start = Date.UTC(2030, 0, 7) - offset;
  const cycle = planCycle(draft.tasks, draft.stage_weeks, start);
  if (!cycle) throw new AgentError("STRATEGY_CAPACITY_FAILED");
  const windows = Array.from({ length: 21 }, (_, i) => ({
    start_at: start + i * 86400000 + preference.start_minute * 60000,
    end_at: start + i * 86400000 + preference.end_minute * 60000,
  })).filter(
    (w) =>
      !preference.excluded_weekdays.includes(
        new Date(w.start_at + offset).getUTCDay(),
      ),
  );
  const preview = previewSchedule({
    schema_version: 1,
    period_mode: "full_plan_cycle_v1",
    timezone: preference.timezone,
    horizon: cycle.period,
    windows,
    busy: [],
    tasks: cycle.tasks,
    completed_dependencies: [],
  });
  if (preview.unplaced.length) throw new AgentError("STRATEGY_CAPACITY_FAILED");
}
