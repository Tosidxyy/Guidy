import type { D1Database } from "@cloudflare/workers-types";
import { boundedText } from "../http/bounded-text.ts";
import { slotsResponse } from "../slots.ts";
import {
  doubaoSearchProvider,
  SearchError,
  searchQuery,
  type SearchProvider,
  type SearchEnv,
} from "./search-provider.ts";

export async function searchResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
  env: SearchEnv,
  provider: SearchProvider = doubaoSearchProvider(env),
): Promise<Response> {
  const goalId = new URL(request.url).pathname.split("/").at(-2)!;
  const ok = (data: unknown, status = 200) =>
    Response.json({ data, error: null, request_id: requestId }, { status });
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: {
          code,
          message: "搜索未完成，请查看状态；结果不明时不会自动重复搜索。",
          details: null,
        },
        request_id: requestId,
      },
      { status },
    );
  const goal = await db
    .prepare("SELECT id,revision,status FROM goals WHERE id=? AND owner_id=?")
    .bind(goalId, owner)
    .first();
  if (!goal) return fail(404, "NOT_FOUND");
  await db
    .prepare(
      "UPDATE search_attempts SET status='unknown',error_code='SEARCH_RESULT_UNKNOWN' WHERE goal_id=? AND owner_id=? AND status='submitted' AND lease_until<=?",
    )
    .bind(goalId, owner, Date.now())
    .run();
  const snapshot = async () => ({
    goal,
    attempts: (
      await db
        .prepare(
          "SELECT id,goal_revision,query,provider,status,billing_status,result_json,error_code,created_at FROM search_attempts WHERE goal_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 20",
        )
        .bind(goalId, owner)
        .all()
    ).results.map((row) => ({
      ...row,
      result_json: undefined,
      result: row.result_json ? JSON.parse(row.result_json as string) : null,
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
  let body, query;
  try {
    body = JSON.parse(await boundedText(request.body, 4096));
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !["query", "expected_revision"].includes(k),
      ) ||
      !Number.isSafeInteger(body.expected_revision) ||
      body.expected_revision < 0
    )
      throw new Error();
    query = searchQuery(body.query);
  } catch {
    return fail(422, "SEARCH_QUERY_REJECTED");
  }
  const replay = async () => {
    const old = await db
      .prepare(
        "SELECT goal_id,goal_revision,query,status FROM search_attempts WHERE owner_id=? AND request_key=?",
      )
      .bind(owner, key)
      .first();
    if (!old) return null;
    return old.goal_id !== goalId ||
      old.goal_revision !== body.expected_revision ||
      old.query !== query
      ? fail(409, "IDEMPOTENCY_CONFLICT")
      : ok(await snapshot(), old.status === "submitted" ? 202 : 200);
  };
  const previous = await replay();
  if (previous) return previous;
  if (!env.DOUBAO_SEARCH_API_KEY?.trim())
    return fail(503, "SEARCH_NOT_CONFIGURED");
  if (goal.status !== "draft" || goal.revision !== body.expected_revision)
    return fail(409, "CONTEXT_CHANGED");
  const readiness = await slotsResponse(
    new Request(request.url.replace(/search-runs$/, "slots")),
    db,
    owner,
    requestId,
  );
  if (
    ((await readiness.json()) as { data?: { readiness?: { phase: string } } })
      .data?.readiness?.phase !== "research_preparation"
  )
    return fail(409, "RESEARCH_NOT_READY");
  const id = crypto.randomUUID(),
    now = Date.now(),
    day = Math.floor(now / 86400000) * 86400000;
  // A reservation is durable BEFORE the external call. Unknown billing never refunds limits.
  const claimStatement = db
    .prepare(
      "INSERT OR IGNORE INTO search_attempts(id,goal_id,owner_id,goal_revision,request_key,query,provider,status,created_at,lease_until) SELECT ?,id,owner_id,revision,?,?,'doubao-custom','submitted',?,? FROM goals WHERE id=? AND owner_id=? AND status='draft' AND revision=? AND (SELECT count(*) FROM search_attempts WHERE goal_id=? AND goal_revision=?)<3 AND (SELECT count(*) FROM search_usage WHERE owner_id=? AND created_at>=?)<6 AND (SELECT count(*) FROM search_usage WHERE created_at>=?)<30 AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='policy')",
    )
    .bind(
      id,
      key,
      query,
      now,
      now + 30000,
      goalId,
      owner,
      body.expected_revision,
      goalId,
      body.expected_revision,
      owner,
      day,
      day,
      goalId,
      owner,
    );
  const [claim] = await db.batch([
    claimStatement,
    db
      .prepare(
        "INSERT INTO search_usage(id,owner_id,created_at) SELECT id,owner_id,created_at FROM search_attempts WHERE id=?",
      )
      .bind(id),
  ]);
  if (!claim.meta.changes)
    return (await replay()) ?? fail(409, "SEARCH_LIMIT_OR_BUSY");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SearchError("SEARCH_RESULT_UNKNOWN"));
    }, 12000);
  });
  void timeout.catch(() => {});
  try {
    const result = await Promise.race([
      provider.search(query, controller.signal),
      timeout,
    ]);
    if (controller.signal.aborted)
      throw new SearchError("SEARCH_RESULT_UNKNOWN");
    const saved = await db
      .prepare(
        "UPDATE search_attempts SET status='succeeded',result_json=? WHERE id=? AND owner_id=? AND status='submitted' AND lease_until>? AND EXISTS(SELECT 1 FROM goals WHERE id=goal_id AND owner_id=? AND status='draft' AND revision=?)",
      )
      .bind(
        JSON.stringify(result),
        id,
        owner,
        Date.now(),
        owner,
        body.expected_revision,
      )
      .run();
    if (!saved.meta.changes) throw new SearchError("CONTEXT_CHANGED");
    return ok(await snapshot(), 201);
  } catch (error) {
    const code =
      error instanceof SearchError ? error.code : "SEARCH_RESULT_UNKNOWN";
    const status = [
      "SEARCH_ACCESS_DENIED",
      "SEARCH_QUOTA_EXHAUSTED",
      "SEARCH_RATE_LIMITED",
    ].includes(code)
      ? "failed"
      : "unknown";
    await db
      .prepare(
        "UPDATE search_attempts SET status=?,error_code=? WHERE id=? AND owner_id=? AND status='submitted'",
      )
      .bind(status, code, id, owner)
      .run();
    return fail(code === "CONTEXT_CHANGED" ? 409 : 502, code);
  } finally {
    clearTimeout(timer!);
  }
}
