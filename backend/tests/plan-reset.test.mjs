import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { dialogueResponse } from "../src/agent/harness.ts";
import {
  decidePlanning,
  generatePlanning,
} from "../src/agent/planning-jobs.ts";
import { checkedDialogue } from "../../apps/mobile/src/goals/dialogue.ts";

const cutoff = 1791978470000;
const statements = (sql) =>
  sql
    .replace(/^[ \t]*--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
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
  const path = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(path))
    .filter((f) => f.endsWith(".sql") && !f.startsWith("0018"))
    .sort()) {
    await db.batch(
      statements(await readFile(new URL(file, path), "utf8")).map((s) =>
        db.prepare(s),
      ),
    );
  }
  const owner = "reset-test",
    goal = globalThis.crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
      )
      .bind(owner, "Test", "reset@example.invalid"),
    db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,1,1)",
      )
      .bind(owner),
    db
      .prepare(
        "INSERT INTO goals(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,1,1)",
      )
      .bind(goal, owner, "学韩语"),
    db
      .prepare(
        'INSERT INTO goal_slots(id,goal_id,key,value_json,source,confirmed_at,updated_at) VALUES(?,?,\'outcome\',\'{"schema_version":1,"state":"confirmed","text":"和朋友交流"}\',\'user\',1,1)',
      )
      .bind(globalThis.crypto.randomUUID(), goal),
    db
      .prepare(
        "INSERT INTO plan_draft_usage(id,owner_id,created_at) VALUES('usage',?,1)",
      )
      .bind(owner),
    db
      .prepare(
        "INSERT INTO search_usage(id,owner_id,created_at) VALUES('usage',?,1)",
      )
      .bind(owner),
  ]);
  let turn = 0;
  async function run(id, version, time, text, reply) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,harness_version,context_json,status,reply_json,created_at,updated_at,lease_until) VALUES(?,?,?,?,'{}',?,0,?,?,?,'succeeded',?,?,?,0)",
        )
        .bind(
          id,
          goal,
          owner,
          id,
          ++turn,
          text,
          version,
          JSON.stringify({ private_plan: "old" }),
          JSON.stringify(reply),
          time,
          time,
        ),
      db
        .prepare(
          "INSERT INTO agent_messages(id,run_id,goal_id,role,content,created_at) VALUES(?,?,?,'user',?,?)",
        )
        .bind(id + "-u", id, goal, text, time),
      db
        .prepare(
          "INSERT INTO agent_messages(id,run_id,goal_id,role,content,created_at) VALUES(?,?,?,'assistant',?,?)",
        )
        .bind(id + "-a", id, goal, JSON.stringify(reply), time),
    ]);
  }
  for (const topic of ["outcome", "available_time", "constraints"])
    await run(topic, "clarify-v3.1", 1, "真实回答 " + topic, {
      schema_version: 1,
      kind: "question",
      question: "测试问题",
      reason: "测试",
      source: "deepseek",
      requested_slot: topic,
      stage: "clarifying",
    });
  await run(
    "stop",
    "clarify-stop-v1",
    1,
    "根据当前回答开始制订：我想和朋友交流",
    {
      schema_version: 1,
      kind: "notice",
      question: "开始",
      reason: "测试",
      source: "harness",
      requested_slot: null,
      stage: "draft_requested",
    },
  );
  await run(
    "schedule",
    "schedule-chat-v1",
    1,
    "请根据现有信息直接拟定一周安排。",
    { schedule: { private_plan: "old" } },
  );
  await run("edit", "draft-edit-v1", 1, "每次改成20分钟", {
    edit_proposal: { private_plan: "old" },
  });
  await run("new-stop", "clarify-stop-v1", cutoff + 1, "新回答", {
    schema_version: 1,
    kind: "notice",
    question: "开始",
    reason: "测试",
    source: "harness",
    requested_slot: null,
    stage: "draft_requested",
  });
  for (const [id, time, source] of [
    ["old-plan", 1, "stop"],
    ["new-plan", cutoff + 1, "new-stop"],
  ]) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO planning_jobs(id,source_run_id,goal_id,owner_id,goal_revision,status,context_json,created_at,updated_at,lease_until) VALUES(?,?,?,?,0,'completed','{}',?,?,0)",
        )
        .bind(id, source, goal, owner, time, time),
      db
        .prepare(
          "INSERT INTO plan_draft_attempts(id,goal_id,owner_id,goal_revision,request_key,request_payload,context_json,status,draft_json,created_at,lease_until) VALUES(?,?,?,0,?,'{}','{}','succeeded','{}',?,0)",
        )
        .bind(id, goal, owner, id, time),
      db
        .prepare(
          "INSERT INTO plan_draft_reviews(id,attempt_id,goal_id,owner_id,revision,goal_revision,request_key,request_payload,draft_json,created_at) VALUES(?,?,?,?,1,0,?,'{}','{}',?)",
        )
        .bind(id + "review", id, goal, owner, id + "review", time),
      db
        .prepare(
          "INSERT INTO search_attempts(id,goal_id,owner_id,goal_revision,request_key,query,provider,status,result_json,created_at,lease_until) VALUES(?,?,?,0,?,'通用问题','doubao-custom','succeeded','{}',?,0)",
        )
        .bind(id + "search", goal, owner, id + "search", time),
    ]);
  }
  await db
    .prepare(
      "INSERT INTO calendar_events(id,owner_id,title,start_at,end_at,timezone,created_at,source_run_id) VALUES('fixed',?,'真实占用',1,2,'Asia/Shanghai',1,'edit')",
    )
    .bind(owner)
    .run();
  const migration = statements(
    await readFile(new URL("0018_clear_old_generated_plans.sql", path), "utf8"),
  );
  return { db, owner, goal, migration };
}

