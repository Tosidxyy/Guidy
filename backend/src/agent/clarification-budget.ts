import type { D1Database } from "@cloudflare/workers-types";
export function clarificationLimits(env: { GUIDY_ENVIRONMENT?: string }) {
  return env.GUIDY_ENVIRONMENT === "development"
    ? { personal: 24, global: 60 }
    : { personal: 8, global: 20 };
}
export async function clarificationBudget(
  db: D1Database,
  owner: string,
  env: { GUIDY_ENVIRONMENT?: string },
  now = Date.now(),
) {
  const limits = clarificationLimits(env),
    day = Math.floor(now / 86400000) * 86400000;
  const row = await db
    .prepare(
      "SELECT count(*) total,coalesce(sum(CASE WHEN owner_id=? THEN 1 ELSE 0 END),0) personal FROM agent_runs WHERE created_at>=? AND harness_version NOT IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1','busy-chat-v1','replan-refresh-v1','replan-question-v1','refine-question-v1')",
    )
    .bind(owner, day)
    .first();
  const used = Number(row?.personal ?? 0),
    remaining = Math.max(0, limits.personal - used),
    globalLimited = Number(row?.total ?? 0) >= limits.global;
  return {
    daily_limit: limits.personal,
    used,
    remaining,
    reset_at: day + 86400000,
    global_limited: globalLimited,
    allowed: remaining > 0 && !globalLimited,
  };
}
