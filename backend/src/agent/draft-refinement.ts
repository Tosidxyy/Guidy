import type { D1Database } from "@cloudflare/workers-types";
import { planningStatements, dispatchPlanning } from "./planning-jobs.ts";
import type { WorkflowBinding } from "./workflow-binding.ts";
import {
  isRefinementRetry,
  latestRefinementRequest,
} from "./refinement-retry.ts";

export async function draftRefinement(
  db: D1Database,
  owner: string,
  goalId: string,
  text: string,
  key: string,
  payload: string,
  chatRevision: number,
  goalRevision: number,
  binding?: WorkflowBinding,
) {
  if (
    ["请根据现有信息直接拟定一周安排。", "请重新检查这份调整的日程。"].includes(
      text,
    )
  )
    return null;
  const directRevision = text.startsWith("按讨论修改策略：");
  const more = [
    "请继续问我一个有助于完善方案的问题。",
    "我想调整未来的安排。",
  ].includes(text);
  const parent = await db
    .prepare(
      "SELECT v.* FROM goal_active_plans a JOIN plan_versions v ON v.id=a.plan_version_id AND v.owner_id=a.owner_id WHERE a.goal_id=? AND a.owner_id=?",
    )
    .bind(goalId, owner)
    .first();
  const last = await db
    .prepare(
      "SELECT reply_json FROM agent_runs WHERE goal_id=? AND owner_id=? ORDER BY turn_index DESC LIMIT 1",
    )
    .bind(goalId, owner)
    .first();
  const previous = last?.reply_json
    ? JSON.parse(String(last.reply_json))
    : null;
  const explicitRetry = isRefinementRetry(text);
  const saved =
    explicitRetry || text === "先到这里，请根据现有信息准备方案草稿。"
      ? await latestRefinementRequest(db, owner, goalId)
      : null;
  if (explicitRetry && (!saved || !saved.available))
    return { status: 409, code: "REFINEMENT_RETRY_UNAVAILABLE" };
  const retry = saved?.available ? saved : null;
  if (
    !directRevision &&
    !more &&
    !retry &&
    previous?.stage !== "refine_question"
  ) {
    const replay = await db
      .prepare(
        "SELECT request_payload FROM agent_runs WHERE goal_id=? AND owner_id=? AND request_key=?",
      )
      .bind(goalId, owner, key)
      .first();
    return replay
      ? {
          status: replay.request_payload === payload ? 200 : 409,
          code: "IDEMPOTENCY_CONFLICT",
        }
      : null;
  }
  let source = await db
    .prepare(
      "SELECT j.id,p.draft_json,p.context_json FROM planning_jobs j JOIN plan_draft_attempts p ON p.id=j.id AND p.owner_id=j.owner_id WHERE j.goal_id=? AND j.owner_id=? AND j.goal_revision=? AND j.status='completed' AND p.status='succeeded' ORDER BY j.created_at DESC,j.id DESC LIMIT 1",
    )
    .bind(goalId, owner, goalRevision)
    .first();
  if (!source && parent)
    source = {
      id: parent.source_attempt_id,
      draft_json: parent.draft_json,
      context_json: parent.context_json,
    };
  if (!source) return null;
  if (
    await db
      .prepare(
        "SELECT id FROM planning_jobs WHERE goal_id=? AND owner_id=? AND status NOT IN ('completed','failed','unknown') LIMIT 1",
      )
      .bind(goalId, owner)
      .first()
  )
    return { status: 409, code: "PLANNING_BUSY" };
  if (
    retry &&
    (retry.goalRevision !== goalRevision ||
      retry.baseAttemptId !== source.id ||
      (retry.parentId ?? "") !== (parent?.id ?? ""))
  )
    return { status: 409, code: "CONTEXT_CHANGED" };
  if (
    !directRevision &&
    !more &&
    !retry &&
    previous.base_attempt_id !== source.id
  )
    return { status: 409, code: "CONTEXT_CHANGED" };
  const core = await db
    .prepare(
      "SELECT count(DISTINCT json_extract(reply_json,'$.requested_slot')) n FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.source')='deepseek' AND json_extract(reply_json,'$.requested_slot') IN ('outcome','available_time','constraints')",
    )
    .bind(goalId, owner)
    .first();
  if (!parent && Number(core?.n ?? 0) < 3)
    return { status: 422, code: "CLARIFICATION_MINIMUM_NOT_MET" };
  const request =
    retry?.request ??
    text.replace(/^(根据当前回答开始制订：|按讨论修改策略：)/, "");
  if (request.length > 500) return { status: 422, code: "INVALID_BODY" };
  const original = JSON.parse(String(source.draft_json)),
    context = JSON.parse(String(source.context_json));
  if (parent && source.id === parent.source_attempt_id) {
    const schedule = JSON.parse(String(parent.schedule_json)),
      prefs = schedule.preferences;
    if (prefs)
      original.time_preferences = {
        timezone: schedule.timezone,
        start_minute: prefs.preferred_start,
        end_minute: prefs.preferred_end,
        excluded_weekdays: prefs.excluded_weekdays,
      };
  }
  const risk =
    /处方|停药|减药|增药|药物剂量|药量|诊断|自杀|自残|伤害他人|伤病|怀孕|糖尿病|心脏病/i.test(
      JSON.stringify({
        request,
        goal: context.goal,
        conditions: context.conditions,
      }),
    );
  const progress = parent
    ? (
        await db
          .prepare(
            "SELECT t.title,o.status,count(*) count FROM scheduled_occurrences o JOIN tasks t ON t.id=o.task_id AND t.plan_version_id=o.plan_version_id WHERE o.goal_id=? AND o.owner_id=? AND o.status IN ('completed','skipped') GROUP BY t.title,o.status ORDER BY t.title,o.status LIMIT 24",
          )
          .bind(goalId, owner)
          .all()
      ).results
    : [];
  const reply = risk
    ? {
        schema_version: 1,
        source: "policy",
        kind: "referral",
        question: "这涉及需要专业人员判断的问题，请先核对适用性。",
        reason: "当前不会生成高风险方案或安排日历。",
      }
    : more
      ? {
          schema_version: 1,
          source: "harness",
          kind: "question",
          stage: "refine_question",
          requested_slot: null,
          base_attempt_id: source.id,
          question:
            "你希望怎样调整这份方案？内容、投入次数或时间都可以一起告诉我。",
          reason: "根据你的补充生成新草稿，原方案会保留。",
        }
      : {
          schema_version: 1,
          source: "harness",
          kind: "notice",
          stage: "draft_requested",
          requested_slot: null,
          question:
            "修改要求已记录，后台进度与新结果会显示在这里。原方案仍保留。",
          reason: "新结果仍需你确认后才加入日历。",
        };
  if (parent && !risk) Object.assign(reply, { replan_parent_id: parent.id });
  if (!more && !risk)
    Object.assign(reply, {
      base_attempt_id: source.id,
      revision_request: request,
    });
  const id = crypto.randomUUID(),
    now = Date.now();
  const compact = {
    title: original.title,
    summary: original.summary.slice(0, 160),
    stage_weeks: original.stage_weeks,
    time_preferences: original.time_preferences,
    tasks: original.tasks.map(
      (t: {
        id: string;
        key: string;
        stage: number;
        title: string;
        instructions: string;
        duration_minutes: number;
        frequency_per_week: number;
        mandatory: boolean;
        depends_on: string[];
      }) => ({
        key: t.key,
        stage: t.stage,
        title: t.title,
        instructions: t.instructions.slice(0, 160),
        duration_minutes: t.duration_minutes,
        frequency_per_week: t.frequency_per_week,
        mandatory: t.mandatory,
        depends_on: t.depends_on
          .map(
            (parent) =>
              original.tasks.find((p: { id: string }) => p.id === parent)?.key,
          )
          .filter(Boolean),
      }),
    ),
  };
  const frozen = {
    ...(context.planning_contract
      ? { planning_contract: context.planning_contract }
      : {}),
    schema_version: 1,
    generation_mode: "chat_auto_v1",
    goal: context.goal,
    conditions: context.conditions,
    dialogue_notes: (context.dialogue_notes ?? [])
      .slice(-8)
      .map((s: string) => s.slice(0, 600)),
    base_attempt_id: source.id,
    previous_plan: compact,
    revision_request: request,
    ...(retry
      ? { retry_of_run_id: retry.runId, retry_of_job_id: retry.jobId }
      : {}),
    ...(parent
      ? {
          replan_parent_id: parent.id,
          planning_as_of: new Date(now).toISOString(),
          execution_summary: progress,
          previous_period_end_at: JSON.parse(String(parent.schedule_json))
            .period.end_at,
        }
      : {}),
  };
  const result = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'succeeded',?,?,?,?,? FROM goals g WHERE id=? AND owner_id=? AND (status='draft' OR (status='active' AND (SELECT plan_version_id FROM goal_active_plans WHERE goal_id=g.id AND owner_id=g.owner_id)=?)) AND revision=? AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=g.id)=? AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=g.id AND status='running') AND ?=coalesce((SELECT j.id FROM planning_jobs j JOIN plan_draft_attempts p ON p.id=j.id AND p.owner_id=j.owner_id WHERE j.goal_id=g.id AND j.owner_id=g.owner_id AND j.goal_revision=g.revision AND j.status='completed' AND p.status='succeeded' ORDER BY j.created_at DESC,j.id DESC LIMIT 1),?) AND NOT EXISTS(SELECT 1 FROM planning_jobs WHERE goal_id=g.id AND status NOT IN ('completed','failed','unknown')) AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=g.id AND json_extract(reply_json,'$.source')='policy') AND (SELECT count(*) FROM agent_runs WHERE goal_id=g.id AND harness_version='refine-question-v1')<40",
      )
      .bind(
        id,
        key,
        payload,
        chatRevision + 1,
        text,
        more ? "refine-question-v1" : "clarify-stop-v1",
        JSON.stringify(reply),
        now,
        now,
        now,
        goalId,
        owner,
        parent?.id ?? "",
        goalRevision,
        chatRevision,
        source.id,
        parent?.source_attempt_id ?? "",
      ),
    ...(!more && !risk
      ? planningStatements(
          db,
          id,
          goalId,
          owner,
          goalRevision,
          frozen,
          now,
          context.sources ?? [],
        )
      : []),
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'user',user_text,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'assistant',reply_json,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
  ]);
  if (!result[0].meta.changes) {
    const replay = await db
      .prepare(
        "SELECT request_payload FROM agent_runs WHERE goal_id=? AND owner_id=? AND request_key=?",
      )
      .bind(goalId, owner, key)
      .first();
    return replay?.request_payload === payload
      ? { status: 200 }
      : { status: 409, code: "CONVERSATION_CHANGED" };
  }
  if (!more && !risk) {
    const job = await db
      .prepare(
        "SELECT id FROM planning_jobs WHERE source_run_id=? AND owner_id=?",
      )
      .bind(id, owner)
      .first();
    if (job) await dispatchPlanning(db, binding, String(job.id));
  }
  return { status: 200 };
}