test("reset clears generated copies, preserves answers/facts/budgets and never removes post-cutoff plans", async (t) => {
  const f = await setup(t),
    { db } = f;
  const before = await db
    .prepare(
      "SELECT id,user_text,turn_index FROM agent_runs ORDER BY turn_index",
    )
    .all();
  await db.batch(f.migration.map((s) => db.prepare(s)));
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT id,user_text,turn_index FROM agent_runs ORDER BY turn_index",
        )
        .all()
    ).results,
    before.results,
  );
  for (const table of [
    "plan_draft_attempts",
    "plan_draft_reviews",
    "planning_jobs",
    "search_attempts",
  ]) {
    const rows = (await db.prepare(`SELECT id FROM ${table}`).all()).results;
    assert.equal(rows.length, 1);
    assert.ok(rows[0].id.startsWith("new-plan"));
  }
  for (const table of [
    '"user"',
    "profiles",
    "goals",
    "goal_slots",
    "calendar_events",
    "plan_draft_usage",
    "search_usage",
  ])
    assert.equal(
      (await db.prepare(`SELECT count(*) n FROM ${table}`).first()).n,
      1,
    );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM agent_messages WHERE role='user'")
        .first()
    ).n,
    7,
  );
  for (const id of ["stop", "schedule", "edit"]) {
    const r = await db
      .prepare("SELECT context_json,reply_json FROM agent_runs WHERE id=?")
      .bind(id)
      .first();
    assert.equal(r.context_json, null);
    assert.equal(JSON.parse(r.reply_json).stage, "plans_cleared");
  }
  assert.equal(
    (
      await db
        .prepare("SELECT content FROM agent_messages WHERE id='stop-a'")
        .first()
    ).content,
    (
      await db
        .prepare("SELECT reply_json FROM agent_runs WHERE id='stop'")
        .first()
    ).reply_json,
  );
  assert.equal(
    (await db.prepare("PRAGMA foreign_key_check").all()).results.length,
    0,
  );
  const r = await dialogueResponse(
    new globalThis.Request(`http://localhost/api/v1/goals/${f.goal}/messages`),
    db,
    f.owner,
    "test",
    { GUIDY_ENVIRONMENT: "development" },
  );
  const snapshot = checkedDialogue((await r.json()).data);
  assert.equal(snapshot.auto_schedule, null);
  assert.equal(snapshot.auto_schedule_key, null); // Legacy fixture IDs cannot become executable request keys.
  assert.equal(snapshot.asked_topics.length, 3);
  let calls = 0;
  const provider = {
    complete() {
      calls++;
      throw new Error("should not call");
    },
  };
  await decidePlanning(db, "old-plan", {}, provider);
  await generatePlanning(db, "old-plan", {}, provider);
  assert.equal(calls, 0);
  await db.batch(f.migration.map((s) => db.prepare(s)));
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM plan_draft_attempts").first()).n,
    1,
  );
});

test("a failing reset batch rolls back all deletions", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.db.batch([
      ...f.migration.map((s) => f.db.prepare(s)),
      f.db.prepare("INSERT INTO missing_reset_table VALUES(1)"),
    ]),
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_attempts").first())
      .n,
    2,
  );
  assert.equal(
    JSON.parse(
      (
        await f.db
          .prepare("SELECT reply_json FROM agent_runs WHERE id='schedule'")
          .first()
      ).reply_json,
    ).schedule.private_plan,
    "old",
  );
});
