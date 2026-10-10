import type { D1Database } from "@cloudflare/workers-types";

export async function goalsResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
): Promise<Response> {
  const ok = (data: unknown, status = 200) =>
    Response.json({ data, error: null, request_id: requestId }, { status });
  const fail = (status: number, code: string, message: string) =>
    Response.json(
      {
        data: null,
        error: { code, message, details: null },
        request_id: requestId,
      },
      { status },
    );
  const columns =
    "id,title,description,timeframe_note,status,revision,created_at,updated_at";
  const path = new URL(request.url).pathname;
  if (request.method === "GET") {
    if (path === "/api/v1/goals") {
      const rows = await db
        .prepare(
          `SELECT ${columns} FROM goals WHERE owner_id=? ORDER BY updated_at DESC,id DESC LIMIT 101`,
        )
        .bind(owner)
        .all();
      return ok({
        goals: rows.results.slice(0, 100),
        has_more: rows.results.length > 100,
      });
    }
    const goal = await db
      .prepare(`SELECT ${columns} FROM goals WHERE id=? AND owner_id=?`)
      .bind(path.split("/").at(-1), owner)
      .first();
    return goal ? ok(goal) : fail(404, "NOT_FOUND", "目标不存在。");
  }
  if (path !== "/api/v1/goals" || request.method !== "POST") {
    const response = fail(
      405,
      "METHOD_NOT_ALLOWED",
      "此接口不支持该请求方法。",
    );
    response.headers.set(
      "Allow",
      path === "/api/v1/goals" ? "GET, POST" : "GET",
    );
    return response;
  }
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY", "请提供有效的提交标识。");
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    return fail(415, "INVALID_CONTENT_TYPE", "请使用 JSON 请求。");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return fail(413, "BODY_TOO_LARGE", "请求内容过长。");
      }
      chunks.push(next.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
  } catch {
    return fail(422, "INVALID_BODY", "目标格式不正确。");
  }
  if (
    Object.keys(body).some((k) => !["description", "timeframe"].includes(k)) ||
    typeof body.description !== "string" ||
    typeof body.timeframe !== "string"
  )
    return fail(422, "INVALID_BODY", "目标格式不正确。");
  const description = body.description.trim();
  const timeframe = body.timeframe.trim();
  if (!description || description.length > 300 || timeframe.length > 80)
    return fail(422, "INVALID_BODY", "目标为 1–300 字，期望时间最多 80 字。");
  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await db
    .prepare(
      "INSERT INTO goals(id,owner_id,title,description,timeframe_note,creation_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,creation_key) WHERE creation_key IS NOT NULL DO NOTHING",
    )
    .bind(
      id,
      owner,
      description.slice(0, 200),
      description,
      timeframe,
      key,
      now,
      now,
    )
    .run();
  const goal = await db
    .prepare(`SELECT ${columns} FROM goals WHERE owner_id=? AND creation_key=?`)
    .bind(owner, key)
    .first();
  if (!goal) throw new Error("Goal write missing");
  if (goal.description !== description || goal.timeframe_note !== timeframe)
    return fail(
      409,
      "IDEMPOTENCY_CONFLICT",
      "这次提交内容已改变，请重新保存草稿后再提交。",
    );
  return ok(goal, inserted.meta.changes ? 201 : 200);
}
