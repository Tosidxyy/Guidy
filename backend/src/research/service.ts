import type { D1Database } from "@cloudflare/workers-types";
import {
  boundedText,
  ResearchError,
  sourceUrl,
  webProvider,
  type ResearchProvider,
} from "./provider.ts";
export async function researchResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
  provider: ResearchProvider = webProvider(),
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
          message: "资料读取未完成，请核对来源或重新读取状态。",
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
      "UPDATE research_evidence SET status='failed',error_code='SOURCE_TIMEOUT' WHERE goal_id=? AND owner_id=? AND status='fetching' AND lease_until<=?",
    )
    .bind(goalId, owner, now)
    .run();
  const snapshot = async () => ({
    goal,
    evidence: (
      await db
        .prepare(
          "SELECT id,goal_revision,source_url,claim,caveat,status,verification_status,title,excerpt,error_code,retrieved_at,created_at FROM research_evidence WHERE goal_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 20",
        )
        .bind(goalId, owner)
        .all()
    ).results,
  });
  if (request.method === "GET") return ok(await snapshot());
  if (request.method !== "POST") {
    const response = fail(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "GET, POST");
    return response;
  }
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY");
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    return fail(415, "INVALID_CONTENT_TYPE");
  let body;
  try {
    body = JSON.parse(await boundedText(request.body, 8192));
  } catch {
    return fail(422, "INVALID_BODY");
  }
  if (
    !body ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (k) => !["url", "claim", "caveat", "expected_revision"].includes(k),
    ) ||
    typeof body.url !== "string" ||
    typeof body.claim !== "string" ||
    !body.claim.trim() ||
    body.claim.length > 300 ||
    typeof body.caveat !== "string" ||
    body.caveat.length > 300 ||
    !Number.isSafeInteger(body.expected_revision) ||
    body.expected_revision < 0
  )
    return fail(422, "INVALID_BODY");
  let url;
  try {
    url = sourceUrl(body.url);
  } catch {
    return fail(422, "SOURCE_URL_REJECTED");
  }
  const payload = JSON.stringify({
    url,
    claim: body.claim.trim(),
    caveat: body.caveat.trim(),
    revision: body.expected_revision,
  });
  const replay = async () => {
    const previous = await db
      .prepare(
        "SELECT goal_id,request_payload,status FROM research_evidence WHERE owner_id=? AND request_key=?",
      )
      .bind(owner, key)
      .first();
    if (!previous) return null;
    return previous.goal_id !== goalId || previous.request_payload !== payload
      ? fail(409, "IDEMPOTENCY_CONFLICT")
      : ok(await snapshot(), previous.status === "fetching" ? 202 : 200);
  };
  const cached = await replay();
  if (cached) return cached;
  if (goal.status !== "draft" || goal.revision !== body.expected_revision)
    return fail(409, "CONTEXT_CHANGED");
  const id = crypto.randomUUID();
  const day = Math.floor(now / 86400000) * 86400000;
  const claimed = await db
    .prepare(
      "INSERT OR IGNORE INTO research_evidence(id,goal_id,owner_id,request_key,request_payload,goal_revision,source_url,claim,caveat,status,created_at,lease_until) SELECT ?,id,owner_id,?,?,revision,?,?,?,'fetching',?,? FROM goals WHERE id=? AND owner_id=? AND status='draft' AND revision=? AND (SELECT count(*) FROM research_evidence WHERE goal_id=?)<20 AND (SELECT count(*) FROM research_evidence WHERE owner_id=? AND created_at>=?)<20 AND (SELECT count(*) FROM research_evidence WHERE created_at>=?)<50",
    )
    .bind(
      id,
      key,
      payload,
      url,
      body.claim.trim(),
      body.caveat.trim(),
      now,
      now + 30000,
      goalId,
      owner,
      body.expected_revision,
      goalId,
      owner,
      day,
      day,
    )
    .run();
  if (!claimed.meta.changes)
    return (await replay()) ?? fail(409, "SOURCE_LIMIT_OR_BUSY");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ResearchError("SOURCE_TIMEOUT"));
    }, 10000);
  });
  void timeout.catch(() => {});
  try {
    const page = await Promise.race([
      provider.read(url, controller.signal),
      timeout,
    ]);
    if (controller.signal.aborted) throw new ResearchError("SOURCE_TIMEOUT");
    const result = await db
      .prepare(
        "UPDATE research_evidence SET status='available',title=?,excerpt=?,retrieved_at=? WHERE id=? AND owner_id=? AND status='fetching' AND lease_until>? AND EXISTS(SELECT 1 FROM goals WHERE id=goal_id AND owner_id=? AND status='draft' AND revision=?)",
      )
      .bind(
        page.title,
        page.excerpt,
        Date.now(),
        id,
        owner,
        Date.now(),
        owner,
        body.expected_revision,
      )
      .run();
    if (!result.meta.changes) throw new ResearchError("CONTEXT_CHANGED");
    return ok(await snapshot(), 201);
  } catch (error) {
    const code =
      error instanceof ResearchError ? error.code : "SOURCE_UNAVAILABLE";
    await db
      .prepare(
        "UPDATE research_evidence SET status='failed',error_code=? WHERE id=? AND owner_id=? AND status='fetching'",
      )
      .bind(code, id, owner)
      .run();
    return fail(code === "CONTEXT_CHANGED" ? 409 : 502, code);
  } finally {
    clearTimeout(timer!);
  }
}
