import type { D1Database } from "@cloudflare/workers-types";
import { boundedText } from "../http/bounded-text.ts";

export type EventInput = {
  title: string;
  start_at: number;
  end_at: number;
  timezone: "Asia/Shanghai" | "UTC";
};
export function checkedEvent(value: unknown, now = Date.now()): EventInput {
  const e = value as EventInput;
  if (
    !e ||
    Object.keys(e).sort().join(",") !== "end_at,start_at,timezone,title" ||
    typeof e.title !== "string" ||
    !e.title.trim() ||
    e.title.length > 80 ||
    ![e.start_at, e.end_at].every(Number.isSafeInteger) ||
    e.start_at < now ||
    e.start_at > now + 366 * 86400000 ||
    e.end_at - e.start_at < 60000 ||
    e.end_at - e.start_at > 86400000 ||
    !["Asia/Shanghai", "UTC"].includes(e.timezone)
  )
    throw new Error("INVALID_EVENT");
  return { ...e, title: e.title.trim() };
}
export async function createEventResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
) {
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: { code, message: "日程未保存，请核对时间或刷新日历。" },
        request_id: requestId,
      },
      { status },
    );
  const ok = (event: unknown, revision: number) =>
    Response.json({
      data: { event, revision },
      error: null,
      request_id: requestId,
    });
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY");
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    return fail(415, "INVALID_CONTENT_TYPE");
  let body: {
    event: EventInput;
    expected_revision: number;
    proposal_id?: string;
  };
  try {
    body = JSON.parse(await boundedText(request.body, 4096));
    if (
      !body ||
      Object.keys(body).some(
        (k) => !["event", "expected_revision", "proposal_id"].includes(k),
      ) ||
      !Number.isSafeInteger(body.expected_revision) ||
      body.expected_revision < 0 ||
      (body.proposal_id !== undefined &&
        !/^[0-9a-f-]{36}$/.test(body.proposal_id))
    )
      throw Error();
  } catch {
    return fail(422, "INVALID_BODY");
  }
  const payload = JSON.stringify(body);
  const prior = await db
    .prepare(
      "SELECT * FROM calendar_event_receipts WHERE owner_id=? AND request_key=?",
    )
    .bind(owner, key)
    .first();
  if (prior) {
    if (prior.request_payload !== payload)
      return fail(409, "IDEMPOTENCY_CONFLICT");
    const event = await db
      .prepare(
        "SELECT id,title,start_at,end_at,timezone FROM calendar_events WHERE id=? AND owner_id=?",
      )
      .bind(prior.event_id, owner)
      .first();
    return ok(event, Number(prior.revision));
  }
  let event: EventInput;
  try {
    event = checkedEvent(body.event);
  } catch {
    return fail(422, "INVALID_EVENT");
  }
  let proposalGoal: string | null = null;
  if (body.proposal_id) {
    const p = await db
      .prepare(
        "SELECT c.reply_json,c.goal_id FROM conversation_turns c JOIN goals g ON g.id=c.goal_id AND g.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=? AND c.status='succeeded' AND c.goal_revision=g.revision AND g.status IN ('draft','active')",
      )
      .bind(body.proposal_id, owner)
      .first();
    if (
      !p ||
      JSON.stringify(JSON.parse(String(p.reply_json)).event) !==
        JSON.stringify(body.event)
    )
      return fail(409, "PROPOSAL_CHANGED");
    proposalGoal = String(p.goal_id);
  }
  const id = crypto.randomUUID(),
    now = Date.now();
  // All guards are repeated inside the insert; D1 batch is the transaction boundary.
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO calendar_events(id,owner_id,title,start_at,end_at,timezone,source_goal_id,created_at) SELECT ?,?,?,?,?,?,?,? WHERE coalesce((SELECT revision FROM calendar_states WHERE owner_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM calendar_events WHERE owner_id=? AND start_at<? AND end_at>?) AND NOT EXISTS(SELECT 1 FROM scheduled_occurrences WHERE owner_id=? AND status='scheduled' AND start_at<? AND end_at>?) AND (? IS NULL OR EXISTS(SELECT 1 FROM conversation_turns c JOIN goals g ON g.id=c.goal_id AND g.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=? AND c.status='succeeded' AND c.goal_revision=g.revision AND g.status IN ('draft','active'))) ",
      )
      .bind(
        id,
        owner,
        event.title,
        event.start_at,
        event.end_at,
        event.timezone,
        proposalGoal,
        now,
        owner,
        body.expected_revision,
        owner,
        event.end_at,
        event.start_at,
        owner,
        event.end_at,
        event.start_at,
        body.proposal_id ?? null,
        body.proposal_id ?? null,
        owner,
      ),
    db
      .prepare(
        "INSERT INTO calendar_event_receipts(owner_id,request_key,request_payload,event_id,revision) SELECT owner_id,?,?,id,? FROM calendar_events WHERE id=?",
      )
      .bind(key, payload, body.expected_revision + 1, id),
    db
      .prepare(
        "INSERT INTO calendar_states(owner_id,revision) SELECT owner_id,? FROM calendar_events WHERE id=? ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision",
      )
      .bind(body.expected_revision + 1, id),
  ]);
  const saved = await db
    .prepare(
      "SELECT id,title,start_at,end_at,timezone FROM calendar_events WHERE id=? AND owner_id=?",
    )
    .bind(id, owner)
    .first();
  if (!saved) {
    const state = await db
      .prepare("SELECT revision FROM calendar_states WHERE owner_id=?")
      .bind(owner)
      .first();
    return fail(
      409,
      Number(state?.revision ?? 0) !== body.expected_revision
        ? "CALENDAR_CHANGED"
        : "EVENT_CONFLICT",
    );
  }
  return ok(saved, body.expected_revision + 1);
}
