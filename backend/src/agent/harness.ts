import type { D1Database } from "@cloudflare/workers-types";
import { checkedSuggestions, type SlotSuggestion } from "./suggestions.ts";
import {
  AgentError,
  deepseekProvider,
  type AgentEnv,
  type AgentProvider,
} from "./provider.ts";

type Reply = {
  schema_version: 1;
  kind: "question" | "referral";
  question: string;
  reason: string;
  source: "deepseek" | "policy";
  suggestions?: SlotSuggestion[];
};
function validateReply(content: string, userText: string): Reply {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new AgentError("AI_INVALID_RESPONSE");
  }
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (k) => !["question", "reason", "suggestions"].includes(k),
    ) ||
    typeof value.question !== "string" ||
    !value.question.trim() ||
    value.question.length > 240 ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    value.reason.length > 160 ||
    (value.question.match(/[?？]/g)?.length ?? 0) !== 1
  )
    throw new AgentError("AI_INVALID_RESPONSE");
  if (
    /已安排|已写入|已购买|已完成研究|自行(?:停药|加药)|\d+\s*(?:毫克|mg)/i.test(
      value.question + value.reason,
    )
  )
    throw new AgentError("AI_INVALID_RESPONSE");
  return {
    schema_version: 1,
    kind: "question",
    question: value.question.trim(),
    reason: value.reason.trim(),
    source: "deepseek",
    suggestions: checkedSuggestions(value.suggestions, userText),
  };
}
export async function dialogueResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
  env: AgentEnv,
  provider?: AgentProvider,
): Promise<Response> {
  const goalId = new URL(request.url).pathname.split("/").at(-2)!;
  const now = Date.now();
  const ok = (data: unknown, status = 200) =>
    Response.json({ data, error: null, request_id: requestId }, { status });
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: {
          code,
          message: "AI 澄清未完成，请检查状态后重试。",
          details: null,
        },
        request_id: requestId,
      },
      { status },
    );
  const goal = await db
    .prepare(
      "SELECT id,title,description,timeframe_note,status,revision FROM goals WHERE id=? AND owner_id=?",
    )
    .bind(goalId, owner)
    .first<Record<string, unknown>>();
  if (!goal) return fail(404, "NOT_FOUND");
  // Expiration settles a stale attempt; it never restarts a paid model request.
  await db
    .prepare(
      "UPDATE agent_runs SET status='failed',error_code='AI_TIMEOUT',updated_at=? WHERE goal_id=? AND owner_id=? AND status='running' AND lease_until<=?",
    )
    .bind(now, goalId, owner, now)
    .run();
  const columns =
    "id,turn_index,user_text,status,reply_json,error_code,input_tokens,output_tokens,requested_model,context_schema_version,harness_version,goal_revision,created_at";
  const snapshot = async () => {
    const rows = await db
      .prepare(
        `SELECT ${columns} FROM agent_runs WHERE goal_id=? AND owner_id=? ORDER BY turn_index DESC LIMIT 30`,
      )
      .bind(goalId, owner)
      .all();
    return {
      goal,
      chat_revision: rows.results[0]?.turn_index ?? 0,
      runs: rows.results.reverse().map((r) => ({
        ...r,
        reply_json: undefined,
        reply: r.reply_json ? JSON.parse(r.reply_json as string) : null,
      })),
    };
  };
  if (request.method === "GET") return ok(await snapshot());
  if (request.method !== "POST") {
    const response = fail(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "GET, POST");
    return response;
  }
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    return fail(415, "INVALID_CONTENT_TYPE");
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 4096) {
        await reader.cancel();
        return fail(413, "BODY_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  let text: string;
  let chatRevision: number;
  let goalRevision: number;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) =>
          ![
            "text",
            "expected_chat_revision",
            "expected_goal_revision",
          ].includes(k),
      ) ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 600 ||
      !Number.isSafeInteger(body.expected_chat_revision) ||
      body.expected_chat_revision < 0 ||
      !Number.isSafeInteger(body.expected_goal_revision) ||
      body.expected_goal_revision < 0
    )
      throw new Error();
    text = body.text.trim();
    chatRevision = body.expected_chat_revision;
    goalRevision = body.expected_goal_revision;
  } catch {
    return fail(422, "INVALID_BODY");
  }
  const payload = JSON.stringify({ text, chatRevision, goalRevision });
  const previous = await db
    .prepare(
      "SELECT id,goal_id,request_payload,status FROM agent_runs WHERE owner_id=? AND request_key=?",
    )
    .bind(owner, key)
    .first();
  if (previous) {
    if (previous.goal_id !== goalId || previous.request_payload !== payload)
      return fail(409, "IDEMPOTENCY_CONFLICT");
    return ok(await snapshot(), previous.status === "running" ? 202 : 200);
  }
  if (goal.status !== "draft" || goal.revision !== goalRevision)
    return fail(409, "CONTEXT_CHANGED");
  let model: AgentProvider;
  try {
    model = provider ?? deepseekProvider(env);
  } catch {
    return fail(503, "AI_NOT_CONFIGURED");
  }
  const id = crypto.randomUUID();
  const day = Math.floor(now / 86400000) * 86400000;
  const claimed = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'running','clarify-v2',?,?,? FROM goals WHERE id=? AND owner_id=? AND status='draft' AND revision=? AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=?)=? AND (SELECT count(*) FROM agent_runs WHERE owner_id=? AND created_at>=?)<8 AND (SELECT count(*) FROM agent_runs WHERE created_at>=?)<20`,
      )
      .bind(
        id,
        key,
        payload,
        chatRevision + 1,
        text,
        now,
        now,
        now + 45000,
        goalId,
        owner,
        goalRevision,
        goalId,
        chatRevision,
        owner,
        day,
        day,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'user',user_text,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
  ]);
  if (!claimed[0].meta.changes) {
    const duplicate = await db
      .prepare(
        "SELECT goal_id,request_payload,status FROM agent_runs WHERE owner_id=? AND request_key=?",
      )
      .bind(owner, key)
      .first();
    if (duplicate) {
      if (duplicate.goal_id !== goalId || duplicate.request_payload !== payload)
        return fail(409, "IDEMPOTENCY_CONFLICT");
      return ok(await snapshot(), duplicate.status === "running" ? 202 : 200);
    }
    const counts = await db
      .prepare(
        "SELECT count(*) AS total,sum(CASE WHEN owner_id=? THEN 1 ELSE 0 END) AS personal FROM agent_runs WHERE created_at>=?",
      )
      .bind(owner, day)
      .first();
    return Number(counts?.total) >= 20 || Number(counts?.personal) >= 8
      ? fail(429, "AI_DAILY_LIMIT")
      : fail(409, "CONVERSATION_CHANGED");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AgentError("AI_TIMEOUT"));
    }, 20000);
  });
  void timeout.catch(() => {});
  try {
    const contextRows = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          "SELECT title,description,timeframe_note,status,revision FROM goals WHERE id=? AND owner_id=?",
        )
        .bind(goalId, owner),
      db
        .prepare(
          "SELECT key,value_json FROM goal_slots WHERE goal_id=? ORDER BY key",
        )
        .bind(goalId),
      db
        .prepare(
          "SELECT user_text,reply_json FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' ORDER BY turn_index DESC LIMIT 2",
        )
        .bind(goalId, owner),
    ]);
    const contextGoal = contextRows[0].results[0];
    const slots = contextRows[1];
    const history = contextRows[2];
    if (
      !contextGoal ||
      contextGoal.revision !== goalRevision ||
      contextGoal.status !== "draft"
    )
      throw new AgentError("CONTEXT_CHANGED");
    const context = JSON.stringify({
      goal: {
        description: contextGoal.description || contextGoal.title,
        timeframe: contextGoal.timeframe_note,
      },
      confirmed_conditions: slots.results.map((s) => ({
        key: s.key,
        value: JSON.parse(s.value_json as string),
      })),
      recent_dialogue: history.results.reverse().map((r) => ({
        user: r.user_text,
        assistant: (() => {
          const rply = JSON.parse(r.reply_json as string);
          return {
            question: rply.question,
            reason: rply.reason,
            source: rply.source,
          };
        })(),
      })),
      user_message: text,
    });
    if (context.length > 5000) throw new AgentError("CONTEXT_TOO_LARGE");
    await db
      .prepare(
        "UPDATE agent_runs SET context_json=? WHERE id=? AND owner_id=? AND status='running'",
      )
      .bind(context, id, owner)
      .run();
    let reply: Reply;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    // Safety is based on user facts, never on an assistant's hypothetical question.
    const policyInput = JSON.stringify({
      goal,
      slots: slots.results,
      users: history.results.map((r) => r.user_text),
      text,
    }).replace(/没有(?:已知)?伤病|无伤病/g, "");
    if (
      /处方|停药|减药|增药|药物剂量|药量|诊断|自杀|自残|伤害他人|伤病|怀孕|糖尿病|心脏病/i.test(
        policyInput,
      )
    )
      reply = {
        schema_version: 1,
        kind: "referral",
        question:
          "这涉及需要专业人员判断的问题。请先咨询相应专业人员，再确认适合你的日常目标。",
        reason: "当前不会提供诊断、处方调整或高风险行动建议。",
        source: "policy",
      };
    else {
      const completion = await Promise.race([
        model.complete(context, controller.signal),
        timeout,
      ]);
      reply = validateReply(completion.content, text);
      inputTokens = completion.inputTokens;
      outputTokens = completion.outputTokens;
      const normalized = (s: string) => s.replace(/[\s，。?？!！]/g, "");
      if (
        history.results.some(
          (r) =>
            normalized(JSON.parse(r.reply_json as string).question) ===
            normalized(reply.question),
        )
      )
        throw new AgentError("AI_REPEATED_QUESTION");
    }
    if (controller.signal.aborted) throw new AgentError("AI_TIMEOUT");
    const completed = Date.now();
    await db.batch([
      db
        .prepare(
          "UPDATE agent_runs SET status='succeeded',reply_json=?,input_tokens=?,output_tokens=?,updated_at=? WHERE id=? AND owner_id=? AND status='running' AND lease_until>? AND EXISTS(SELECT 1 FROM goals WHERE id=goal_id AND owner_id=? AND status='draft' AND revision=?)",
        )
        .bind(
          JSON.stringify(reply),
          inputTokens,
          outputTokens,
          completed,
          id,
          owner,
          completed,
          owner,
          goalRevision,
        ),
      db
        .prepare(
          "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'assistant',reply_json,updated_at FROM agent_runs WHERE id=? AND owner_id=? AND status='succeeded'",
        )
        .bind(crypto.randomUUID(), id, owner),
    ]);
    const result = await db
      .prepare("SELECT status FROM agent_runs WHERE id=? AND owner_id=?")
      .bind(id, owner)
      .first();
    if (result?.status !== "succeeded") throw new AgentError("CONTEXT_CHANGED");
    return ok(await snapshot());
  } catch (error) {
    const code = error instanceof AgentError ? error.code : "AI_UNAVAILABLE";
    await db
      .prepare(
        "UPDATE agent_runs SET status='failed',error_code=?,updated_at=? WHERE id=? AND owner_id=? AND status='running'",
      )
      .bind(code, Date.now(), id, owner)
      .run();
    return fail(code === "CONTEXT_CHANGED" ? 409 : 502, code);
  } finally {
    clearTimeout(timer!);
  }
}
