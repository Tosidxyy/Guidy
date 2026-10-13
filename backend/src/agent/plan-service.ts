import type { D1Database } from "@cloudflare/workers-types";
import { boundedText } from "../http/bounded-text.ts";
import { slotsResponse } from "../slots.ts";
import {
  AgentError,
  deepseekProvider,
  type AgentEnv,
  type AgentProvider,
} from "./provider.ts";
import { checkedPlan } from "./plan-schema.ts";
import type { SearchSource } from "../research/search-provider.ts";

export async function planResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
  env: AgentEnv,
  provider?: AgentProvider,
): Promise<Response> {
  const goalId = new URL(request.url).pathname.split("/").at(-2)!;
  const dailyLimit = 3;
  const ok = (data: unknown, status = 200) =>
    Response.json({ data, error: null, request_id: requestId }, { status });
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: {
          code,
          message: "草稿未完成，请读取状态；不会自动重试模型或写日历。",
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
    .first();
  if (!goal) return fail(404, "NOT_FOUND");
  await db
    .prepare(
      "UPDATE plan_draft_attempts SET status='unknown',error_code='PLAN_RESULT_UNKNOWN' WHERE goal_id=? AND owner_id=? AND status='submitted' AND lease_until<=?",
    )
    .bind(goalId, owner, Date.now())
    .run();
  const snapshot = async () => ({
    daily_limit: dailyLimit,
    goal,
    attempts: (
      await db
        .prepare(
          "SELECT id,goal_revision,status,error_code,draft_json,context_json,input_tokens,output_tokens,created_at FROM plan_draft_attempts WHERE goal_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 10",
        )
        .bind(goalId, owner)
        .all()
    ).results.map((row) => ({
      ...row,
      draft_json: undefined,
      context_json: undefined,
      draft: row.draft_json ? JSON.parse(row.draft_json as string) : null,
      context: JSON.parse(row.context_json as string),
      billing_status: "reserved_unknown",
    })),
  });
  if (request.method === "GET") return ok(await snapshot());
  if (request.method !== "POST") {
    const r = fail(405, "METHOD_NOT_ALLOWED");
    r.headers.set("Allow", "GET, POST");
    return r;
  }
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    return fail(415, "INVALID_CONTENT_TYPE");
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY");
  let body;
  try {
    body = JSON.parse(await boundedText(request.body, 4096));
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !["search_ids", "expected_revision"].includes(k),
      ) ||
      !Number.isSafeInteger(body.expected_revision) ||
      body.expected_revision < 0 ||
      !Array.isArray(body.search_ids) ||
      body.search_ids.length < 1 ||
      body.search_ids.length > 3 ||
      new Set(body.search_ids).size !== body.search_ids.length ||
      body.search_ids.some(
        (id: unknown) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id),
      )
    )
      throw new Error();
  } catch {
    return fail(422, "INVALID_BODY");
  }
  body.search_ids.sort();
  const payload = JSON.stringify(body);
  const replay = async () => {
    const old = await db
      .prepare(
        "SELECT goal_id,request_payload,status FROM plan_draft_attempts WHERE owner_id=? AND request_key=?",
      )
      .bind(owner, key)
      .first();
    if (!old) return null;
    return old.goal_id !== goalId || old.request_payload !== payload
      ? fail(409, "IDEMPOTENCY_CONFLICT")
      : ok(await snapshot(), old.status === "submitted" ? 202 : 200);
  };
  const previous = await replay();
  if (previous) return previous;
  if (goal.status !== "draft" || goal.revision !== body.expected_revision)
    return fail(409, "CONTEXT_CHANGED");
  const conditions = await slotsResponse(
    new Request(request.url.replace(/plan-drafts$/, "slots")),
    db,
    owner,
    requestId,
  );
  const conditionData = (
    (await conditions.json()) as {
      data?: { readiness: { phase: string }; slots: unknown[] };
    }
  ).data;
  if (conditionData?.readiness.phase !== "research_preparation")
    return fail(409, "RESEARCH_NOT_READY");
  const sources: (SearchSource & {
    search_id: string;
    searched_at: number;
    provider_request_id: string;
  })[] = [];
  for (const searchId of body.search_ids) {
    const row = await db
      .prepare(
        "SELECT result_json FROM search_attempts WHERE id=? AND goal_id=? AND owner_id=? AND goal_revision=? AND status='succeeded'",
      )
      .bind(searchId, goalId, owner, body.expected_revision)
      .first();
    if (!row) return fail(422, "PLAN_INVALID_SOURCES");
    const result = JSON.parse(row.result_json as string);
    for (const s of result.sources as SearchSource[])
      if (
        s.content &&
        s.content_kind !== "snippet_only" &&
        !sources.some((old) => old.source_id === s.source_id) &&
        sources.length < 3
      )
        sources.push({
          ...s,
          content: s.content.slice(0, 900),
          search_id: searchId,
          searched_at: result.searched_at,
          provider_request_id: result.provider_request_id,
        });
  }
  if (!sources.length) return fail(422, "PLAN_INSUFFICIENT_EVIDENCE");
  const context = {
    schema_version: 1,
    goal: {
      description: String(goal.description || goal.title).slice(0, 1500),
      timeframe_note: String(goal.timeframe_note).slice(0, 300),
    },
    conditions: conditionData.slots,
    sources: sources.map((s, i) => ({ ...s, evidence_ref: `E${i + 1}` })),
  };
  const contextJson = JSON.stringify(context);
  if (contextJson.length > 8500) return fail(422, "PLAN_CONTEXT_TOO_LARGE");
  let model: AgentProvider;
  try {
    model = provider ?? deepseekProvider(env, undefined, "plan");
  } catch {
    return fail(503, "AI_NOT_CONFIGURED");
  }
  const id = crypto.randomUUID(),
    now = Date.now(),
    day = Math.floor(now / 86400000) * 86400000;
  const claimed = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO plan_draft_attempts(id,goal_id,owner_id,goal_revision,request_key,request_payload,context_json,status,created_at,lease_until) SELECT ?,id,owner_id,revision,?,?,?,'submitted',?,? FROM goals WHERE id=? AND owner_id=? AND status='draft' AND revision=? AND (SELECT count(*) FROM plan_draft_attempts WHERE goal_id=?)<10 AND (SELECT count(*) FROM plan_draft_usage WHERE owner_id=? AND created_at>=?)<? AND (SELECT count(*) FROM plan_draft_usage WHERE created_at>=?)<10 AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='policy')",
      )
      .bind(
        id,
        key,
        payload,
        contextJson,
        now,
        now + 45000,
        goalId,
        owner,
        body.expected_revision,
        goalId,
        owner,
        day,
        dailyLimit,
        day,
        goalId,
        owner,
      ),
    db
      .prepare(
        "INSERT INTO plan_draft_usage(id,owner_id,created_at) SELECT id,owner_id,created_at FROM plan_draft_attempts WHERE id=?",
      )
      .bind(id),
  ]);
  if (!claimed[0].meta.changes)
    return (await replay()) ?? fail(409, "PLAN_LIMIT_OR_BUSY");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AgentError("PLAN_RESULT_UNKNOWN"));
    }, 25000);
  });
  void timeout.catch(() => {});
  try {
    const completion = await Promise.race([
      model.complete(contextJson, controller.signal),
      timeout,
    ]);
    if (controller.signal.aborted) throw new AgentError("PLAN_RESULT_UNKNOWN");
    const draft = checkedPlan(completion.content, [
      ...sources.map((s) => s.source_id),
      ...sources.map((_, i) => `E${i + 1}`),
    ]);
    draft.tasks = draft.tasks.map((t) => ({
      ...t,
      evidence_ids: [
        ...new Set(
          t.evidence_ids.map((ref) => {
            const index = sources.findIndex((_, i) => `E${i + 1}` === ref);
            return index >= 0 ? sources[index].source_id : ref;
          }),
        ),
      ],
    }));
    const saved = await db
      .prepare(
        "UPDATE plan_draft_attempts SET status='succeeded',draft_json=?,input_tokens=?,output_tokens=? WHERE id=? AND owner_id=? AND status='submitted' AND lease_until>? AND EXISTS(SELECT 1 FROM goals WHERE id=goal_id AND owner_id=? AND status='draft' AND revision=?) AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=plan_draft_attempts.goal_id AND owner_id=plan_draft_attempts.owner_id AND status='succeeded' AND json_extract(reply_json,'$.source')='policy')",
      )
      .bind(
        JSON.stringify(draft),
        completion.inputTokens,
        completion.outputTokens,
        id,
        owner,
        Date.now(),
        owner,
        body.expected_revision,
      )
      .run();
    if (!saved.meta.changes) throw new AgentError("CONTEXT_CHANGED");
    return ok(await snapshot(), 201);
  } catch (error) {
    const code =
      error instanceof AgentError ? error.code : "PLAN_RESULT_UNKNOWN";
    const status =
      [
        "PLAN_INVALID_DRAFT",
        "AI_CREDENTIAL_INVALID",
        "AI_BALANCE_REQUIRED",
        "AI_RATE_LIMITED",
      ].includes(code) ||
      code.startsWith("PLAN_INVALID_") ||
      code.startsWith("PLAN_SCHEMA_") ||
      code === "PLAN_UNSAFE_CONTENT"
        ? "failed"
        : "unknown";
    await db
      .prepare(
        "UPDATE plan_draft_attempts SET status=?,error_code=? WHERE id=? AND owner_id=? AND status='submitted'",
      )
      .bind(status, code, id, owner)
      .run();
    return fail(code === "CONTEXT_CHANGED" ? 409 : 502, code);
  } finally {
    clearTimeout(timer!);
  }
}
