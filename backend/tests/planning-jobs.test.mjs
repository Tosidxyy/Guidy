import { createApp } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  planningStatements,
  decidePlanning,
  researchPlanning,
  generatePlanning,
  planningResponse,
  dispatchPlanning,
} from "../src/agent/planning-jobs.ts";
import { planOutputTool } from "../src/agent/plan-output.ts";
import { checkedPlan } from "../src/agent/plan-schema.ts";
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
  for (const n of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL("../migrations/" + n, import.meta.url),
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
  const owner = "planning-test",
    goal = globalThis.crypto.randomUUID(),
    run = globalThis.crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
    )
    .bind(owner, "Test", "planning@example.invalid")
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,1,1)",
    )
    .bind(owner)
    .run();
  await db
    .prepare(
      "INSERT INTO goals(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,1,1)",
    )
    .bind(goal, owner, "学习韩语")
    .run();
  const reply = {
    schema_version: 1,
    kind: "notice",
    source: "harness",
    stage: "draft_requested",
    requested_slot: null,
    question: "已停止提问",
    reason: "准备草稿",
  };
  await db
    .prepare(
      "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',1,0,'停止','succeeded','clarify-stop-v1',?,1,1,1)",
    )
    .bind(run, goal, owner, run, JSON.stringify(reply))
    .run();
  const context = {
    schema_version: 1,
    generation_mode: "chat_auto_v1",
    goal: { description: "学习韩语", timeframe_note: "" },
    conditions: ["outcome", "available_time", "constraints"].map((key) => ({
      key,
      source: "user",
      confirmed_at: null,
      value: { schema_version: 1, state: "unknown", text: "" },
    })),
  };
  await db.batch(
    planningStatements(db, run, goal, owner, 0, context, Date.now()),
  );
  const row = () =>
    db
      .prepare("SELECT * FROM planning_jobs WHERE source_run_id=?")
      .bind(run)
      .first();
  const job = await row();
  let decisions = 0,
    searches = 0,
    plans = 0;
  const intent = (needs) => ({
    complete: async () => {
      decisions++;
      return {
        content: JSON.stringify({ needs_search: needs, topic: "korean" }),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  });
  const search = {
    search: async (query) => {
      searches++;
      assert.equal(query, "韩语初学者入门学习方法基础课程");
      return {
        provider: "doubao-custom",
        provider_request_id: "test",
        searched_at: 123,
        sources: [
          {
            source_id: globalThis.crypto.randomUUID(),
            title: "Fixture",
            url: "https://example.org/",
            snippet: "摘要",
            content: "受控学习资料",
            content_kind: "provider_content",
            published_at: null,
            verification_status: "unverified",
          },
        ],
      };
    },
  };
  const model = {
    complete: async (text) => {
      plans++;
      const c = JSON.parse(text);
      return {
        content: JSON.stringify({
          title: "韩语试行草稿",
          summary: "练习与复盘",
          assumptions: [],
          risks: ["资料未核实"],
          tasks: [
            {
              key: "t1",
              stage: 1,
              title: "基础练习",
              instructions: "练习并记录困难",
              duration_minutes: 20,
              frequency_per_week: 3,
              mandatory: true,
              depends_on: [],
              evidence_ids: c.sources.length ? ["E1"] : [],
            },
          ],
        }),
        inputTokens: 2,
        outputTokens: 2,
      };
    },
  };
  const get = (user = owner) =>
    planningResponse(
      new globalThis.Request(
        `http://localhost/api/v1/goals/${goal}/planning-runs`,
      ),
      db,
      user,
      "test",
    );
  return {
    db,
    owner,
    goal,
    run,
    context,
    id: job.id,
    row,
    intent,
    search,
    model,
    get,
    counts: () => ({ decisions, searches, plans }),
  };
}
test("automatic search and generation freeze evidence, retain unknowns, checkpoint and never write core plans", async (t) => {
  const f = await setup(t);
  await decidePlanning(f.db, f.id, {}, f.intent(true));
  await researchPlanning(f.db, f.id, {}, f.search);
  await generatePlanning(f.db, f.id, {}, f.model);
  const r = await f.row();
  assert.equal(r.status, "completed");
  assert.deepEqual(f.counts(), { decisions: 1, searches: 1, plans: 1 });
  const dto = (await (await f.get()).json()).data.jobs[0];
  assert.equal(dto.plan.context.sources.length, 1);
  assert.equal(
    dto.plan.draft.tasks[0].evidence_ids[0],
    dto.plan.context.sources[0].source_id,
  );
  assert.ok(
    dto.plan.draft.assumptions.some((s) => s.includes("可投入时间尚未明确")),
  );
  assert.equal(dto.plan.draft.scheduling_status, "not_checked");
  await decidePlanning(f.db, f.id, {}, f.intent(true));
  await researchPlanning(f.db, f.id, {}, f.search);
  await generatePlanning(f.db, f.id, {}, f.model);
  assert.deepEqual(f.counts(), { decisions: 1, searches: 1, plans: 1 });
  await f.db.batch(
    planningStatements(f.db, f.run, f.goal, f.owner, 0, f.context, Date.now()),
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    1,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_usage").first()).n,
    1,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM search_usage").first()).n,
    1,
  );
  const g = await f.db
    .prepare("SELECT revision,active_plan_version_id FROM goals")
    .first();
  assert.equal(g.revision, 0);
  assert.equal(g.active_plan_version_id, null);
  assert.equal((await f.get("other")).status, 404);
  await f.db.prepare("DELETE FROM goals WHERE id=?").bind(f.goal).run();
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_usage").first()).n,
    1,
  );
});
test("no-search personal drafts cannot fabricate citations and remain unverified with explicit assumptions", async (t) => {
  const f = await setup(t);
  await decidePlanning(f.db, f.id, {}, f.intent(false));
  await researchPlanning(f.db, f.id, {}, f.search);
  await generatePlanning(f.db, f.id, {}, f.model);
  assert.equal((await f.row()).status, "completed");
  assert.equal(f.counts().searches, 0);
  const p = (await (await f.get()).json()).data.jobs[0].plan;
  assert.equal(p.context.sources.length, 0);
  assert.equal(p.draft.tasks[0].evidence_ids.length, 0);
  assert.ok(p.draft.assumptions.some((s) => s.includes("未进行外部检索")));
  assert.throws(() => planOutputTool(JSON.stringify({ sources: [] })));
  assert.equal(
    planOutputTool(
      JSON.stringify({ sources: [], generation_mode: "chat_auto_v1" }),
    ).function.strict,
    true,
  );
  const data = {
    title: "test",
    summary: "test",
    assumptions: [],
    risks: [],
    tasks: [
      {
        key: "t1",
        stage: 1,
        title: "test",
        instructions: "test",
        duration_minutes: 20,
        frequency_per_week: 3,
        mandatory: true,
        depends_on: [],
        evidence_ids: ["fake"],
      },
    ],
  };
  assert.throws(() => checkedPlan(JSON.stringify(data), [], true));
});
test("unknown external outcomes cannot retry paid stages; changed context blocks output", async (t) => {
  const f = await setup(t);
  await decidePlanning(f.db, f.id, {}, f.intent(true));
  let calls = 0;
  const failing = {
    search: async () => {
      calls++;
      throw new Error("private body");
    },
  };
  await researchPlanning(f.db, f.id, {}, failing);
  assert.equal((await f.row()).status, "unknown");
  await researchPlanning(f.db, f.id, {}, failing);
  await generatePlanning(f.db, f.id, {}, f.model);
  assert.equal(calls, 1);
  assert.equal(f.counts().plans, 0);
});
test("generation rechecks versions after model results and rejects old frozen context", async (t) => {
  const f = await setup(t);
  await decidePlanning(f.db, f.id, {}, f.intent(false));
  const changing = {
    complete: async (text) => {
      const c = await f.model.complete(text);
      await f.db
        .prepare("UPDATE goals SET revision=1 WHERE id=?")
        .bind(f.goal)
        .run();
      return c;
    },
  };
  await generatePlanning(f.db, f.id, {}, changing);
  assert.equal((await f.row()).status, "failed");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_attempts").first())
      .n,
    0,
  );
});
test("dispatch recovery uses the same workflow ID, GET never dispatches and budgets gate job reservation", async (t) => {
  const f = await setup(t);
  let creates = 0;
  const binding = {
    create: async ({ id, params }) => {
      creates++;
      assert.equal(id, f.id);
      assert.equal(params.jobId, id);
      if (creates === 1) throw new Error();
    },
    get: async () => {
      throw new Error();
    },
  };
  await dispatchPlanning(f.db, binding, f.id);
  assert.equal((await f.row()).error_code, "WORKFLOW_START_FAILED");
  await f.get();
  assert.equal(creates, 1);
  await dispatchPlanning(f.db, binding, f.id);
  await dispatchPlanning(f.db, binding, f.id);
  assert.equal(creates, 2);
  assert.equal((await f.row()).dispatched, 1);
  for (let i = 0; i < 2; i++)
    await f.db
      .prepare(
        "INSERT INTO plan_draft_usage(id,owner_id,created_at) VALUES(?,?,?)",
      )
      .bind(globalThis.crypto.randomUUID(), f.owner, Date.now())
      .run();
  await f.db
    .prepare("UPDATE planning_jobs SET status='failed' WHERE id=?")
    .bind(f.id)
    .run();
  const r = globalThis.crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) SELECT ?,goal_id,owner_id,?,'{}',2,0,'stop','succeeded','clarify-stop-v1',reply_json,1,1,1 FROM agent_runs WHERE id=?",
    )
    .bind(r, r, f.run)
    .run();
  await f.db.batch(
    planningStatements(f.db, r, f.goal, f.owner, 0, f.context, Date.now()),
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    1,
  );
});

