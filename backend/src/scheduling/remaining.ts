import type { D1Database } from "@cloudflare/workers-types";
import type { ScheduleData } from "./chat.ts";
import { planningCalendarSnapshot } from "./calendar.ts";
import { previewSchedule } from "./preview.ts";
import type { Preferences } from "../agent/schedule-preferences.ts";

export async function remainingSchedule(
  db: D1Database,
  owner: string,
  parent: Record<string, unknown>,
  preferences: Preferences,
  goalRevision: number,
  now = Date.now(),
) {
  const old: ScheduleData = JSON.parse(String(parent.schedule_json)),
    offset = old.timezone === "UTC" ? 0 : 8 * 3600000;
  const records = (
    await db
      .prepare(
        "SELECT id,instance_key,status,start_at FROM scheduled_occurrences WHERE plan_version_id=? AND owner_id=? ORDER BY start_at,id",
      )
      .bind(parent.id, owner)
      .all()
  ).results;
  const future = records.filter(
    (r) => r.status === "scheduled" && Number(r.start_at) > now,
  );
  if (!future.length) return null;
  const keys = new Set(future.map((r) => String(r.instance_key))),
    completed = new Set(
      records
        .filter((r) => r.status === "completed")
        .map((r) => String(r.instance_key)),
    );
  const completedIds = new Set<string>();
  const tasks = old.tasks
    .filter((t) => keys.has(t.id))
    .map((t) => {
      let missing = false;
      for (const id of t.depends_on) {
        if (keys.has(id)) continue;
        const other = old.tasks.find((p) => p.id === id);
        if (other?.series_id === t.series_id) continue;
        if (!completed.has(id)) missing = true;
        else {
          const r = records.find((r) => r.instance_key === id);
          if (r) completedIds.add(String(r.id));
        }
      }
      const earliest = Math.min(
        t.deadline_at ?? old.period!.end_at,
        Math.max(t.earliest_at ?? old.period!.start_at, now + 300000),
      );
      return {
        ...t,
        depends_on: t.depends_on.filter((id) => keys.has(id)),
        earliest_at: earliest,
        deadline_at: missing ? earliest : t.deadline_at,
        needs_previous_feedback: missing,
      };
    });
  if (tasks.length !== future.length) throw new Error("INVALID_REPLAN_SOURCE");
  const windows = Array.from(
    { length: (old.period!.end_at - old.period!.start_at) / 86400000 },
    (_, i) => ({
      start_at:
        old.period!.start_at +
        i * 86400000 +
        preferences.preferred_start * 60000,
      end_at:
        old.period!.start_at + i * 86400000 + preferences.preferred_end * 60000,
    }),
  );
  const excluded = windows.filter(
    (w) =>
      preferences.excluded_weekdays.includes(
        new Date(w.start_at + offset).getUTCDay(),
      ) ||
      preferences.excluded_dates.includes(
        new Date(w.start_at + offset).toISOString().slice(0, 10),
      ),
  );
  const calendar = await planningCalendarSnapshot(
    db,
    owner,
    old.period,
    String(parent.id),
  );
  const preview = previewSchedule({
    schema_version: 1,
    period_mode: "full_plan_cycle_v1",
    timezone: old.timezone,
    horizon: old.period!,
    windows,
    busy: [...calendar.events, ...excluded],
    tasks,
    completed_dependencies: [],
  });
  for (const item of preview.unplaced)
    if (tasks.find((t) => t.id === item.task_id)?.needs_previous_feedback)
      item.reason = "dependency_unplaced";
  return {
    ...old,
    scope: "remaining_plan_v1" as const,
    goal_revision: goalRevision,
    windows,
    tasks,
    confirmed_from_run_id: undefined,
    window_basis: "assumed_default_v1" as const,
    preferences,
    replaces_plan_id: String(parent.id),
    parent_instance_ids: future.map((r) => String(r.id)),
    completed_source_ids: [...completedIds],
    unavailable_from_notes: excluded,
    calendar_snapshot: { revision: calendar.revision, busy: calendar.events },
    preview,
  };
}
