import type { D1Database } from "@cloudflare/workers-types";
import { clarificationReadiness } from "./agent/readiness.ts";

const keys = ["outcome", "available_time", "constraints"] as const;
type Slot = {
  key: (typeof keys)[number];
  state: "confirmed" | "unknown";
  text: string;
};
function parseSlots(value: unknown): Slot[] {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error("Invalid slots");
  const result = keys.map((key) => {
    const items = value.filter(
      (s) => s && typeof s === "object" && s.key === key,
    );
    const slot = items[0];
    if (
      items.length !== 1 ||
      Object.keys(slot).some((k) => !["key", "state", "text"].includes(k)) ||
      !["confirmed", "unknown"].includes(slot.state) ||
      typeof slot.text !== "string" ||
      slot.text.length > 300
    )
      throw new Error("Invalid slot");
    const text = slot.text.trim();
    if (slot.state === "confirmed" ? !text : !!text)
      throw new Error("Invalid slot state");
    return { key, state: slot.state, text } as Slot;
  });
  return result;
}

export async function slotsResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
): Promise<Response> {
  const goalId = new URL(request.url).pathname.split("/").at(-2)!;
  const ok = (data: unknown) =>
    Response.json({ data, error: null, request_id: requestId });
  const fail = (status: number, code: string, message: string) =>
    Response.json(
      {
        data: null,
        error: { code, message, details: null },
        request_id: requestId,
      },
      { status },
    );
  const columns = "id,title,description,timeframe_note,status,revision";
  if (request.method === "GET") {
    const results = await db.batch<Record<string, unknown>>([
      db
        .prepare(`SELECT ${columns} FROM goals WHERE id=? AND owner_id=?`)
        .bind(goalId, owner),
      db
        .prepare(
          "SELECT s.key,s.value_json,s.source,s.confirmed_at FROM goal_slots s JOIN goals g ON g.id=s.goal_id WHERE g.id=? AND g.owner_id=? ORDER BY s.key",
        )
        .bind(goalId, owner),
      db
        .prepare(
          "SELECT 1 AS found FROM agent_runs r JOIN goals g ON g.id=r.goal_id AND g.owner_id=r.owner_id WHERE g.id=? AND g.owner_id=? AND r.status='succeeded' AND json_extract(r.reply_json,'$.source')='policy' LIMIT 1",
        )
        .bind(goalId, owner),
    ]);
    const goal = results[0].results[0];
    if (!goal) return fail(404, "NOT_FOUND", "目标不存在。");
    const slots = results[1].results.map((s) => ({
      key: s.key,
      value: JSON.parse(s.value_json as string),
      source: s.source,
      confirmed_at: s.confirmed_at,
    }));
    return ok({
      goal,
      slots,
      readiness: clarificationReadiness(
        goal as {
          revision: number;
          status: string;
          description: string;
          title: string;
        },
        slots as Parameters<typeof clarificationReadiness>[1],
        !!results[2].results.length,
      ),
    });
  }
  if (request.method !== "PATCH") {
    const response = fail(
      405,
      "METHOD_NOT_ALLOWED",
      "此接口不支持该请求方法。",
    );
    response.headers.set("Allow", "GET, PATCH");
    return response;
  }
  const existing = await db
    .prepare("SELECT id FROM goals WHERE id=? AND owner_id=?")
    .bind(goalId, owner)
    .first();
  if (!existing) return fail(404, "NOT_FOUND", "目标不存在。");
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
      size += next.value.length;
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
  let revision: number;
  let slots: Slot[];
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !["expected_revision", "slots"].includes(k),
      ) ||
      !Number.isSafeInteger(body.expected_revision) ||
      body.expected_revision < 0
    )
      throw new Error();
    revision = body.expected_revision;
    slots = parseSlots(body.slots);
  } catch {
    return fail(
      422,
      "INVALID_BODY",
      "请确认每项内容（最多 300 字）或选择暂不确定。",
    );
  }
  const payload = JSON.stringify({
    kind: "slots",
    expected_revision: revision,
    slots,
  });
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE goals SET revision=revision+1,updated_at=max(updated_at,?),last_mutation_key=? WHERE id=? AND owner_id=? AND revision=? AND status='draft' AND active_plan_version_id IS NULL AND NOT EXISTS(SELECT 1 FROM goal_mutations WHERE owner_id=? AND request_key=?)`,
      )
      .bind(now, key, goalId, owner, revision, owner, key),
    ...slots.map((s) =>
      db
        .prepare(
          `INSERT INTO goal_slots(id,goal_id,key,value_json,confirmed_at,updated_at) SELECT ?,id,?,?,?,? FROM goals WHERE id=? AND owner_id=? AND last_mutation_key=? AND revision=? AND NOT EXISTS(SELECT 1 FROM goal_mutations WHERE owner_id=? AND request_key=?) ON CONFLICT(goal_id,key) DO UPDATE SET value_json=excluded.value_json,confirmed_at=excluded.confirmed_at,updated_at=excluded.updated_at`,
        )
        .bind(
          crypto.randomUUID(),
          s.key,
          JSON.stringify({ schema_version: 1, state: s.state, text: s.text }),
          s.state === "confirmed" ? now : null,
          now,
          goalId,
          owner,
          key,
          revision + 1,
          owner,
          key,
        ),
    ),
    db
      .prepare(
        `INSERT INTO goal_mutations(owner_id,request_key,goal_id,request_payload,response_payload,created_at) SELECT owner_id,?,id,?,json_object('goal',json_object('id',id,'title',title,'description',description,'timeframe_note',timeframe_note,'status',status,'revision',revision),'slots',json((SELECT json_group_array(json_object('key',key,'value',json(value_json),'source',source,'confirmed_at',confirmed_at)) FROM goal_slots WHERE goal_id=goals.id))),? FROM goals WHERE id=? AND owner_id=? AND last_mutation_key=? AND revision=? ON CONFLICT(owner_id,request_key) DO NOTHING`,
      )
      .bind(key, payload, now, goalId, owner, key, revision + 1),
  ]);
  const receipt = await db
    .prepare(
      "SELECT goal_id,request_payload,response_payload FROM goal_mutations WHERE owner_id=? AND request_key=?",
    )
    .bind(owner, key)
    .first<{
      goal_id: string;
      request_payload: string;
      response_payload: string;
    }>();
  if (receipt) {
    if (receipt.goal_id !== goalId || receipt.request_payload !== payload)
      return fail(409, "IDEMPOTENCY_CONFLICT", "提交标识已被其他内容使用。");
    return ok(JSON.parse(receipt.response_payload));
  }
  return fail(
    409,
    "REVISION_CONFLICT",
    "目标已改变或已暂停，请重新读取后再保存。",
  );
}
