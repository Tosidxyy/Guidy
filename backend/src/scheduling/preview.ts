/** Concrete instants only. Local dates/recurrence must be resolved and confirmed upstream. */
export type Interval = { start_at: number; end_at: number };
export type PreviewTask = {
  id: string;
  duration_minutes: number;
  depends_on: string[];
  earliest_at?: number;
  deadline_at?: number;
  fixed_start_at?: number;
  series_id?: string;
  minimum_gap_minutes?: number;
  /** First release: resolved local days in UTC or Asia/Shanghai only. */
  max_per_day?: 1;
};
export type PreviewInput = {
  schema_version: 1;
  period_mode?: "full_plan_cycle_v1";
  timezone: string;
  horizon: Interval;
  windows: Interval[];
  busy: Interval[];
  tasks: PreviewTask[];
  /** Explicitly verified completion instants, never inferred from notifications. */
  completed_dependencies: { id: string; completed_at: number }[];
};
export type Placement = Interval & { task_id: string };
export type PreviewResult = {
  schema_version: 1;
  status: "preview_only";
  strategy: "stable_topological_earliest_v1";
  timezone: string;
  placements: Placement[];
  unplaced: {
    task_id: string;
    reason: "dependency_unplaced" | "no_legal_window";
  }[];
};

const MINUTE = 60_000;
const LIMIT = 100;
function instant(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 8_640_000_000_000_000
  );
}
function interval(value: Interval): boolean {
  return (
    !!value &&
    instant(value.start_at) &&
    instant(value.end_at) &&
    value.end_at > value.start_at
  );
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
function invalid(): never {
  // Never include private input in diagnostics.
  throw new Error("INVALID_SCHEDULE_INPUT");
}
function validate(input: PreviewInput): void {
  const cycle = input?.period_mode === "full_plan_cycle_v1";
  if (input?.period_mode !== undefined && !cycle) invalid();
  if (
    !input ||
    input.schema_version !== 1 ||
    typeof input.timezone !== "string" ||
    !/^(UTC|[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.test(input.timezone) ||
    !interval(input.horizon) ||
    input.horizon.end_at - input.horizon.start_at >
      (cycle ? 84 : 31) * 24 * 60 * MINUTE
  )
    invalid();
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
  } catch {
    invalid();
  }
  for (const list of [
    input.windows,
    input.busy,
    input.tasks,
    input.completed_dependencies,
  ]) {
    if (
      !Array.isArray(list) ||
      list.length > (cycle ? (list === input.busy ? 2600 : 600) : LIMIT)
    )
      invalid();
  }
  if (!input.windows.every(interval) || !input.busy.every(interval)) invalid();
  const known = new Set<string>();
  for (const entry of input.completed_dependencies) {
    if (
      !entry ||
      !id(entry.id) ||
      known.has(entry.id) ||
      !instant(entry.completed_at) ||
      entry.completed_at > input.horizon.start_at
    )
      invalid();
    known.add(entry.id);
  }
  for (const task of input.tasks) {
    if (
      !task ||
      !id(task.id) ||
      known.has(task.id) ||
      !Number.isInteger(task.duration_minutes) ||
      task.duration_minutes < 1 ||
      task.duration_minutes > 1440 ||
      !Array.isArray(task.depends_on) ||
      task.depends_on.length > LIMIT ||
      new Set(task.depends_on).size !== task.depends_on.length ||
      !task.depends_on.every(id)
    )
      invalid();
    known.add(task.id);
    for (const time of [
      task.earliest_at,
      task.deadline_at,
      task.fixed_start_at,
    ]) {
      if (time !== undefined && !instant(time)) invalid();
    }
    if (task.series_id !== undefined && !id(task.series_id)) invalid();
    if (
      task.max_per_day !== undefined &&
      (task.max_per_day !== 1 ||
        !task.series_id ||
        !["UTC", "Asia/Shanghai"].includes(input.timezone))
    )
      invalid();
    if (
      task.minimum_gap_minutes !== undefined &&
      (!task.series_id ||
        !Number.isInteger(task.minimum_gap_minutes) ||
        task.minimum_gap_minutes < 0 ||
        task.minimum_gap_minutes > 31 * 1440)
    )
      invalid();
  }
  for (const task of input.tasks) {
    if (
      task.depends_on.some(
        (dependency) => dependency === task.id || !known.has(dependency),
      )
    )
      invalid();
  }
  // Reject cycles before producing even a partial preview.
  const visited = new Set(
    input.completed_dependencies.map((entry) => entry.id),
  );
  let remaining = [...input.tasks];
  while (remaining.length) {
    const ready = remaining.filter((task) =>
      task.depends_on.every((dependency) => visited.has(dependency)),
    );
    if (!ready.length) invalid();
    ready.forEach((task) => visited.add(task.id));
    remaining = remaining.filter((task) => !visited.has(task.id));
  }
}

function merge(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const entry of [...intervals].sort(
    (a, b) => a.start_at - b.start_at || a.end_at - b.end_at,
  )) {
    const last = result.at(-1);
    if (last && entry.start_at <= last.end_at)
      last.end_at = Math.max(last.end_at, entry.end_at);
    else result.push({ ...entry });
  }
  return result;
}

/** Pure, bounded, deterministic and non-optimal. No DB, model, calendar or notification writes. */
export function previewSchedule(input: PreviewInput): PreviewResult {
  validate(input);
  const windows = merge(
    input.windows
      .map((entry) => ({
        start_at: Math.max(entry.start_at, input.horizon.start_at),
        end_at: Math.min(entry.end_at, input.horizon.end_at),
      }))
      .filter((entry) => entry.end_at > entry.start_at),
  );
  const placements: Placement[] = [];
  const unplaced: PreviewResult["unplaced"] = [];
  const processed = new Set(
    input.completed_dependencies.map((entry) => entry.id),
  );
  const ends = new Map(
    input.completed_dependencies.map((entry) => [entry.id, entry.completed_at]),
  );
  const series: {
    id: string;
    interval: Interval;
    gap: number;
    daily: boolean;
  }[] = [];
  const day = (at: number) => {
    const offset = input.timezone === "Asia/Shanghai" ? 8 * 3600000 : 0;
    const start_at = Math.floor((at + offset) / 86400000) * 86400000 - offset;
    return { start_at: Math.max(0, start_at), end_at: start_at + 86400000 };
  };
  let remaining = [...input.tasks].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  while (remaining.length) {
    const task = remaining.find((candidate) =>
      candidate.depends_on.every((dependency) => processed.has(dependency)),
    )!;
    remaining = remaining.filter((candidate) => candidate !== task);
    processed.add(task.id);
    if (task.depends_on.some((dependency) => !ends.has(dependency))) {
      unplaced.push({ task_id: task.id, reason: "dependency_unplaced" });
      continue;
    }
    const earliest = Math.max(
      input.horizon.start_at,
      task.earliest_at ?? 0,
      ...task.depends_on.map((dependency) => ends.get(dependency)!),
    );
    const deadline = Math.min(
      input.horizon.end_at,
      task.deadline_at ?? input.horizon.end_at,
    );
    const gap = (task.minimum_gap_minutes ?? 0) * MINUTE;
    const blocked = merge([
      ...input.busy,
      ...placements,
      ...series
        .filter((entry) => entry.id === task.series_id)
        .map((entry) => ({
          start_at: Math.max(
            0,
            entry.interval.start_at - Math.max(gap, entry.gap),
          ),
          end_at: entry.interval.end_at + Math.max(gap, entry.gap),
        })),
      ...series
        .filter(
          (entry) =>
            entry.id === task.series_id &&
            (task.max_per_day === 1 || entry.daily),
        )
        .map((entry) => day(entry.interval.start_at)),
    ]);
    let placement: Placement | undefined;
    const taskWindows =
      task.max_per_day === 1
        ? windows.flatMap((window) => {
            const pieces: Interval[] = [];
            let start = window.start_at;
            while (start < window.end_at) {
              const end = Math.min(window.end_at, day(start).end_at);
              pieces.push({ start_at: start, end_at: end });
              start = end;
            }
            return pieces;
          })
        : windows;
    for (const window of taskWindows) {
      let start = task.fixed_start_at ?? Math.max(earliest, window.start_at);
      for (const block of blocked) {
        if (block.end_at <= start) continue;
        if (block.start_at >= start + task.duration_minutes * MINUTE) break;
        if (task.fixed_start_at !== undefined) {
          start = -1;
          break;
        }
        start = block.end_at;
      }
      const end = start + task.duration_minutes * MINUTE;
      if (
        start >= earliest &&
        start >= window.start_at &&
        end <= window.end_at &&
        end <= deadline
      ) {
        placement = { task_id: task.id, start_at: start, end_at: end };
        break;
      }
    }
    if (!placement) {
      unplaced.push({ task_id: task.id, reason: "no_legal_window" });
      continue;
    }
    placements.push(placement);
    ends.set(task.id, placement.end_at);
    if (task.series_id)
      series.push({
        id: task.series_id,
        interval: placement,
        gap,
        daily: task.max_per_day === 1,
      });
  }
  return {
    schema_version: 1,
    status: "preview_only",
    strategy: "stable_topological_earliest_v1",
    timezone: input.timezone,
    placements,
    unplaced,
  };
}
