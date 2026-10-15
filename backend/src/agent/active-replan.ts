import type { D1Database } from "@cloudflare/workers-types";
import {
  AgentError,
  deepseekProvider,
  type AgentEnv,
  type AgentProvider,
} from "./provider.ts";
import {
  ASK_ADJUST,
  REFRESH_REPLAN,
  checkedPreferences,
  type Preferences,
} from "./schedule-preferences.ts";
import { remainingSchedule } from "../scheduling/remaining.ts";
export async function activeReplan(
  db: D1Database,
  owner: string,
  goalId: string,
  text: string,
  key: string,
  payload: string,
  chatRevision: number,
  goalRevision: number,
  env: AgentEnv,
  provider?: AgentProvider,
) {
  const parent = await db
    .prepare(
      "SELECT v.* FROM goal_active_plans a JOIN plan_versions v ON v.id=a.plan_version_id AND v.owner_id=a.owner_id WHERE a.goal_id=? AND a.owner_id=?",
    )
    .bind(goalId, owner)
    .first();
  if (!parent) return { status: 409, code: "CONTEXT_CHANGED" };
  const id = crypto.randomUUID(),
    now = Date.now(),
    day = Math.floor(now / 86400000) * 86400000;
  const delegated =
    /^(你来安排(?:吧)?|你决定(?:吧)?|暂不确定|不确定|不知道)[。！!?？]?$/.test(
      text,
    );
  const free =
    delegated ||
    [
      ASK_ADJUST,
      REFRESH_REPLAN,
      "请继续问我一个有助于完善方案的问题。",
      "先到这里，请根据现有信息准备方案草稿。",
    ].includes(text);
  const limit = env.GUIDY_ENVIRONMENT === "development" ? 24 : 8,
    global = env.GUIDY_ENVIRONMENT === "development" ? 60 : 20;
  const rows = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,created_at,updated_at,lease_until) SELECT ?,id,owner_id,?,?,?,revision,?,'running',?,?,?,? FROM goals g WHERE id=? AND owner_id=? AND status='active' AND revision=? AND (SELECT coalesce(max(turn_index),0) FROM agent_runs WHERE goal_id=g.id)=? AND ?=(SELECT plan_version_id FROM goal_active_plans WHERE goal_id=g.id AND owner_id=g.owner_id) AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=g.id AND status='running') AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=g.id AND json_extract(reply_json,'$.source')='policy') AND (?=1 OR ((SELECT count(*) FROM agent_runs WHERE owner_id=g.owner_id AND created_at>=? AND harness_version NOT IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1','busy-chat-v1','replan-refresh-v1','replan-question-v1','refine-question-v1'))<? AND (SELECT count(*) FROM agent_runs WHERE created_at>=? AND harness_version NOT IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1','busy-chat-v1','replan-refresh-v1','replan-question-v1','refine-question-v1'))<?))",
      )
      .bind(
        id,
        key,
        payload,
        chatRevision + 1,
        text,
        free ? "replan-refresh-v1" : "replan-v1",
        now,
        now,
        now + 45000,
        goalId,
        owner,
        goalRevision,
        chatRevision,
        parent.id,
        Number(free),
        day,
        limit,
        day,
        global,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'user',user_text,created_at FROM agent_runs WHERE id=? AND owner_id=?",
      )
      .bind(crypto.randomUUID(), id, owner),
  ]);
  if (!rows[0].meta.changes) return { status: 409, code: "AI_LIMIT_OR_BUSY" };
  const parentSchedule = JSON.parse(String(parent.schedule_json));
  const offset = parentSchedule.timezone === "UTC" ? 0 : 8 * 3600000;
  const previous = parentSchedule.preferences ?? {
    needs_clarification: false,
    question: "",
    reason: "",
    excluded_weekdays: [
      ...new Set(
        (parentSchedule.unavailable_from_notes ?? []).map(
          (w: { start_at: number }) =>
            new Date(w.start_at + offset).getUTCDay(),
        ),
      ),
    ],
    excluded_dates: [],
    preferred_start:
      ((parentSchedule.windows[0].start_at + offset) % 86400000) / 60000,
    preferred_end:
      Math.round(
        ((parentSchedule.windows[0].end_at + offset) % 86400000) / 60000,
      ) || 1440,
    request_echo: text,
  };
  const pending = await db
    .prepare(
      "SELECT reply_json FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.schedule.replaces_plan_id')=? ORDER BY turn_index DESC LIMIT 1",
    )
    .bind(goalId, owner, parent.id)
    .first();
  if (pending?.reply_json)
    Object.assign(
      previous,
      JSON.parse(String(pending.reply_json)).schedule.preferences,
    );
  const notice = {
    schema_version: 1,
    kind: "notice",
    source: "harness",
    requested_slot: null,
    stage: "edit_guidance",
    question: "你希望怎么调整未来安排？",
    reason: "已确认的安排会保留，调整草稿需要你再次确认。",
  };
  let reply: Record<string, unknown>;
  try {
    const risk =
      /处方|停药|药物剂量|诊断|自杀|自残|伤病|怀孕|糖尿病|心脏病/.test(text);
    if (risk)
      reply = {
        schema_version: 1,
        kind: "referral",
        source: "policy",
        question: "这涉及需要专业人员判断的条件，请先核对适用性。",
        reason: "当前不会调整日历。",
      };
    else {
      let preferences: Preferences | undefined;
      if (delegated)
        preferences = {
          ...previous,
          needs_clarification: false,
          question: "",
          reason: "先沿用原时间作为待核对建议。",
          request_echo: text,
        };
      else if (free) {
        const last = await db
          .prepare(
            "SELECT reply_json FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND json_extract(reply_json,'$.schedule.replaces_plan_id')=? ORDER BY turn_index DESC LIMIT 1",
          )
          .bind(goalId, owner, parent.id)
          .first();
        if (
          text === REFRESH_REPLAN ||
          text === "先到这里，请根据现有信息准备方案草稿。"
        )
          preferences = last?.reply_json
            ? JSON.parse(String(last.reply_json)).schedule.preferences
            : undefined;
      } else {
        const recent = (
          await db
            .prepare(
              "SELECT user_text,reply_json FROM agent_runs WHERE goal_id=? AND owner_id=? AND status='succeeded' AND harness_version IN ('replan-v1','replan-refresh-v1','replan-question-v1','refine-question-v1') ORDER BY turn_index DESC LIMIT 3",
            )
            .bind(goalId, owner)
            .all()
        ).results;
        const context = JSON.stringify({
          user_message: text,
          today: new Date(now + offset).toISOString().slice(0, 10),
          timezone: parentSchedule.timezone,
          previous_preferences: previous,
          recent: recent.map((r) => ({
            user: r.user_text,
            question: JSON.parse(String(r.reply_json ?? "null"))?.question,
          })),
        });
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 25000);
        try {
          const completion = await (
            provider ?? deepseekProvider(env, undefined, "schedule_change")
          ).complete(context, controller.signal);
          preferences = checkedPreferences(completion.content, text);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!preferences || preferences.needs_clarification)
        reply = {
          schema_version: 1,
          kind: "question",
          source: preferences ? "deepseek" : "harness",
          requested_slot: null,
          stage: preferences ? "clarifying" : "replan_question",
          question:
            preferences?.question ||
            "希望避开哪些日期或时段，或者改到什么时间？",
          reason: preferences?.reason || "我会先根据你的补充准备未来日程草稿。",
        };
      else {
        const schedule = await remainingSchedule(
          db,
          owner,
          parent,
          preferences,
          goalRevision,
          now,
        );
        reply = schedule
          ? {
              ...notice,
              stage: "schedule_preview",
              question: "我已准备好未来安排的调整草稿，请核对后确认。",
              schedule,
            }
          : {
              ...notice,
              clears_schedule_for_plan: parent.id,
              question: "当前方案已没有未来待调整的安排，原记录仍保留。",
            };
      }
    }
    const saved = await db.batch([
      db
        .prepare(
          "UPDATE agent_runs SET status='succeeded',reply_json=?,updated_at=? WHERE id=? AND owner_id=? AND status='running' AND lease_until>? AND EXISTS(SELECT 1 FROM goals WHERE id=? AND owner_id=? AND status='active' AND revision=?) AND ?=(SELECT plan_version_id FROM goal_active_plans WHERE goal_id=? AND owner_id=?) AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE goal_id=? AND id!=? AND json_extract(reply_json,'$.source')='policy')",
        )
        .bind(
          JSON.stringify(reply),
          Date.now(),
          id,
          owner,
          Date.now(),
          goalId,
          owner,
          goalRevision,
          parent.id,
          goalId,
          owner,
          goalId,
          id,
        ),
      db
        .prepare(
          "INSERT OR IGNORE INTO agent_messages(id,run_id,goal_id,role,content,created_at) SELECT ?,id,goal_id,'assistant',reply_json,updated_at FROM agent_runs WHERE id=? AND owner_id=? AND status='succeeded'",
        )
        .bind(crypto.randomUUID(), id, owner),
    ]);
    if (!saved[0].meta.changes) throw new AgentError("CONTEXT_CHANGED");
    return { status: 200 };
  } catch (e) {
    const code = e instanceof AgentError ? e.code : "AI_RESULT_UNKNOWN";
    await db
      .prepare(
        "UPDATE agent_runs SET status='failed',error_code=?,updated_at=? WHERE id=? AND owner_id=? AND status='running'",
      )
      .bind(code, Date.now(), id, owner)
      .run();
    return { status: 502, code };
  }
}
