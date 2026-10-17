import type { D1Database } from "@cloudflare/workers-types";
import {
  AgentError,
  deepseekProvider,
  type AgentEnv,
  type AgentProvider,
} from "./provider.ts";
import { boundedText } from "../http/bounded-text.ts";
import { checkedEvent, type EventInput } from "../scheduling/events.ts";

export type DiscussionReply = {
  kind: "reply" | "event" | "revision";
  message: string;
  event: EventInput | null;
  revision: string | null;
};
export function compileDiscussion(
  content: string,
  now = Date.now(),
): DiscussionReply {
  let value;
  try {
    value = JSON.parse(content);
    if (value?.kind === "event") {
      const e = value.event;
      if (
        !e ||
        Object.keys(e).sort().join(",") !==
          "date,end_time,start_time,timezone,title" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(e.date) ||
        ![e.start_time, e.end_time].every(
          (t) => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t),
        ) ||
        !["UTC", "Asia/Shanghai"].includes(e.timezone)
      )
        throw Error();
      const offset = e.timezone === "UTC" ? 0 : 28800000;
      const midnight = Date.parse(e.date + "T00:00:00Z");
      if (
        !Number.isFinite(midnight) ||
        new Date(midnight).toISOString().slice(0, 10) !== e.date
      )
        throw Error();
      const at = (t: string) =>
        midnight -
        offset +
        (Number(t.slice(0, 2)) * 60 + Number(t.slice(3))) * 60000;
      value.event = {
        title: e.title,
        start_at: at(e.start_time),
        end_at: at(e.end_time),
        timezone: e.timezone,
      };
    }
  } catch {
    throw new AgentError("AI_INVALID_RESPONSE");
  }
  return checkedDiscussion(JSON.stringify(value), now);
}
export function checkedDiscussion(
  content: string,
  now = Date.now(),
): DiscussionReply {
  let r: DiscussionReply;
  try {
    r = JSON.parse(content);
  } catch {
    throw new AgentError("AI_INVALID_RESPONSE");
  }
  if (
    !r ||
    Object.keys(r).sort().join(",") !== "event,kind,message,revision" ||
    !["reply", "event", "revision"].includes(r.kind) ||
    typeof r.message !== "string" ||
    !r.message.trim() ||
    r.message.length > 240 ||
    /已(?:添加|安排|写入|修改|更新)|保证(?:成功|治愈)|自行(?:停药|加药)|\d+\s*(?:毫克|mg)/i.test(
      JSON.stringify(r),
    )
  )
    throw new AgentError("AI_INVALID_RESPONSE");
  if (r.kind === "event") {
    try {
      r.event = checkedEvent(r.event, now);
    } catch {
      throw new AgentError("AI_INVALID_RESPONSE");
    }
  } else if (r.event !== null) throw new AgentError("AI_INVALID_RESPONSE");
  if (r.kind === "revision") {
    if (
      typeof r.revision !== "string" ||
      !r.revision.trim() ||
      r.revision.length > 400
    )
      throw new AgentError("AI_INVALID_RESPONSE");
  } else if (r.revision !== null) throw new AgentError("AI_INVALID_RESPONSE");
  return r;
}
export async function conversationResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
  env: AgentEnv,
  provider?: AgentProvider,
) {
  const goalId = new URL(request.url).pathname.split("/").at(-2)!;
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: { code, message: "讨论暂未完成，你的消息仍保留。" },
        request_id: requestId,
      },
      { status },
    );
  const goal = await db
    .prepare(
      "SELECT id,description,title,status,revision FROM goals WHERE id=? AND owner_id=?",
    )
    .bind(goalId, owner)
    .first();
  if (!goal) return fail(404, "NOT_FOUND");
  const read = async () => {
    const rows = await db
      .prepare(
        "SELECT id,user_text,status,reply_json,error_code,goal_revision,base_attempt_id,created_at,(SELECT event_id FROM calendar_event_receipts e WHERE e.owner_id=conversation_turns.owner_id AND json_extract(e.request_payload,'$.proposal_id')=conversation_turns.id LIMIT 1) saved_event_id FROM conversation_turns WHERE goal_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 60",
      )
      .bind(goalId, owner)
      .all();
    return Response.json({
      data: {
        turns: rows.results.reverse().map(({ reply_json, ...r }) => ({
          ...r,
          reply: reply_json ? JSON.parse(String(reply_json)) : null,
        })),
      },
      error: null,
      request_id: requestId,
    });
  };
  // A read can settle an expired lease but can never restart a model invocation.
  await db
    .prepare(
      "UPDATE conversation_turns SET status='failed',error_code='AI_TIMEOUT' WHERE goal_id=? AND owner_id=? AND status='running' AND created_at<?",
    )
    .bind(goalId, owner, Date.now() - 45000)
    .run();
  if (request.method === "GET") return read();
  if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED");
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    return fail(415, "INVALID_CONTENT_TYPE");
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY");
  let body: { text: string; expected_goal_revision: number };
  try {
    body = JSON.parse(await boundedText(request.body, 4096));
    if (
      !body ||
      Object.keys(body).sort().join(",") !== "expected_goal_revision,text" ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 600 ||
      !Number.isSafeInteger(body.expected_goal_revision)
    )
      throw Error();
  } catch {
    return fail(422, "INVALID_BODY");
  }
  const payload = JSON.stringify(body),
    prior = await db
      .prepare(
        "SELECT request_payload,goal_id FROM conversation_turns WHERE owner_id=? AND request_key=?",
      )
      .bind(owner, key)
      .first();
  if (prior)
    return prior.request_payload === payload && prior.goal_id === goalId
      ? read()
      : fail(409, "IDEMPOTENCY_CONFLICT");
  if (
    goal.revision !== body.expected_goal_revision ||
    !["draft", "active"].includes(String(goal.status))
  )
    return fail(409, "CONTEXT_CHANGED");
  const source = await db
    .prepare(
      "SELECT id,draft_json FROM plan_draft_attempts WHERE goal_id=? AND owner_id=? AND status='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(goalId, owner)
    .first();
  if (!source) return fail(409, "STRATEGY_REQUIRED");
  if (
    await db
      .prepare(
        "SELECT 1 FROM agent_runs WHERE goal_id=? AND owner_id=? AND json_extract(reply_json,'$.source')='policy'",
      )
      .bind(goalId, owner)
      .first()
  )
    return fail(422, "POLICY_BLOCKED");
  const now = Date.now(),
    day = Math.floor(now / 86400000) * 86400000,
    id = crypto.randomUUID();
  // Reservation is durable, atomic and budgeted even when the upstream outcome is unknown.
  const reserved = await db
    .prepare(
      "INSERT INTO conversation_turns(id,owner_id,goal_id,request_key,request_payload,goal_revision,base_attempt_id,user_text,status,created_at) SELECT ?,?,?,?,?,?,?,?,'running',? WHERE EXISTS(SELECT 1 FROM goals WHERE id=? AND owner_id=? AND revision=? AND status IN ('draft','active')) AND NOT EXISTS(SELECT 1 FROM conversation_turns WHERE goal_id=? AND status='running') AND NOT EXISTS(SELECT 1 FROM planning_jobs WHERE goal_id=? AND status NOT IN ('completed','failed','unknown')) AND (SELECT count(*) FROM conversation_turns WHERE owner_id=? AND created_at>=?)<20 AND (SELECT count(*) FROM conversation_turns WHERE created_at>=?)<60 AND (SELECT count(*) FROM conversation_turns WHERE goal_id=?)<60",
    )
    .bind(
      id,
      owner,
      goalId,
      key,
      payload,
      goal.revision,
      source.id,
      body.text.trim(),
      now,
      goalId,
      owner,
      goal.revision,
      goalId,
      goalId,
      owner,
      day,
      day,
      goalId,
    )
    .run();
  if (!reserved.meta.changes) return fail(409, "DISCUSSION_LIMIT_OR_BUSY");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 25000);
  try {
    const history = await db
      .prepare(
        "SELECT user_text,reply_json FROM conversation_turns WHERE goal_id=? AND owner_id=? AND status='succeeded' ORDER BY created_at DESC LIMIT 8",
      )
      .bind(goalId, owner)
      .all();
    let reply: DiscussionReply;
    if (
      /处方|停药|减药|增药|药物剂量|药量|诊断|自杀|自残|伤害他人/i.test(
        body.text,
      )
    )
      reply = {
        kind: "reply",
        message:
          "这项内容需要专业人员判断。我们可以继续讨论不涉及诊断或治疗的日常安排。",
        event: null,
        revision: null,
      };
    else {
      const context = JSON.stringify({
        now,
        current_date: new Date(now + 28800000).toISOString().slice(0, 10),
        timezone: "Asia/Shanghai",
        goal,
        draft: JSON.parse(String(source.draft_json)),
        history: history.results.reverse(),
        user_message: body.text,
        capabilities: ["reply", "propose_event", "propose_revision"],
      });
      if (context.length > 14000) throw new AgentError("CONTEXT_TOO_LARGE");
      const completion = await (
        provider ?? deepseekProvider(env, undefined, "discussion")
      ).complete(context, controller.signal);
      reply = compileDiscussion(completion.content);
    }
    if (controller.signal.aborted) throw new AgentError("AI_TIMEOUT");
    const saved = await db
      .prepare(
        "UPDATE conversation_turns SET status='succeeded',reply_json=? WHERE id=? AND status='running' AND EXISTS(SELECT 1 FROM goals WHERE id=? AND owner_id=? AND revision=? AND status IN ('draft','active')) AND ?=(SELECT id FROM plan_draft_attempts WHERE goal_id=? AND owner_id=? AND status='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1) AND NOT EXISTS(SELECT 1 FROM planning_jobs WHERE goal_id=? AND status NOT IN ('completed','failed','unknown'))",
      )
      .bind(
        JSON.stringify(reply),
        id,
        goalId,
        owner,
        goal.revision,
        source.id,
        goalId,
        owner,
        goalId,
      )
      .run();
    if (!saved.meta.changes) throw new AgentError("CONTEXT_CHANGED");
    return read();
  } catch (e) {
    const code = e instanceof AgentError ? e.code : "AI_UNAVAILABLE";
    await db
      .prepare(
        "UPDATE conversation_turns SET status='failed',error_code=? WHERE id=? AND status='running'",
      )
      .bind(code, id)
      .run();
    return fail(502, code);
  } finally {
    clearTimeout(timer);
  }
}
