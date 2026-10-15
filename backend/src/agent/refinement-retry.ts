import type { D1Database } from "@cloudflare/workers-types";

export const RETRY_REFINEMENT = "按上次要求再试。";
export function isRefinementRetry(text: string) {
  return /^(按上次(?:的)?(?:修改)?要求再试(?:一次)?|按上次修改再试(?:一次)?|重试上次修改)[。！!?？]?$/.test(
    text,
  );
}

export async function refinementRetryAvailable(
  db: D1Database,
  owner: string,
  goal: string,
  revision: unknown,
  status: unknown,
) {
  const retry = await latestRefinementRequest(db, owner, goal);
  if (
    !retry?.available ||
    retry.goalRevision !== revision ||
    !["draft", "active"].includes(String(status))
  )
    return false;
  const parent = await db
    .prepare(
      "SELECT plan_version_id FROM goal_active_plans WHERE goal_id=? AND owner_id=?",
    )
    .bind(goal, owner)
    .first();
  return (retry.parentId ?? "") === (parent?.plan_version_id ?? "");
}

/** The most recent request, never a search back through older failed revisions. */
export async function latestRefinementRequest(
  db: D1Database,
  owner: string,
  goal: string,
) {
  const row = await db
    .prepare(
      "SELECT r.id,r.user_text,r.goal_revision,r.reply_json,j.id job_id,j.status job_status,j.context_json,q.reply_json question_reply FROM agent_runs r LEFT JOIN planning_jobs j ON j.source_run_id=r.id AND j.owner_id=r.owner_id LEFT JOIN agent_runs q ON q.goal_id=r.goal_id AND q.owner_id=r.owner_id AND q.turn_index=r.turn_index-1 WHERE r.goal_id=? AND r.owner_id=? AND r.status='succeeded' AND r.harness_version='clarify-stop-v1' AND json_extract(r.reply_json,'$.stage')='draft_requested' AND NOT EXISTS(SELECT 1 FROM agent_runs risk WHERE risk.goal_id=r.goal_id AND risk.owner_id=r.owner_id AND json_extract(risk.reply_json,'$.source')='policy') ORDER BY r.turn_index DESC LIMIT 1",
    )
    .bind(goal, owner)
    .first();
  if (!row) return null;
  const context = JSON.parse(String(row.context_json ?? "{}"));
  const reply = JSON.parse(String(row.reply_json));
  const question = JSON.parse(String(row.question_reply ?? "null"));
  const request =
    context.revision_request ??
    reply.revision_request ??
    (question?.stage === "refine_question"
      ? String(row.user_text).replace(/^根据当前回答开始制订：/, "")
      : undefined);
  const base =
    context.base_attempt_id ??
    reply.base_attempt_id ??
    question?.base_attempt_id;
  if (
    typeof request !== "string" ||
    !request.trim() ||
    request.length > 500 ||
    typeof base !== "string" ||
    !/^[0-9a-f-]{36}$/.test(base)
  )
    return null;
  return {
    runId: String(row.id),
    jobId: row.job_id ? String(row.job_id) : null,
    goalRevision: Number(row.goal_revision),
    baseAttemptId: base,
    request,
    parentId: context.replan_parent_id ?? reply.replan_parent_id ?? null,
    available:
      !row.job_id || ["failed", "unknown"].includes(String(row.job_status)),
  };
}
