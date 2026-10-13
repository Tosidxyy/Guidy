import type { D1Database } from "@cloudflare/workers-types";
import type { Interval } from "./preview.ts";
export type BusyEvent = Interval & {
  id: string;
  timezone: "UTC" | "Asia/Shanghai";
  title: string;
  fixed: 1;
  source: "user";
};
export async function calendarSnapshot(
  db: D1Database,
  owner: string,
  range?: Interval,
) {
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT revision FROM calendar_states WHERE owner_id=?")
      .bind(owner),
    range
      ? db
          .prepare(
            "SELECT id,title,start_at,end_at,timezone,fixed,source FROM calendar_events WHERE owner_id=? AND start_at<? AND end_at>? ORDER BY start_at,id LIMIT 501",
          )
          .bind(owner, range.end_at, range.start_at)
      : db
          .prepare(
            "SELECT id,title,start_at,end_at,timezone,fixed,source FROM calendar_events WHERE owner_id=? ORDER BY start_at,id LIMIT 501",
          )
          .bind(owner),
  ]);
  if (results[1].results.length > 500) throw new Error("CALENDAR_LIMIT");
  return {
    revision: Number(results[0].results[0]?.revision ?? 0),
    events: results[1].results as unknown as BusyEvent[],
  };
}
export async function calendarResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
) {
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: { code, message: "日历占用未能读取，请重试。", details: null },
        request_id: requestId,
      },
      { status },
    );
  if (request.method !== "GET") {
    const r = fail(405, "METHOD_NOT_ALLOWED");
    r.headers.set("Allow", "GET");
    return r;
  }
  const params = new URL(request.url).searchParams;
  const from = params.get("from"),
    to = params.get("to"),
    start_at = Number(from),
    end_at = Number(to);
  if (
    params.size !== 2 ||
    !from ||
    !to ||
    !/^\d{1,16}$/.test(from) ||
    !/^\d{1,16}$/.test(to) ||
    !Number.isSafeInteger(start_at) ||
    !Number.isSafeInteger(end_at) ||
    end_at <= start_at ||
    end_at > 8640000000000000 ||
    end_at - start_at > 31 * 86400000
  )
    return fail(422, "INVALID_RANGE");
  const snapshot = await calendarSnapshot(db, owner, { start_at, end_at });
  return Response.json({
    data: { schema_version: 1, from: start_at, to: end_at, ...snapshot },
    error: null,
    request_id: requestId,
  });
}
