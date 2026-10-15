import type { D1Database } from "@cloudflare/workers-types";

export function automaticScheduleKey(
  attempt: string,
  review: number,
  calendar: number,
  timezone: string,
  now = Date.now(),
) {
  const day = Math.floor(
    (now + (timezone === "UTC" ? 0 : 28800000)) / 86400000,
  );
  return `auto_schedule_${attempt}_${review}_${calendar}_${day}`;
}

/** Read-only: the latest job must have a usable draft before any refresh is offered. */
export async function automaticScheduleRequest(
  db: D1Database,
  owner: string,
  goal: string,
  now = Date.now(),
) {
  const row = await db
    .prepare(
      "SELECT j.id,g.status,p.context_json,(SELECT plan_version_id FROM goal_active_plans WHERE goal_id=g.id AND owner_id=g.owner_id) parent,g.revision current_revision,p.goal_revision,p.draft_json,(SELECT draft_json FROM plan_draft_reviews WHERE attempt_id=j.id AND owner_id=j.owner_id ORDER BY revision DESC LIMIT 1) reviewed,(SELECT coalesce(max(revision),0) FROM plan_draft_reviews WHERE attempt_id=j.id AND owner_id=j.owner_id) review,coalesce((SELECT revision FROM calendar_states WHERE owner_id=j.owner_id),0) calendar FROM planning_jobs j JOIN goals g ON g.id=j.goal_id AND g.owner_id=j.owner_id LEFT JOIN plan_draft_attempts p ON p.id=j.id AND p.owner_id=j.owner_id AND p.status='succeeded' WHERE j.goal_id=? AND j.owner_id=? AND g.status IN ('draft','active') ORDER BY j.created_at DESC,j.id DESC LIMIT 1",
    )
    .bind(goal, owner)
    .first();
  if (!row?.draft_json || row.goal_revision !== row.current_revision)
    return null;
  if (
    row.status === "active" &&
    JSON.parse(String(row.context_json ?? "{}")).replan_parent_id !== row.parent
  )
    return null;
  const draft = JSON.parse(String(row.reviewed ?? row.draft_json));
  return automaticScheduleKey(
    String(row.id),
    Number(row.review),
    Number(row.calendar),
    draft.time_preferences?.timezone ?? "Asia/Shanghai",
    now,
  );
}
