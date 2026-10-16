import type { D1Database } from "@cloudflare/workers-types";
import type { Interval } from "./preview.ts";
/** User-confirmed task instances participate in subsequent deterministic conflict checks. */
export async function planningCalendarSnapshot(
  db: D1Database,
  owner: string,
  range?: Interval,
  excludeFutureVersion?: string,
) {
  const bounds = range ?? {
    start_at: Date.now() - 86400000,
    end_at: Date.now() + 84 * 86400000,
  };
  const rows = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT revision FROM calendar_states WHERE owner_id=?")
      .bind(owner),
    db
      .prepare(
        "SELECT id,start_at,end_at FROM calendar_events WHERE owner_id=? AND start_at<? AND end_at>? ORDER BY start_at,id LIMIT 501",
      )
      .bind(owner, bounds.end_at, bounds.start_at),
    db
      .prepare(
        "SELECT o.id,o.start_at,o.end_at FROM scheduled_occurrences o WHERE o.owner_id=? AND o.status='scheduled' AND o.start_at<? AND o.end_at>? AND NOT(o.plan_version_id=? AND o.start_at>?) ORDER BY o.start_at,o.id LIMIT 2001",
      )
      .bind(
        owner,
        bounds.end_at,
        bounds.start_at,
        excludeFutureVersion ?? "",
        Date.now(),
      ),
  ]);
  if (rows[1].results.length > 500 || rows[2].results.length > 2000)
    throw new Error("CALENDAR_LIMIT");
  return {
    revision: Number(rows[0].results[0]?.revision ?? 0),
    events: [...rows[1].results, ...rows[2].results] as unknown as (Interval & {
      id: string;
    })[],
  };
}

export async function upcomingCalendarResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
) {
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: { code, message: "日历未能读取，请重试。", details: null },
        request_id: requestId,
      },
      { status },
    );
  if (request.method !== "GET") {
    const r = fail(405, "METHOD_NOT_ALLOWED");
    r.headers.set("Allow", "GET");
    return r;
  }
  const params = new URL(request.url).searchParams,
    from = Number(params.get("from")),
    to = Number(params.get("to"));
  if (
    params.size !== 2 ||
    ![params.get("from"), params.get("to")].every(
      (s) => s && /^\d{1,16}$/.test(s),
    ) ||
    ![from, to].every(Number.isSafeInteger) ||
    from < 0 ||
    to <= from ||
    to - from > 31 * 86400000 ||
    to > 8640000000000000
  )
    return fail(422, "INVALID_RANGE");
  const rows = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT revision FROM calendar_states WHERE owner_id=?")
      .bind(owner),
    db
      .prepare(
        "SELECT id,title,start_at,end_at,timezone,'fixed' status,'user' source,'' instructions,NULL goal_id,NULL plan_version_id FROM calendar_events WHERE owner_id=? AND start_at<? AND end_at>? ORDER BY start_at,id LIMIT 501",
      )
      .bind(owner, to, from),
    db
      .prepare(
        "SELECT o.id,t.title,t.instructions,(SELECT json_extract(value,'$.segments') FROM json_each(v.draft_json,'$.tasks') WHERE json_extract(value,'$.id')=t.id) segments_json,o.start_at,o.end_at,o.timezone,o.status,'plan' source,o.goal_id,o.plan_version_id FROM scheduled_occurrences o JOIN tasks t ON t.id=o.task_id AND t.plan_version_id=o.plan_version_id AND t.goal_id=o.goal_id AND t.owner_id=o.owner_id JOIN plan_versions v ON v.id=o.plan_version_id AND v.owner_id=o.owner_id JOIN goal_active_plans a ON a.plan_version_id=o.plan_version_id AND a.goal_id=o.goal_id AND a.owner_id=o.owner_id WHERE o.owner_id=? AND o.status='scheduled' AND o.start_at<? AND o.end_at>? ORDER BY o.start_at,o.id LIMIT 2001",
      )
      .bind(owner, to, from),
  ]);
  if (rows[1].results.length > 500 || rows[2].results.length > 2000)
    return fail(409, "CALENDAR_LIMIT");
  return Response.json({
    data: {
      schema_version: 1,
      from,
      to,
      revision: Number(rows[0].results[0]?.revision ?? 0),
      events: [
        ...rows[1].results,
        ...rows[2].results.map<Record<string, unknown>>((r) => ({
          ...r,
          segments: r.segments_json
            ? JSON.parse(String(r.segments_json))
            : undefined,
          segments_json: undefined,
        })),
      ].sort(
        (a, b) =>
          Number(a.start_at) - Number(b.start_at) ||
          String(a.id).localeCompare(String(b.id)),
      ),
    },
    error: null,
    request_id: requestId,
  });
}
