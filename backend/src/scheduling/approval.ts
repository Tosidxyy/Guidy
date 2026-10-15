import type { D1Database } from "@cloudflare/workers-types";
import { boundedText } from "../http/bounded-text.ts";
import { planningCalendarSnapshot } from "./calendar.ts";
import { previewSchedule } from "./preview.ts";
import type { ScheduleData } from "./chat.ts";

export async function approvalResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
) {
  const goalId = new URL(request.url).pathname.split("/").at(-2)!;
  const ok = (approval: unknown) =>
    Response.json({
      data: { schema_version: 1, approval },
      error: null,
      request_id: requestId,
    });
  const fail = (
    status: number,
    code: string,
    message = "方案尚未确认，请读取最新日程后再试。",
  ) =>
    Response.json(
      {
        data: null,
        error: { code, message, details: null },
        request_id: requestId,
      },
      { status },
    );
  const goal = await db
    .prepare("SELECT revision,status FROM goals WHERE id=? AND owner_id=?")
    .bind(goalId, owner)
    .first();
  if (!goal) return fail(404, "NOT_FOUND");
  const receipt = (row: Record<string, unknown>) => ({
    id: row.id,
    attempt_id: row.source_attempt_id,
    goal_revision: row.goal_revision,
    version: row.version,
    accepted_at: row.accepted_at,
    calendar_revision: row.calendar_revision_after,
    context: JSON.parse(String(row.context_json)),
    draft: JSON.parse(String(row.draft_json)),
    schedule: JSON.parse(String(row.schedule_json)),
  });
  if (request.method === "GET") {
    const row = await db
      .prepare(
        "SELECT v.* FROM goal_active_plans a JOIN plan_versions v ON v.id=a.plan_version_id AND v.owner_id=a.owner_id AND v.goal_id=a.goal_id WHERE a.goal_id=? AND a.owner_id=?",
      )
      .bind(goalId, owner)
      .first();
    return ok(row ? receipt(row) : null);
  }
  if (request.method !== "POST") {
    const response = fail(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "GET, POST");
    return response;
  }
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    return fail(415, "INVALID_CONTENT_TYPE");
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY");
  let body: {
    schedule_run_id: string;
    expected_goal_revision: number;
    expected_calendar_revision: number;
  };
  try {
    body = JSON.parse(await boundedText(request.body, 1024));
    if (
      !body ||
      Object.keys(body).sort().join(",") !==
        "expected_calendar_revision,expected_goal_revision,schedule_run_id" ||
      !/^[0-9a-f-]{36}$/.test(body.schedule_run_id) ||
      ![body.expected_goal_revision, body.expected_calendar_revision].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw new Error();
  } catch {
    return fail(422, "INVALID_BODY");
  }
  const payload = JSON.stringify({
    goal_id: goalId,
    schedule_run_id: body.schedule_run_id,
    expected_goal_revision: body.expected_goal_revision,
    expected_calendar_revision: body.expected_calendar_revision,
  });
  const previous = await db
    .prepare("SELECT * FROM plan_versions WHERE owner_id=? AND request_key=?")
    .bind(owner, key)
    .first();
  if (previous)
    return previous.request_payload === payload
      ? ok(receipt(previous))
      : fail(409, "IDEMPOTENCY_CONFLICT");
  if (
    !["draft", "active"].includes(String(goal.status)) ||
    goal.revision !== body.expected_goal_revision
  )
    return fail(409, "CONTEXT_CHANGED");
  const run = await db
    .prepare(
      "SELECT reply_json,goal_revision FROM agent_runs WHERE id=? AND goal_id=? AND owner_id=? AND status='succeeded'",
    )
    .bind(body.schedule_run_id, goalId, owner)
    .first();
  const reply = run?.reply_json ? JSON.parse(String(run.reply_json)) : null;
  const schedule: ScheduleData | undefined = reply?.schedule;
  if (
    !schedule ||
    reply.source !== "harness" ||
    reply.stage !== "schedule_preview" ||
    !["full_plan_cycle_v1", "remaining_plan_v1"].includes(schedule.scope) ||
    schedule.goal_revision !== body.expected_goal_revision ||
    schedule.calendar_snapshot?.revision !== body.expected_calendar_revision ||
    !schedule.preview ||
    schedule.preview.unplaced.length ||
    !schedule.preview.placements.length
  )
    return fail(
      409,
      "PLAN_NOT_READY",
      "请先核对完整方案；尚未安排的任务需要调整后再确认。",
    );
  const source = await db
    .prepare(
      "SELECT p.context_json,p.draft_json,coalesce(r.draft_json,p.draft_json) chosen_draft,coalesce(r.revision,0) review_revision FROM plan_draft_attempts p LEFT JOIN plan_draft_reviews r ON r.id=(SELECT id FROM plan_draft_reviews WHERE attempt_id=p.id AND owner_id=p.owner_id ORDER BY revision DESC LIMIT 1) WHERE p.id=? AND p.goal_id=? AND p.owner_id=? AND p.status='succeeded'",
    )
    .bind(schedule.attempt_id, goalId, owner)
    .first();
  if (!source || source.review_revision !== schedule.review_revision)
    return fail(409, "CONTEXT_CHANGED");
  const parentId = schedule.replaces_plan_id ?? "";
  if (
    parentId &&
    schedule.scope === "full_plan_cycle_v1" &&
    JSON.parse(String(source.context_json)).replan_parent_id !== parentId
  )
    return fail(409, "CONTEXT_CHANGED");
  if ((goal.status === "active") !== !!parentId)
    return fail(409, "CONTEXT_CHANGED");
  const pointer = await db
    .prepare(
      "SELECT plan_version_id FROM goal_active_plans WHERE goal_id=? AND owner_id=?",
    )
    .bind(goalId, owner)
    .first();
  if ((pointer?.plan_version_id ?? "") !== parentId)
    return fail(409, "CONTEXT_CHANGED");
  const now = Date.now();
  if (schedule.preview.placements.some((p) => p.start_at <= now))
    return fail(
      409,
      "SCHEDULE_EXPIRED",
      "建议时间已过去，请更新日程后再确认。",
    );
  const calendar = await planningCalendarSnapshot(
    db,
    owner,
    schedule.period,
    parentId,
  );
  if (calendar.revision !== body.expected_calendar_revision)
    return fail(409, "CALENDAR_CHANGED", "日历已有变化，请核对新的建议安排。");
  const preview = previewSchedule({
    schema_version: 1,
    period_mode: "full_plan_cycle_v1",
    timezone: schedule.timezone,
    horizon: schedule.period!,
    windows: schedule.windows,
    busy: [...calendar.events, ...(schedule.unavailable_from_notes ?? [])],
    tasks: schedule.tasks,
    completed_dependencies: [],
  });
  if (JSON.stringify(preview) !== JSON.stringify(schedule.preview))
    return fail(409, "CALENDAR_CHANGED");
  const id = crypto.randomUUID(),
    draft = JSON.parse(String(source.chosen_draft));
  const instances = schedule.preview.placements.map((p) => ({
    ...p,
    id: crypto.randomUUID(),
    key: p.task_id,
    task_id: schedule.tasks.find((t) => t.id === p.task_id)!.series_id,
  }));
  const json = JSON.stringify(schedule),
    draftJson = JSON.stringify(draft);
  if (parentId) {
    const candidates = (
      await db
        .prepare(
          "SELECT id FROM scheduled_occurrences WHERE plan_version_id=? AND owner_id=? AND status='scheduled' AND start_at>?",
        )
        .bind(parentId, owner, now)
        .all()
    ).results.map((r) => r.id);
    if (
      !schedule.parent_instance_ids ||
      candidates.length !== schedule.parent_instance_ids.length ||
      candidates.some(
        (id) => !schedule.parent_instance_ids!.includes(String(id)),
      )
    )
      return fail(409, "CONTEXT_CHANGED");
  }
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO plan_versions(id,goal_id,owner_id,version,source_attempt_id,source_run_id,goal_revision,calendar_revision_before,calendar_revision_after,request_key,request_payload,context_json,draft_json,schedule_json,accepted_at) SELECT ?,id,owner_id,(SELECT coalesce(max(version),0)+1 FROM plan_versions WHERE goal_id=g.id),?,?,?,?,?,?,?, ?,?,?,? FROM goals g WHERE id=? AND owner_id=? AND status IN ('draft','active') AND revision=? AND coalesce((SELECT plan_version_id FROM goal_active_plans WHERE goal_id=g.id AND owner_id=g.owner_id),'')=? AND coalesce((SELECT revision FROM calendar_states WHERE owner_id=g.owner_id),0)=? AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=g.id AND owner_id=g.owner_id AND json_extract(reply_json,'$.source')='policy') AND ?=(SELECT id FROM agent_runs WHERE goal_id=g.id AND owner_id=g.owner_id AND harness_version!='refine-question-v1' ORDER BY turn_index DESC LIMIT 1) AND ?=(SELECT id FROM planning_jobs WHERE goal_id=g.id AND owner_id=g.owner_id ORDER BY created_at DESC,id DESC LIMIT 1) AND ?=(SELECT coalesce(max(revision),0) FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=g.owner_id) AND NOT EXISTS(SELECT 1 FROM json_each(?) p JOIN scheduled_occurrences o ON o.owner_id=g.owner_id AND o.status='scheduled' AND NOT(o.plan_version_id=? AND o.start_at>?) AND o.start_at<json_extract(p.value,'$.end_at') AND o.end_at>json_extract(p.value,'$.start_at')) AND (?='' OR (SELECT count(*) FROM scheduled_occurrences WHERE plan_version_id=? AND owner_id=g.owner_id AND status='scheduled' AND start_at>?)=?) AND NOT EXISTS(SELECT 1 FROM json_each(?) c LEFT JOIN scheduled_occurrences o ON o.id=c.value AND o.plan_version_id=? AND o.owner_id=g.owner_id AND o.status='scheduled' AND o.start_at>? WHERE o.id IS NULL) AND NOT EXISTS(SELECT 1 FROM json_each(?) c LEFT JOIN scheduled_occurrences o ON o.id=c.value AND o.owner_id=g.owner_id AND o.status='completed' WHERE o.id IS NULL) AND NOT EXISTS(SELECT 1 FROM json_each(?) p JOIN calendar_events e ON e.owner_id=g.owner_id AND e.start_at<json_extract(p.value,'$.end_at') AND e.end_at>json_extract(p.value,'$.start_at'))`,
      )
      .bind(
        id,
        schedule.attempt_id,
        body.schedule_run_id,
        body.expected_goal_revision,
        body.expected_calendar_revision,
        body.expected_calendar_revision + 1,
        key,
        payload,
        String(source.context_json),
        draftJson,
        json,
        now,
        goalId,
        owner,
        body.expected_goal_revision,
        parentId,
        body.expected_calendar_revision,
        body.schedule_run_id,
        schedule.attempt_id,
        schedule.review_revision,
        schedule.attempt_id,
        JSON.stringify(instances),
        parentId,
        now,
        parentId,
        parentId,
        now,
        schedule.parent_instance_ids?.length ?? 0,
        JSON.stringify(schedule.parent_instance_ids ?? []),
        parentId,
        now,
        JSON.stringify(schedule.completed_source_ids ?? []),
        JSON.stringify(instances),
      ),
    db
      .prepare(
        "INSERT INTO tasks(id,plan_version_id,goal_id,owner_id,logical_task_key,title,instructions,duration_minutes) SELECT json_extract(t.value,'$.id'),v.id,v.goal_id,v.owner_id,json_extract(t.value,'$.key'),json_extract(t.value,'$.title'),json_extract(t.value,'$.instructions'),json_extract(t.value,'$.duration_minutes') FROM plan_versions v,json_each(v.draft_json,'$.tasks') t WHERE v.id=?",
      )
      .bind(id),
    db
      .prepare(
        "INSERT INTO scheduled_occurrences(id,task_id,plan_version_id,goal_id,owner_id,instance_key,start_at,end_at,timezone,created_at) SELECT json_extract(o.value,'$.id'),json_extract(o.value,'$.task_id'),v.id,v.goal_id,v.owner_id,json_extract(o.value,'$.key'),json_extract(o.value,'$.start_at'),json_extract(o.value,'$.end_at'),json_extract(v.schedule_json,'$.timezone'),v.accepted_at FROM plan_versions v,json_each(?) o WHERE v.id=?",
      )
      .bind(JSON.stringify(instances), id),
    db
      .prepare(
        "UPDATE scheduled_occurrences SET status='superseded' WHERE plan_version_id=? AND owner_id=? AND status='scheduled' AND start_at>? AND EXISTS(SELECT 1 FROM plan_versions WHERE id=?)",
      )
      .bind(parentId, owner, now, id),
    db
      .prepare(
        "INSERT INTO goal_active_plans(goal_id,owner_id,plan_version_id) SELECT goal_id,owner_id,id FROM plan_versions WHERE id=? ON CONFLICT(goal_id) DO UPDATE SET plan_version_id=excluded.plan_version_id",
      )
      .bind(id),
    db
      .prepare(
        "INSERT INTO calendar_states(owner_id,revision) SELECT owner_id,calendar_revision_after FROM plan_versions WHERE id=? ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision",
      )
      .bind(id),
    db
      .prepare(
        "UPDATE goals SET status='active',revision=revision+1,updated_at=max(updated_at,?) WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM plan_versions WHERE id=?)",
      )
      .bind(now, goalId, owner, id),
  ]);
  const saved = await db
    .prepare("SELECT * FROM plan_versions WHERE owner_id=? AND request_key=?")
    .bind(owner, key)
    .first();
  return saved && saved.request_payload === payload
    ? ok(receipt(saved))
    : fail(409, "CONTEXT_CHANGED");
}
