import type { D1Database } from "@cloudflare/workers-types";
import { boundedText } from "../research/provider.ts";
type EditableDraft = {
  tasks: { id: string; duration_minutes: number; frequency_per_week: number }[];
  weekly_minutes: number;
};
export async function reviewResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
) {
  const url = new URL(request.url),
    goalId = url.pathname.split("/").at(-2)!,
    attemptId = url.searchParams.get("attempt_id");
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: {
          code,
          message: "审阅版本未保存，请读取最新状态；输入仍保留。",
          details: null,
        },
        request_id: requestId,
      },
      { status },
    );
  if (
    !attemptId ||
    !/^[0-9a-f-]{36}$/.test(attemptId) ||
    url.searchParams.size !== 1
  )
    return fail(422, "REVIEW_INVALID_SOURCE");
  const rows = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT id,revision,status FROM goals WHERE id=? AND owner_id=?")
      .bind(goalId, owner),
    db
      .prepare(
        "SELECT id,goal_revision,status,draft_json,context_json,created_at FROM plan_draft_attempts WHERE id=? AND goal_id=? AND owner_id=? AND status='succeeded'",
      )
      .bind(attemptId, goalId, owner),
    db
      .prepare(
        "SELECT 1 found FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='policy' LIMIT 1",
      )
      .bind(goalId, owner),
  ]);
  const goal = rows[0].results[0],
    source = rows[1].results[0];
  if (!goal || !source) return fail(404, "NOT_FOUND");
  const snapshot = async (receipt?: number) => {
    const reviews = (
      await db
        .prepare(
          "SELECT id,revision,draft_json,created_at,weekly_capacity_minutes FROM plan_draft_reviews WHERE attempt_id=? AND goal_id=? AND owner_id=? ORDER BY revision DESC LIMIT 20",
        )
        .bind(attemptId, goalId, owner)
        .all()
    ).results.map((r) => ({
      ...r,
      revision: Number(r.revision),
      draft_json: undefined,
      draft: JSON.parse(r.draft_json as string),
      source: "user",
    }));
    return Response.json({
      data: {
        goal,
        can_edit:
          reviews.length < 20 &&
          goal.status === "draft" &&
          goal.revision === source.goal_revision &&
          !rows[2].results.length,
        source: {
          ...source,
          draft_json: undefined,
          context_json: undefined,
          draft: JSON.parse(source.draft_json as string),
          context: JSON.parse(source.context_json as string),
          error_code: null,
          billing_status: "reserved_unknown",
        },
        reviews,
        current_revision: reviews[0]?.revision ?? 0,
        receipt_revision: receipt,
      },
      error: null,
      request_id: requestId,
    });
  };
  if (request.method === "GET") return snapshot();
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
    body = JSON.parse(await boundedText(request.body, 8192));
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) =>
          ![
            "expected_goal_revision",
            "expected_review_revision",
            "changes",
            "weekly_capacity_minutes",
          ].includes(k),
      ) ||
      !Number.isSafeInteger(body.expected_goal_revision) ||
      body.expected_goal_revision < 0 ||
      !Number.isInteger(body.expected_review_revision) ||
      body.expected_review_revision < 0 ||
      body.expected_review_revision > 20 ||
      (body.weekly_capacity_minutes !== undefined &&
        body.weekly_capacity_minutes !== null &&
        (!Number.isInteger(body.weekly_capacity_minutes) ||
          body.weekly_capacity_minutes < 0 ||
          body.weekly_capacity_minutes > 10080)) ||
      !Array.isArray(body.changes) ||
      body.changes.length < 1 ||
      body.changes.length > 6 ||
      new Set(body.changes.map((c: { task_id?: unknown }) => c?.task_id))
        .size !== body.changes.length
    )
      throw new Error();
    for (const c of body.changes)
      if (
        !c ||
        Object.keys(c).some(
          (k) =>
            !["task_id", "duration_minutes", "frequency_per_week"].includes(k),
        ) ||
        typeof c.task_id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(c.task_id) ||
        !Number.isInteger(c.duration_minutes) ||
        c.duration_minutes < 5 ||
        c.duration_minutes > 120 ||
        !Number.isInteger(c.frequency_per_week) ||
        c.frequency_per_week < 1 ||
        c.frequency_per_week > 7
      )
        throw new Error();
  } catch {
    return fail(422, "REVIEW_INVALID_CHANGES");
  }
  body.changes.sort((a: { task_id: string }, b: { task_id: string }) =>
    a.task_id.localeCompare(b.task_id),
  );
  const payload = JSON.stringify({ attempt_id: attemptId, ...body });
  const replay = async () => {
    const old = await db
      .prepare(
        "SELECT request_payload,revision FROM plan_draft_reviews WHERE owner_id=? AND request_key=?",
      )
      .bind(owner, key)
      .first();
    if (!old) return null;
    return old.request_payload === payload
      ? snapshot(Number(old.revision))
      : fail(409, "REVIEW_IDEMPOTENCY_CONFLICT");
  };
  const cached = await replay();
  if (cached) return cached;
  if (body.expected_review_revision === 20)
    return fail(409, "REVIEW_LIMIT_REACHED");
  if (
    goal.status !== "draft" ||
    goal.revision !== body.expected_goal_revision ||
    source.goal_revision !== goal.revision ||
    rows[2].results.length
  )
    return fail(409, "REVIEW_CONTEXT_CHANGED");
  const previous = await db
    .prepare(
      "SELECT revision,draft_json,weekly_capacity_minutes FROM plan_draft_reviews WHERE attempt_id=? AND owner_id=? ORDER BY revision DESC LIMIT 1",
    )
    .bind(attemptId, owner)
    .first();
  if (Number(previous?.revision ?? 0) !== body.expected_review_revision)
    return fail(409, "REVIEW_VERSION_CHANGED");
  const draft: EditableDraft = JSON.parse(
    String(previous?.draft_json ?? source.draft_json),
  );
  const capacity =
    body.weekly_capacity_minutes === undefined
      ? (previous?.weekly_capacity_minutes ?? null)
      : body.weekly_capacity_minutes;
  let changed = capacity !== (previous?.weekly_capacity_minutes ?? null);
  for (const c of body.changes) {
    const task = draft.tasks.find((t) => t.id === c.task_id);
    if (!task) return fail(422, "REVIEW_INVALID_CHANGES");
    if (
      task.duration_minutes !== c.duration_minutes ||
      task.frequency_per_week !== c.frequency_per_week
    )
      changed = true;
    task.duration_minutes = c.duration_minutes;
    task.frequency_per_week = c.frequency_per_week;
  }
  if (!changed) return fail(422, "REVIEW_NO_CHANGES");
  draft.weekly_minutes = draft.tasks.reduce(
    (sum, t) => sum + t.duration_minutes * t.frequency_per_week,
    0,
  );
  const revision = body.expected_review_revision + 1;
  const claim = await db
    .prepare(
      "INSERT OR IGNORE INTO plan_draft_reviews(id,attempt_id,goal_id,owner_id,revision,goal_revision,request_key,request_payload,draft_json,created_at,weekly_capacity_minutes) SELECT ?,p.id,p.goal_id,p.owner_id,?,p.goal_revision,?,?,?,?,? FROM plan_draft_attempts p JOIN goals g ON g.id=p.goal_id AND g.owner_id=p.owner_id WHERE p.id=? AND p.goal_id=? AND p.owner_id=? AND p.status='succeeded' AND g.status='draft' AND g.revision=? AND p.goal_revision=g.revision AND (SELECT coalesce(max(revision),0) FROM plan_draft_reviews WHERE attempt_id=p.id)=? AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=p.goal_id AND owner_id=p.owner_id AND status='succeeded' AND json_extract(reply_json,'$.source')='policy')",
    )
    .bind(
      crypto.randomUUID(),
      revision,
      key,
      payload,
      JSON.stringify(draft),
      Date.now(),
      capacity,
      attemptId,
      goalId,
      owner,
      body.expected_goal_revision,
      body.expected_review_revision,
    )
    .run();
  if (!claim.meta.changes)
    return (await replay()) ?? fail(409, "REVIEW_VERSION_CHANGED");
  return snapshot(revision);
}
