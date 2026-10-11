import type { D1Database } from "@cloudflare/workers-types";
import {
  boundedText,
  ResearchError,
  sourceUrl,
  webProvider,
  type ResearchProvider,
} from "./provider.ts";
export interface WorkflowBinding {
  create(options: { id: string; params: { jobId: string } }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
export async function dispatchJob(
  db: D1Database,
  binding: WorkflowBinding,
  id: string,
): Promise<boolean> {
  const job = await db
    .prepare("SELECT status,dispatched FROM agent_jobs WHERE id=?")
    .bind(id)
    .first();
  if (
    !job ||
    !["queued", "running"].includes(job.status as string) ||
    job.dispatched
  )
    return true;
  try {
    try {
      await binding.create({ id, params: { jobId: id } });
    } catch {
      const instance = await binding.get(id);
      const state = await instance.status();
      if (
        !["queued", "running", "waiting", "paused", "complete"].includes(
          state.status,
        )
      )
        throw new Error("Dispatch failed");
    }
    await db
      .prepare(
        "UPDATE agent_jobs SET dispatched=1,error_code=NULL,updated_at=? WHERE id=? AND status IN ('queued','running')",
      )
      .bind(Date.now(), id)
      .run();
    return true;
  } catch {
    await db
      .prepare(
        "UPDATE agent_jobs SET error_code='WORKFLOW_START_FAILED',updated_at=? WHERE id=? AND status='queued' AND dispatched=0",
      )
      .bind(Date.now(), id)
      .run();
    return false;
  }
}
export async function jobResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
  binding?: WorkflowBinding,
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
          message: "后台资料任务未启动，请读取状态后重试。",
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
  const snapshot = async () => {
    const jobs = (
      await db
        .prepare(
          "SELECT id,goal_revision,status,dispatched,error_code,created_at,updated_at FROM agent_jobs WHERE goal_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 20",
        )
        .bind(goalId, owner)
        .all()
    ).results;
    const items = (
      await db
        .prepare(
          "SELECT i.job_id,i.position,i.source_url,i.claim,i.caveat,i.status,i.title,i.excerpt,i.retrieved_at,i.error_code FROM research_job_items i JOIN agent_jobs j ON j.id=i.job_id WHERE j.goal_id=? AND j.owner_id=? ORDER BY i.position",
        )
        .bind(goalId, owner)
        .all()
    ).results;
    return {
      goal,
      jobs: jobs.map((j) => ({
        ...j,
        items: items.filter((i) => i.job_id === j.id),
      })),
    };
  };
  if (request.method === "GET") {
    if (binding) {
      const active = (
        await db
          .prepare(
            "SELECT id FROM agent_jobs WHERE goal_id=? AND owner_id=? AND dispatched=1 AND status IN ('queued','running')",
          )
          .bind(goalId, owner)
          .all()
      ).results;
      for (const job of active) {
        try {
          const state = await (await binding.get(job.id as string)).status();
          if (["errored", "terminated"].includes(state.status)) {
            await db
              .prepare(
                "UPDATE agent_jobs SET status='failed',error_code='WORKFLOW_FAILED',updated_at=? WHERE id=? AND status IN ('queued','running')",
              )
              .bind(now, job.id)
              .run();
            await finishJob(db, job.id as string);
          }
        } catch {
          /* No automatic restart on status failure. */
        }
      }
    }
    return ok(await snapshot());
  }
  if (request.method !== "POST") {
    const res = fail(405, "METHOD_NOT_ALLOWED");
    res.headers.set("Allow", "GET, POST");
    return res;
  }
  if (!binding) return fail(503, "WORKFLOW_NOT_CONFIGURED");
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    return fail(415, "INVALID_CONTENT_TYPE");
  let body;
  try {
    body = JSON.parse(await boundedText(request.body, 4096));
  } catch {
    return fail(422, "INVALID_BODY");
  }
  if (
    body &&
    typeof body.resume_job_id === "string" &&
    Object.keys(body).length === 1
  ) {
    const found = await db
      .prepare(
        "SELECT id FROM agent_jobs WHERE id=? AND goal_id=? AND owner_id=? AND status='queued' AND dispatched=0",
      )
      .bind(body.resume_job_id, goalId, owner)
      .first();
    if (!found) return fail(409, "JOB_NOT_PENDING");
    return (await dispatchJob(db, binding, body.resume_job_id))
      ? ok(await snapshot(), 202)
      : fail(503, "WORKFLOW_START_FAILED");
  }
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    return fail(422, "INVALID_KEY");
  if (
    !body ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (k) => !["evidence_ids", "expected_revision"].includes(k),
    ) ||
    !Array.isArray(body.evidence_ids) ||
    body.evidence_ids.length < 1 ||
    body.evidence_ids.length > 3 ||
    body.evidence_ids.some(
      (id: unknown) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id),
    ) ||
    new Set(body.evidence_ids).size !== body.evidence_ids.length ||
    !Number.isSafeInteger(body.expected_revision) ||
    body.expected_revision < 0
  )
    return fail(422, "INVALID_BODY");
  const ids: string[] = [...body.evidence_ids].sort();
  const payload = JSON.stringify({ ids, revision: body.expected_revision });
  const previous = await db
    .prepare(
      "SELECT id,goal_id,request_payload,status,dispatched FROM agent_jobs WHERE owner_id=? AND request_key=?",
    )
    .bind(owner, key)
    .first();
  if (previous) {
    if (previous.goal_id !== goalId || previous.request_payload !== payload)
      return fail(409, "IDEMPOTENCY_CONFLICT");
    if (
      !previous.dispatched &&
      previous.status === "queued" &&
      !(await dispatchJob(db, binding, previous.id as string))
    )
      return fail(503, "WORKFLOW_START_FAILED");
    return ok(await snapshot());
  }
  if (goal.status !== "draft" || goal.revision !== body.expected_revision)
    return fail(409, "CONTEXT_CHANGED");
  const sources = [];
  for (const id of ids) {
    const item = await db
      .prepare(
        "SELECT source_url,claim,caveat,goal_revision,status FROM research_evidence WHERE id=? AND goal_id=? AND owner_id=?",
      )
      .bind(id, goalId, owner)
      .first();
    if (
      !item ||
      item.goal_revision !== body.expected_revision ||
      item.status === "fetching"
    )
      return fail(422, "INVALID_SOURCES");
    try {
      sourceUrl(item.source_url as string);
    } catch {
      return fail(422, "INVALID_SOURCES");
    }
    sources.push(item);
  }
  const id = crypto.randomUUID();
  const day = Math.floor(now / 86400000) * 86400000;
  const result = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_jobs(id,goal_id,owner_id,request_key,request_payload,goal_revision,status,created_at,updated_at) SELECT ?,id,owner_id,?,?,revision,'queued',?,? FROM goals WHERE id=? AND owner_id=? AND status='draft' AND revision=? AND (SELECT count(*) FROM agent_jobs WHERE goal_id=?)<20 AND (SELECT count(*) FROM agent_jobs WHERE owner_id=? AND created_at>=?)<3 AND (SELECT count(*) FROM agent_jobs WHERE created_at>=?)<10",
      )
      .bind(
        id,
        key,
        payload,
        now,
        now,
        goalId,
        owner,
        body.expected_revision,
        goalId,
        owner,
        day,
        day,
      ),
    ...sources.map((s, position) =>
      db
        .prepare(
          "INSERT INTO research_job_items(job_id,position,source_url,claim,caveat) SELECT id,?,?,?,? FROM agent_jobs WHERE id=?",
        )
        .bind(position, s.source_url, s.claim, s.caveat, id),
    ),
  ]);
  if (!result[0].meta.changes) {
    const replay = await db
      .prepare(
        "SELECT id,goal_id,request_payload FROM agent_jobs WHERE owner_id=? AND request_key=?",
      )
      .bind(owner, key)
      .first();
    if (
      replay &&
      replay.goal_id === goalId &&
      replay.request_payload === payload
    ) {
      if (!(await dispatchJob(db, binding, replay.id as string)))
        return fail(503, "WORKFLOW_START_FAILED");
      return ok(await snapshot());
    }
    return fail(409, "JOB_LIMIT_OR_BUSY");
  }
  return (await dispatchJob(db, binding, id))
    ? ok(await snapshot(), 202)
    : fail(503, "WORKFLOW_START_FAILED");
}
export async function startJob(db: D1Database, id: string): Promise<number[]> {
  await db
    .prepare(
      "UPDATE agent_jobs SET status='running',updated_at=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM goals g WHERE g.id=agent_jobs.goal_id AND g.owner_id=agent_jobs.owner_id AND g.revision=agent_jobs.goal_revision AND g.status='draft')",
    )
    .bind(Date.now(), id)
    .run();
  const job = await db
    .prepare("SELECT status FROM agent_jobs WHERE id=?")
    .bind(id)
    .first();
  if (job?.status !== "running") return [];
  return (
    await db
      .prepare(
        "SELECT position FROM research_job_items WHERE job_id=? ORDER BY position",
      )
      .bind(id)
      .all()
  ).results.map((r) => Number(r.position));
}
export async function processSource(
  db: D1Database,
  id: string,
  position: number,
  provider: ResearchProvider = webProvider(),
): Promise<void> {
  const item = await db
    .prepare(
      "SELECT i.*,j.owner_id,j.goal_id,j.goal_revision,j.status AS job_status FROM research_job_items i JOIN agent_jobs j ON j.id=i.job_id WHERE i.job_id=? AND i.position=?",
    )
    .bind(id, position)
    .first();
  if (
    !item ||
    ["available", "failed"].includes(item.status as string) ||
    item.job_status !== "running"
  )
    return;
  const token = crypto.randomUUID();
  const now = Date.now();
  const claimed = await db
    .prepare(
      "UPDATE research_job_items SET status='reading',claim_token=?,lease_until=?,attempts=attempts+1 WHERE job_id=? AND position=? AND status IN ('pending','reading') AND lease_until<=? AND attempts<2 AND EXISTS(SELECT 1 FROM agent_jobs j JOIN goals g ON g.id=j.goal_id AND g.owner_id=j.owner_id WHERE j.id=job_id AND j.status='running' AND g.status='draft' AND g.revision=j.goal_revision)",
    )
    .bind(token, now + 30000, id, position, now)
    .run();
  if (!claimed.meta.changes) {
    const current = await db
      .prepare(
        "SELECT status,lease_until,attempts FROM research_job_items WHERE job_id=? AND position=?",
      )
      .bind(id, position)
      .first();
    if (current?.status === "reading" && Number(current.lease_until) > now)
      throw new ResearchError("SOURCE_BUSY");
    return;
  }
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
      provider.read(item.source_url as string, controller.signal),
      timeout,
    ]);
    if (controller.signal.aborted) throw new ResearchError("SOURCE_TIMEOUT");
    const persisted = await db
      .prepare(
        "UPDATE research_job_items SET status='available',title=?,excerpt=?,retrieved_at=?,lease_until=0 WHERE job_id=? AND position=? AND status='reading' AND claim_token=? AND lease_until>? AND EXISTS(SELECT 1 FROM agent_jobs j JOIN goals g ON g.id=j.goal_id AND g.owner_id=j.owner_id WHERE j.id=job_id AND j.status='running' AND g.status='draft' AND g.revision=j.goal_revision)",
      )
      .bind(
        page.title,
        page.excerpt,
        Date.now(),
        id,
        position,
        token,
        Date.now(),
      )
      .run();
    if (!persisted.meta.changes) throw new ResearchError("CONTEXT_CHANGED");
  } catch (error) {
    const code =
      error instanceof ResearchError ? error.code : "SOURCE_UNAVAILABLE";
    await db
      .prepare(
        "UPDATE research_job_items SET status='failed',error_code=?,lease_until=0 WHERE job_id=? AND position=? AND claim_token=? AND status='reading'",
      )
      .bind(code, id, position, token)
      .run();
  } finally {
    clearTimeout(timer!);
  }
}
export async function finishJob(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE agent_jobs SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM goals g WHERE g.id=agent_jobs.goal_id AND g.owner_id=agent_jobs.owner_id AND g.status='draft' AND g.revision=agent_jobs.goal_revision) OR EXISTS(SELECT 1 FROM research_job_items i WHERE i.job_id=agent_jobs.id AND i.status IN ('pending','reading')) THEN 'failed' ELSE 'completed' END,error_code=CASE WHEN NOT EXISTS(SELECT 1 FROM goals g WHERE g.id=agent_jobs.goal_id AND g.owner_id=agent_jobs.owner_id AND g.status='draft' AND g.revision=agent_jobs.goal_revision) THEN 'CONTEXT_CHANGED' WHEN EXISTS(SELECT 1 FROM research_job_items i WHERE i.job_id=agent_jobs.id AND i.status IN ('pending','reading')) THEN 'SOURCE_INCOMPLETE' ELSE NULL END,updated_at=? WHERE id=? AND status IN ('queued','running')",
      )
      .bind(Date.now(), id),
    db
      .prepare(
        "UPDATE research_job_items SET status='failed',error_code='SOURCE_INCOMPLETE',lease_until=0 WHERE job_id=? AND status IN ('pending','reading') AND EXISTS(SELECT 1 FROM agent_jobs j WHERE j.id=job_id AND j.status='failed')",
      )
      .bind(id),
  ]);
}
