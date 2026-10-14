import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { checkedPlan } from "../src/agent/plan-schema.ts";
import { ensureAutomaticSchedule } from "../src/scheduling/chat.ts";
export async function setup(t) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: "2026-10-09",
      d1Databases: ["DB"],
      d1Persist: false,
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL("../migrations/" + file, import.meta.url),
      "utf8",
    );
    await db.batch(
      sql
        .replace(/^[ \t]*--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
  const owner = "approval-test";
  await db.batch([
    db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
      )
      .bind(owner, "Test", "approval@example.invalid"),
    db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,1,1)",
      )
      .bind(owner),
  ]);
  async function goal() {
    const goalId = globalThis.crypto.randomUUID(),
      attempt = globalThis.crypto.randomUUID(),
      stop = globalThis.crypto.randomUUID(),
      now = Date.now();
    const draft = checkedPlan(
      JSON.stringify({
        title: "韩语计划",
        summary: "基础练习",
        assumptions: ["晚间候选时间待核对"],
        risks: [],
        stage_weeks: [{ stage: 1, weeks: 1 }],
        tasks: [
          {
            key: "t1",
            stage: 1,
            title: "韩语练习",
            instructions: "朗读并记录表达",
            duration_minutes: 20,
            frequency_per_week: 3,
            mandatory: true,
            depends_on: [],
            evidence_ids: [],
          },
        ],
      }),
      [],
      true,
    );
    await db.batch([
      db
        .prepare(
          "INSERT INTO goals(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,1,1)",
        )
        .bind(goalId, owner, "学韩语"),
      db
        .prepare(
          "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) VALUES(?,?,?,?,'{}',1,0,'先到这里，请根据现有信息准备方案草稿。','succeeded','clarify-stop-v1',?,?,?,0)",
        )
        .bind(
          stop,
          goalId,
          owner,
          stop,
          JSON.stringify({
            schema_version: 1,
            kind: "notice",
            source: "harness",
            stage: "draft_requested",
            requested_slot: null,
            question: "开始制订",
            reason: "测试",
          }),
          now,
          now,
        ),
      db
        .prepare(
          "INSERT INTO planning_jobs(id,source_run_id,goal_id,owner_id,goal_revision,status,context_json,created_at,updated_at,lease_until) VALUES(?,?,?,?,0,'completed','{}',?,?,0)",
        )
        .bind(attempt, stop, goalId, owner, now, now),
      db
        .prepare(
          "INSERT INTO plan_draft_attempts(id,goal_id,owner_id,goal_revision,request_key,request_payload,context_json,status,draft_json,created_at,lease_until) VALUES(?,?,?,0,?,'{}',?,'succeeded',?,?,0)",
        )
        .bind(
          attempt,
          goalId,
          owner,
          attempt,
          JSON.stringify({
            schema_version: 1,
            generation_mode: "chat_auto_v1",
            goal: { description: "学韩语", timeframe_note: "" },
            conditions: [],
            sources: [],
          }),
          JSON.stringify(draft),
          now,
        ),
    ]);
    await ensureAutomaticSchedule(db, {
      id: attempt,
      goal_id: goalId,
      owner_id: owner,
      goal_revision: 0,
    });
    const row = await db
      .prepare(
        "SELECT id,reply_json FROM agent_runs WHERE goal_id=? ORDER BY turn_index DESC LIMIT 1",
      )
      .bind(goalId)
      .first();
    const schedule = JSON.parse(row.reply_json).schedule;
    assert.ok(schedule);
    const body = {
      schedule_run_id: row.id,
      expected_goal_revision: 0,
      expected_calendar_revision: 0,
    };
    const request = (key = "confirm-plan-key", payload = body) =>
      new globalThis.Request(
        `http://localhost/api/v1/goals/${goalId}/plan-approval`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(payload),
        },
      );
    return { id: goalId, attempt, body, schedule, draft, request };
  }
  return { db, owner, goal };
}
