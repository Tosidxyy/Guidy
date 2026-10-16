import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { checkedPlan } from "../src/agent/plan-schema.ts";
import { ensureAutomaticSchedule } from "../src/scheduling/chat.ts";
import { approvalResponse } from "../src/scheduling/approval.ts";
import {
  planningCalendarSnapshot,
  upcomingCalendarResponse,
} from "../src/scheduling/calendar.ts";
import { createApp } from "../src/index.ts";
import {
  checkedApproval,
  checkedUpcoming,
} from "../../apps/mobile/src/goals/approval.ts";
async function setup(t) {
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
            segments: [
              {
                title: "听音",
                instructions: "听三句并标记发音",
                duration_minutes: 5,
              },
              {
                title: "跟读",
                instructions: "逐句跟读并录音对照",
                duration_minutes: 15,
              },
            ],
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
test("explicit approval atomically persists immutable plan/tasks/calendar, replays, isolates owner and survives reload", async (t) => {
  const f = await setup(t),
    g = await f.goal();
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM scheduled_occurrences").first())
      .n,
    0,
  );
  const call = (r) => approvalResponse(r, f.db, f.owner, "test");
  const r = await call(g.request());
  assert.equal(r.status, 200);
  const approved = (await r.json()).data.approval;
  checkedApproval({ schema_version: 1, approval: approved }, g.id);
  assert.equal(approved.version, 1);
  assert.equal(approved.calendar_revision, 1);
  assert.deepEqual(approved.draft, g.draft);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM tasks").first()).n,
    1,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM scheduled_occurrences").first())
      .n,
    3,
  );
  assert.deepEqual(
    await f.db
      .prepare("SELECT status,revision,active_plan_version_id FROM goals")
      .first(),
    { status: "active", revision: 1, active_plan_version_id: null },
  );
  assert.equal(
    (await (await call(g.request())).json()).data.approval.id,
    approved.id,
  );
  assert.equal(
    (
      await call(
        g.request("confirm-plan-key", {
          ...g.body,
          expected_calendar_revision: 1,
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (await approvalResponse(g.request(), f.db, "another-owner", "test")).status,
    404,
  );
  const get = new globalThis.Request(
    `http://localhost/api/v1/goals/${g.id}/plan-approval`,
  );
  assert.equal((await (await call(get)).json()).data.approval.id, approved.id);
  const from = g.schedule.period.start_at,
    to = from + 7 * 86400000;
  const events = await upcomingCalendarResponse(
    new globalThis.Request(
      `http://localhost/api/v1/calendar/events?from=${from}&to=${to}`,
    ),
    f.db,
    f.owner,
    "test",
  );
  const data = (await events.json()).data;
  checkedUpcoming(data, from, to);
  assert.equal(data.events.length, 3);
  assert.equal(data.events[0].instructions, "朗读并记录表达");
  assert.equal(data.events[0].source, "plan");
  assert.deepEqual(data.events[0].segments, g.draft.tasks[0].segments);
  assert.equal(
    (await planningCalendarSnapshot(f.db, f.owner, g.schedule.period)).events
      .length,
    3,
  );
  assert.equal(
    (await f.db.prepare("PRAGMA foreign_key_check").all()).results.length,
    0,
  );
  const app = createApp({ logger: () => {} });
  assert.equal(
    (
      await app.fetch(g.request(), {
        DB: f.db,
        GUIDY_AUTH_MODE: "local-inbox",
        BETTER_AUTH_SECRET: "test-only-secret-at-least-32-characters",
        BETTER_AUTH_URL: "http://localhost",
      })
    ).status,
    401,
  );
  await f.db.batch([
    f.db
      .prepare("UPDATE scheduled_occurrences SET status='completed' WHERE id=?")
      .bind(data.events[0].id),
    f.db
      .prepare("UPDATE scheduled_occurrences SET status='skipped' WHERE id=?")
      .bind(data.events[1].id),
  ]);
  const activeOnly = await upcomingCalendarResponse(
    new globalThis.Request(
      `http://localhost/api/v1/calendar/events?from=${from}&to=${to}`,
    ),
    f.db,
    f.owner,
    "test",
  );
  const activeData = (await activeOnly.json()).data;
  checkedUpcoming(activeData, from, to);
  assert.equal(activeData.events.length, 1);
  assert.equal(activeData.events[0].status, "scheduled");
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) n FROM scheduled_occurrences WHERE status IN ('completed','skipped')",
        )
        .first()
    ).n,
    2,
  );
  await f.db.prepare('DELETE FROM "user" WHERE id=?').bind(f.owner).run();
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM scheduled_occurrences").first())
      .n,
    0,
  );
});
test("parallel same-key confirmations create once; another goal cannot occupy the same accepted windows", async (t) => {
  const f = await setup(t),
    a = await f.goal(),
    b = await f.goal();
  const responses = await Promise.all([
    approvalResponse(a.request(), f.db, f.owner, "test"),
    approvalResponse(a.request(), f.db, f.owner, "test"),
  ]);
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
  assert.equal(
    (
      await approvalResponse(
        b.request("other-goal-confirm"),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM goals WHERE id=?")
        .bind(b.id)
        .first()
    ).status,
    "draft",
  );
});
test("changed calendar, policy and atomic insert failure never approve a plan", async (t) => {
  const f = await setup(t),
    g = await f.goal();
  await f.db
    .prepare(
      "CREATE TRIGGER fail_occurrence BEFORE INSERT ON scheduled_occurrences BEGIN SELECT RAISE(ABORT,'test failure'); END",
    )
    .run();
  await assert.rejects(approvalResponse(g.request(), f.db, f.owner, "test"));
  for (const table of [
    "plan_versions",
    "tasks",
    "scheduled_occurrences",
    "goal_active_plans",
    "calendar_states",
  ])
    assert.equal(
      (await f.db.prepare(`SELECT count(*) n FROM ${table}`).first()).n,
      0,
    );
  assert.equal(
    (await f.db.prepare("SELECT status FROM goals").first()).status,
    "draft",
  );
  await f.db.prepare("DROP TRIGGER fail_occurrence").run();
  await f.db
    .prepare("INSERT INTO calendar_states(owner_id,revision) VALUES(?,1)")
    .bind(f.owner)
    .run();
  assert.equal(
    (await approvalResponse(g.request(), f.db, f.owner, "test")).status,
    409,
  );
  await f.db.prepare("DELETE FROM calendar_states").run();
  await f.db
    .prepare(
      "UPDATE agent_runs SET reply_json=json_set(reply_json,'$.source','policy') WHERE goal_id=? AND turn_index=1",
    )
    .bind(g.id)
    .run();
  assert.equal(
    (await approvalResponse(g.request(), f.db, f.owner, "test")).status,
    409,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    0,
  );
});

test("a newer answer invalidates the shown preview even when no goal fields changed", async (t) => {
  const f = await setup(t),
    g = await f.goal();
  await f.db
    .prepare(
      "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,created_at,updated_at,lease_until) VALUES(?,?,?,'later-answer','{}',3,0,'我还有补充','failed','clarify-v3.1',1,1,0)",
    )
    .bind(globalThis.crypto.randomUUID(), g.id, f.owner)
    .run();
  assert.equal(
    (await approvalResponse(g.request(), f.db, f.owner, "test")).status,
    409,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    0,
  );
});

test("a collision arriving between recheck and commit cannot bypass the atomic admission predicate", async (t) => {
  const f = await setup(t),
    g = await f.goal();
  let injected = false;
  const db = {
    prepare: (...args) => f.db.prepare(...args),
    batch: async (statements) => {
      if (statements.length >= 6 && !injected) {
        injected = true;
        const p = g.schedule.preview.placements[0];
        await f.db
          .prepare(
            "INSERT INTO calendar_events(id,owner_id,title,start_at,end_at,timezone,created_at) VALUES(?,?,'测试占用',?,?,'Asia/Shanghai',1)",
          )
          .bind(globalThis.crypto.randomUUID(), f.owner, p.start_at, p.end_at)
          .run();
      }
      return f.db.batch(statements);
    },
  };
  assert.equal(
    (await approvalResponse(g.request(), db, f.owner, "test")).status,
    409,
  );
  assert.equal(injected, true);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    0,
  );
});