test("planning endpoint is registered in the authenticated router and never leaks raw IDs in logs", async (t) => {
  const f = await setup(t),
    logs = [];
  const app = createApp({ logger: (r) => logs.push(r) }),
    env = {
      DB: f.db,
      GUIDY_AUTH_MODE: "local-inbox",
      BETTER_AUTH_SECRET: "test-only-local-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://localhost",
    };
  for (const method of ["GET", "POST"]) {
    const response = await app.fetch(
      new globalThis.Request(
        "http://localhost/api/v1/goals/" + f.goal + "/planning-runs",
        { method },
      ),
      env,
    );
    assert.equal(response.status, 401);
  }
  assert.equal(
    logs.every((r) => r.route === "/api/v1/goals/:id/planning-runs"),
    true,
  );
  assert.equal(JSON.stringify(logs).includes(f.goal), false);
});

test("a late decision cannot advance an expired lease or trigger another paid claim", async (t) => {
  const f = await setup(t);
  const base = f.intent(false);
  const late = {
    complete: async (...args) => {
      const c = await base.complete(...args);
      await f.db
        .prepare("UPDATE planning_jobs SET lease_until=1 WHERE id=?")
        .bind(f.id)
        .run();
      return c;
    },
  };
  await decidePlanning(f.db, f.id, {}, late);
  assert.equal((await f.row()).status, "unknown");
  await decidePlanning(f.db, f.id, {}, base);
  assert.equal(f.counts().decisions, 1);
});
