import { refinementRetryAvailable } from "./refinement-retry.ts";
import type { D1Database } from "@cloudflare/workers-types";
import { ensureAutomaticSchedule } from "../scheduling/chat.ts";
import {
  AgentError,
  deepseekProvider,
  type AgentEnv,
  type AgentProvider,
} from "./provider.ts";
import { checkedPlan } from "./plan-schema.ts";
import {
  doubaoSearchProvider,
  SearchError,
  type SearchEnv,
  type SearchProvider,
} from "../research/search-provider.ts";
import type { WorkflowBinding } from "./workflow-binding.ts";
import { boundedText } from "../http/bounded-text.ts";

type Env = AgentEnv & SearchEnv;
type Job = {
  id: string;
  source_run_id: string;
  goal_id: string;
  owner_id: string;
  goal_revision: number;
  status: string;
  context_json: string;
  decision_json: string | null;
  sources_json: string;
  lease_until: number;
};
const terminal = ["completed", "failed", "unknown"];
const topics: Record<string, string> = {
  korean: "韩语初学者入门学习方法基础课程",
  english: "英语初学者入门学习方法基础课程",
  japanese: "日语初学者入门学习方法基础课程",
  fitness: "初学者运动指南安全渐进训练",
  skincare: "基础护肤指南适用限制",
  learning: "学习方法分阶段练习复盘",
  general: "目标规划行动拆解与复盘方法",
};
export function planningStatements(
  db: D1Database,
  runId: string,
  goalId: string,
  owner: string,
  revision: number,
  context: unknown,
  now: number,
  initialSources: unknown[] = [],
) {
  const id = crypto.randomUUID(),
    day = Math.floor(now / 86400000) * 86400000;
  return [
    db
      .prepare(
        "INSERT OR IGNORE INTO planning_jobs(id,source_run_id,goal_id,owner_id,goal_revision,status,context_json,sources_json,created_at,updated_at,lease_until) SELECT ?,r.id,r.goal_id,r.owner_id,r.goal_revision,'queued',?,?,?,?,? FROM agent_runs r JOIN goals g ON g.id=r.goal_id AND g.owner_id=r.owner_id WHERE r.id=? AND r.goal_id=? AND r.owner_id=? AND r.status='succeeded' AND json_extract(r.reply_json,'$.stage')='draft_requested' AND json_extract(r.reply_json,'$.source')='harness' AND r.harness_version='clarify-stop-v1' AND (g.status='draft' OR (g.status='active' AND (SELECT plan_version_id FROM goal_active_plans WHERE goal_id=g.id AND owner_id=g.owner_id)=json_extract(r.reply_json,'$.replan_parent_id'))) AND g.revision=? AND g.active_plan_version_id IS NULL AND (SELECT count(*) FROM plan_draft_usage WHERE owner_id=? AND created_at>=?)<3 AND (SELECT count(*) FROM plan_draft_usage WHERE created_at>=?)<10 AND (SELECT count(*) FROM planning_jobs WHERE goal_id=?)<10 AND (SELECT count(*) FROM plan_draft_attempts WHERE goal_id=?)<10 AND NOT EXISTS(SELECT 1 FROM plan_draft_attempts WHERE goal_id=? AND status='submitted') AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='policy')",
      )
      .bind(
        id,
        JSON.stringify(context),
        JSON.stringify(initialSources),
        now,
        now,
        now + 600000,
        runId,
        goalId,
        owner,
        revision,
        owner,
        day,
        day,
        goalId,
        goalId,
        goalId,
        goalId,
        owner,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO plan_draft_usage(id,owner_id,created_at) SELECT id,owner_id,created_at FROM planning_jobs WHERE id=?",
      )
      .bind(id),
  ];
}
async function load(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM planning_jobs WHERE id=?")
    .bind(id)
    .first<Job>();
}
async function valid(db: D1Database, j: Job) {
  return !!(await db
    .prepare(
      "SELECT 1 found FROM goals WHERE id=? AND owner_id=? AND (status='draft' OR (status='active' AND (SELECT plan_version_id FROM goal_active_plans WHERE goal_id=goals.id AND owner_id=goals.owner_id)=json_extract((SELECT context_json FROM planning_jobs WHERE id=?),'$.replan_parent_id'))) AND revision=? AND active_plan_version_id IS NULL AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='policy')",
    )
    .bind(j.goal_id, j.owner_id, j.id, j.goal_revision, j.goal_id, j.owner_id)
    .first());
}
async function end(
  db: D1Database,
  id: string,
  code: string,
  status = "failed",
) {
  await db
    .prepare(
      "UPDATE planning_jobs SET status=?,error_code=?,updated_at=? WHERE id=? AND status NOT IN ('completed','failed','unknown')",
    )
    .bind(status, code, Date.now(), id)
    .run();
}
async function claim(db: D1Database, id: string, from: string, to: string) {
  const j = await load(db, id);
  if (!j || terminal.includes(j.status)) return null;
  if (!(await valid(db, j))) {
    await end(db, id, "CONTEXT_CHANGED");
    return null;
  }
  if (j.status !== from) {
    if (j.status === to)
      await end(db, id, "PLANNING_RESULT_UNKNOWN", "unknown");
    return null;
  }
  const r = await db
    .prepare(
      "UPDATE planning_jobs SET status=?,lease_until=?,updated_at=? WHERE id=? AND status=?",
    )
    .bind(to, Date.now() + 45000, Date.now(), id, from)
    .run();
  return r.meta.changes ? j : null;
}
async function external<T>(
  action: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AgentError("PLANNING_RESULT_UNKNOWN"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
function errorCode(e: unknown) {
  return e instanceof AgentError || e instanceof SearchError
    ? e.code
    : "PLANNING_RESULT_UNKNOWN";
}
export async function decidePlanning(
  db: D1Database,
  id: string,
  env: Env,
  provider?: AgentProvider,
) {
  const j = await claim(db, id, "queued", "deciding");
  if (!j) return;
  try {
    const c = JSON.parse(j.context_json);
    const input = JSON.stringify({
      goal: c.goal.description,
      revision_request: c.revision_request ?? null,
      has_sources: JSON.parse(j.sources_json).length > 0,
      outcome: c.conditions.find((s: { key: string }) => s.key === "outcome")
        ?.value,
    });
    const completion = await external(
      (s) =>
        (provider ?? deepseekProvider(env, undefined, "research")).complete(
          input,
          s,
        ),
      20000,
    );
    let d;
    try {
      d = JSON.parse(completion.content);
    } catch {
      throw new AgentError("PLANNING_INVALID_DECISION");
    }
    if (
      !d ||
      typeof d.needs_search !== "boolean" ||
      !Object.hasOwn(topics, d.topic) ||
      Object.keys(d).some((k) => !["needs_search", "topic"].includes(k))
    )
      throw new AgentError("PLANNING_INVALID_DECISION");
    if (/健身|护肤|营养|补剂|健康|训练/.test(c.goal.description))
      d.needs_search = true;
    if (!(await valid(db, j))) throw new AgentError("CONTEXT_CHANGED");
    const saved = await db
      .prepare(
        "UPDATE planning_jobs SET decision_json=?,status=?,updated_at=?,lease_until=? WHERE id=? AND status='deciding' AND lease_until>?",
      )
      .bind(
        JSON.stringify({
          ...d,
          query: d.needs_search ? topics[d.topic] : null,
        }),
        d.needs_search ? "research_ready" : "plan_ready",
        Date.now(),
        Date.now() + 600000,
        id,
        Date.now(),
      )
      .run();
    if (!saved.meta.changes) throw new AgentError("PLANNING_RESULT_UNKNOWN");
  } catch (e) {
    const code = errorCode(e);
    await end(
      db,
      id,
      code,
      code === "PLANNING_RESULT_UNKNOWN" ? "unknown" : "failed",
    );
  }
}
export async function researchPlanning(
  db: D1Database,
  id: string,
  env: Env,
  provider?: SearchProvider,
) {
  const j = await claim(db, id, "research_ready", "searching");
  if (!j) return;
  try {
    const searchId = crypto.randomUUID(),
      now = Date.now(),
      day = Math.floor(now / 86400000) * 86400000;
    const reservation = await db
      .prepare(
        "INSERT INTO search_usage(id,owner_id,created_at) SELECT ?,?,? WHERE (SELECT count(*) FROM search_usage WHERE owner_id=? AND created_at>=?)<6 AND (SELECT count(*) FROM search_usage WHERE created_at>=?)<30",
      )
      .bind(searchId, j.owner_id, now, j.owner_id, day, day)
      .run();
    if (!reservation.meta.changes)
      throw new SearchError("SEARCH_LIMIT_OR_BUSY");
    // Only one fixed, generic query is sent; no private answers/time/email are sent to search.
    const decision = JSON.parse(j.decision_json!);
    const query = decision.query ?? topics[decision.topic];
    const result = await external(
      (s) => (provider ?? doubaoSearchProvider(env)).search(query, s),
      12000,
    );
    const sources = result.sources
      .filter((s) => s.content && s.content_kind !== "snippet_only")
      .slice(0, 3)
      .map((s, i) => ({
        ...s,
        content: s.content.slice(0, 900),
        search_id: searchId,
        searched_at: result.searched_at,
        provider_request_id: result.provider_request_id,
        evidence_ref: `E${i + 1}`,
      }));
    if (!sources.length) throw new AgentError("PLAN_INSUFFICIENT_EVIDENCE");
    if (!(await valid(db, j))) throw new AgentError("CONTEXT_CHANGED");
    const saved = await db
      .prepare(
        "UPDATE planning_jobs SET sources_json=?,status='plan_ready',updated_at=?,lease_until=? WHERE id=? AND status='searching' AND lease_until>?",
      )
      .bind(
        JSON.stringify(sources),
        Date.now(),
        Date.now() + 600000,
        id,
        Date.now(),
      )
      .run();
    if (!saved.meta.changes) throw new AgentError("PLANNING_RESULT_UNKNOWN");
  } catch (e) {
    const code = errorCode(e);
    await end(
      db,
      id,
      code,
      code === "PLANNING_RESULT_UNKNOWN" || code === "SEARCH_RESULT_UNKNOWN"
        ? "unknown"
        : "failed",
    );
  }
}
export async function generatePlanning(
  db: D1Database,
  id: string,
  env: Env,
  provider?: AgentProvider,
) {
  const j = await claim(db, id, "plan_ready", "generating");
  if (!j) return;
  try {
    const context = {
      ...JSON.parse(j.context_json),
      sources: JSON.parse(j.sources_json),
      generation_mode: "chat_auto_v1",
    };
    const text = JSON.stringify(context);
    const input = JSON.stringify({
      ...context,
      sources: context.sources.map(
        (source: {
          evidence_ref: string;
          title: string;
          content: string;
          content_kind: string;
          published_at: string | null;
        }) => ({
          evidence_ref: source.evidence_ref,
          title: source.title,
          content: source.content,
          content_kind: source.content_kind,
          published_at: source.published_at,
        }),
      ),
    });
    if (input.length > 11000 || text.length > 18000)
      throw new AgentError("PLAN_CONTEXT_TOO_LARGE");
    const completion = await external(
      (s) =>
        (provider ?? deepseekProvider(env, undefined, "plan")).complete(
          input,
          s,
        ),
      25000,
    );
    const ids = context.sources.map((s: { source_id: string }) => s.source_id),
      refs = context.sources.map(
        (s: { evidence_ref: string }) => s.evidence_ref,
      );
    const draft = checkedPlan(
      completion.content,
      [...ids, ...refs],
      ids.length === 0,
    );
    draft.tasks = draft.tasks.map((t) => ({
      ...t,
      evidence_ids: [
        ...new Set(
          t.evidence_ids.map((ref) =>
            refs.includes(ref) ? ids[refs.indexOf(ref)] : ref,
          ),
        ),
      ],
    }));
    const notes = context.conditions
      .filter(
        (s: { value: { state: string } }) => s.value.state !== "confirmed",
      )
      .map(
        (s: { key: string }) =>
          ({
            outcome: "期望成果尚未明确，任务仅为基于原始目标的试行建议。",
            available_time:
              "可投入时间尚未明确，任务投入为建议，不代表实际空闲。",
            constraints: "基础、资源与关键限制尚未核对。",
          })[s.key],
      );
    if (!ids.length)
      notes.push(
        "未进行外部检索；以下是待核对的行动建议，不是已核实的专业结论。",
      );
    draft.assumptions = [...notes, ...draft.assumptions].slice(0, 5);
    if (!(await valid(db, j))) throw new AgentError("CONTEXT_CHANGED");
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO plan_draft_attempts(id,goal_id,owner_id,goal_revision,request_key,request_payload,context_json,status,draft_json,input_tokens,output_tokens,created_at,lease_until) SELECT id,goal_id,owner_id,goal_revision,?, ?,?,'succeeded',?,?,?,created_at,? FROM planning_jobs WHERE id=? AND status='generating' AND lease_until>? AND EXISTS(SELECT 1 FROM goals WHERE id=goal_id AND owner_id=planning_jobs.owner_id AND (status='draft' OR (status='active' AND (SELECT plan_version_id FROM goal_active_plans WHERE goal_id=goals.id AND owner_id=goals.owner_id)=json_extract(planning_jobs.context_json,'$.replan_parent_id'))) AND revision=planning_jobs.goal_revision AND active_plan_version_id IS NULL) AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=planning_jobs.goal_id AND owner_id=planning_jobs.owner_id AND status='succeeded' AND json_extract(reply_json,'$.source')='policy')",
        )
        .bind(
          `auto_plan_${id}`,
          JSON.stringify({ job_id: id }),
          text,
          JSON.stringify(draft),
          completion.inputTokens,
          completion.outputTokens,
          now,
          id,
          now,
        ),
      db
        .prepare(
          "UPDATE planning_jobs SET status='completed',updated_at=?,error_code=NULL WHERE id=? AND status='generating' AND EXISTS(SELECT 1 FROM plan_draft_attempts WHERE id=planning_jobs.id AND status='succeeded')",
        )
        .bind(now, id),
    ]);
    if ((await load(db, id))?.status !== "completed")
      throw new AgentError("CONTEXT_CHANGED");
    const completedJob = await load(db, id);
    if (completedJob) {
      try {
        await ensureAutomaticSchedule(db, completedJob);
      } catch {
        /* Saved draft remains; default timeline recovery never repeats paid generation. */
      }
    }
  } catch (e) {
    const code = errorCode(e);
    await end(
      db,
      id,
      code,
      code === "PLANNING_RESULT_UNKNOWN" ? "unknown" : "failed",
    );
  }
}
export async function dispatchPlanning(
  db: D1Database,
  binding: WorkflowBinding | undefined,
  id: string,
) {
  const j = await db
    .prepare("SELECT status,dispatched FROM planning_jobs WHERE id=?")
    .bind(id)
    .first();
  if (!j || terminal.includes(String(j.status)) || j.dispatched) return;
  if (!binding) {
    await db
      .prepare(
        "UPDATE planning_jobs SET error_code='WORKFLOW_START_FAILED' WHERE id=? AND status='queued'",
      )
      .bind(id)
      .run();
    return;
  }
  try {
    try {
      await binding.create({ id, params: { jobId: id } });
    } catch {
      const state = await (await binding.get(id)).status();
      if (
        !["queued", "running", "waiting", "paused", "complete"].includes(
          state.status,
        )
      )
        throw new Error();
    }
    await db
      .prepare(
        "UPDATE planning_jobs SET dispatched=1,error_code=CASE WHEN error_code='WORKFLOW_START_FAILED' THEN NULL ELSE error_code END WHERE id=?",
      )
      .bind(id)
      .run();
  } catch {
    await db
      .prepare(
        "UPDATE planning_jobs SET error_code='WORKFLOW_START_FAILED' WHERE id=? AND status='queued'",
      )
      .bind(id)
      .run();
  }
}
export async function planningResponse(
  request: Request,
  db: D1Database,
  owner: string,
  requestId: string,
  binding?: WorkflowBinding,
) {
  const goalId = new URL(request.url).pathname.split("/").at(-2)!;
  const goal = await db
    .prepare("SELECT id,revision,status FROM goals WHERE id=? AND owner_id=?")
    .bind(goalId, owner)
    .first();
  const fail = (status: number, code: string) =>
    Response.json(
      {
        data: null,
        error: { code, message: "生成未完成，请读取进度。", details: null },
        request_id: requestId,
      },
      { status },
    );
  if (!goal) return fail(404, "NOT_FOUND");
  if (request.method === "POST") {
    if (
      request.headers.get("Content-Type")?.split(";")[0].trim() !==
      "application/json"
    )
      return fail(415, "INVALID_CONTENT_TYPE");
    let body;
    try {
      body = JSON.parse(await boundedText(request.body, 1024));
      if (
        Object.keys(body).length !== 1 ||
        typeof body.job_id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(body.job_id)
      )
        throw new Error();
    } catch {
      return fail(422, "INVALID_BODY");
    }
    const owned = await db
      .prepare(
        "SELECT id FROM planning_jobs WHERE id=? AND goal_id=? AND owner_id=?",
      )
      .bind(body.job_id, goalId, owner)
      .first();
    if (!owned) return fail(404, "NOT_FOUND");
    await dispatchPlanning(db, binding, body.job_id);
  } else if (request.method !== "GET") {
    const response = fail(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "GET, POST");
    return response;
  }
  await db
    .prepare(
      "UPDATE planning_jobs SET status='unknown',error_code='PLANNING_RESULT_UNKNOWN',updated_at=? WHERE goal_id=? AND owner_id=? AND status NOT IN ('completed','failed','unknown') AND lease_until<=?",
    )
    .bind(Date.now(), goalId, owner, Date.now())
    .run();
  const jobs = (
    await db
      .prepare(
        "SELECT j.id,j.source_run_id,j.goal_revision,j.status,j.error_code,j.dispatched,j.created_at,p.context_json,p.draft_json,r.id review_id,r.revision review_revision,r.draft_json review_json,r.created_at review_created_at,r.weekly_capacity_minutes FROM planning_jobs j LEFT JOIN plan_draft_attempts p ON p.id=j.id AND p.owner_id=j.owner_id LEFT JOIN plan_draft_reviews r ON r.id=(SELECT id FROM plan_draft_reviews WHERE attempt_id=p.id AND owner_id=j.owner_id ORDER BY revision DESC LIMIT 1) WHERE j.goal_id=? AND j.owner_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT 10",
      )
      .bind(goalId, owner)
      .all()
  ).results.map((r) => ({
    id: r.id,
    source_run_id: r.source_run_id,
    goal_revision: r.goal_revision,
    status: r.status,
    error_code: r.error_code,
    dispatched: r.dispatched,
    created_at: r.created_at,
    review: r.review_json
      ? {
          id: r.review_id,
          revision: r.review_revision,
          draft: JSON.parse(String(r.review_json)),
          created_at: r.review_created_at,
          weekly_capacity_minutes: r.weekly_capacity_minutes,
        }
      : null,
    plan: r.draft_json
      ? {
          id: r.id,
          goal_revision: r.goal_revision,
          status: "succeeded",
          error_code: null,
          context: JSON.parse(String(r.context_json)),
          draft: JSON.parse(String(r.draft_json)),
          created_at: r.created_at,
          billing_status: "reserved_unknown",
        }
      : null,
  }));
  return Response.json({
    data: {
      goal,
      jobs,
      retry_refinement: await refinementRetryAvailable(
        db,
        owner,
        goalId,
        goal.revision,
        goal.status,
      ),
    },
    error: null,
    request_id: requestId,
  });
}
