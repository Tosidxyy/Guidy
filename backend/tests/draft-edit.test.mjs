import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  planningStatements,
  decidePlanning,
  generatePlanning,
  planningResponse,
} from "../src/agent/planning-jobs.ts";
import { parseDraftEdit } from "../src/agent/draft-edit.ts";
import { dialogueResponse } from "../src/agent/harness.ts";
import { reviewResponse } from "../src/agent/review-service.ts";
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
async function ready(t) {
  const f = await setup(t);
  await decidePlanning(f.db, f.id, {}, f.intent(false));
  await generatePlanning(f.db, f.id, {}, f.model);
  return f;
}
function message(f, text, key, chat = 1) {
  return dialogueResponse(
    new globalThis.Request(
      "http://localhost/api/v1/goals/" + f.goal + "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({
          text,
          expected_chat_revision: chat,
          expected_goal_revision: 0,
        }),
      },
    ),
    f.db,
    f.owner,
    "test",
    {},
  );
}
async function confirm(f, run, override = {}, key = "chat_edit_" + run.id) {
  const p = run.reply.edit_proposal;
  return reviewResponse(
    new globalThis.Request(
      "http://localhost/api/v1/goals/" +
        f.goal +
        "/draft-reviews?attempt_id=" +
        p.attempt_id,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({
          expected_goal_revision: p.goal_revision,
          expected_review_revision: p.review_revision,
          proposal_run_id: run.id,
          changes: [{ task_id: p.task_id, ...p.after }],
          ...override,
        }),
      },
    ),
    f.db,
    f.owner,
    "test",
  );
}
test("numeric natural-language edits are grounded to one task and reject ambiguous or unsafe changes", () => {
  const task = {
    id: "test",
    title: "基础练习",
    duration_minutes: 20,
    frequency_per_week: 3,
  };
  for (const input of [
    "把第一项改成每次15分钟，每周4次",
    "把第１项改为每次十五分钟，每周四次",
    "把第 1 项改为每次15分钟，每周4次",
    "基础练习调整为每次15分钟和每周4次",
  ])
    assert.deepEqual(parseDraftEdit(input, [task]).after, {
      duration_minutes: 15,
      frequency_per_week: 4,
    });
  assert.equal(
    parseDraftEdit("第一项改为每次30分钟", [task]).after.frequency_per_week,
    3,
  );
  for (const input of [
    "第一项改为每次0分钟",
    "第一项改为每次121分钟",
    "第一项改为每周八次",
    "第一项从每次20分钟改为10分钟",
    "第一项改短一点",
    "第一项和第二项改为每次15分钟",
    "不是第一项改为每次15分钟",
    "第一项改为每次15分钟并安排日历",
  ])
    assert.equal(parseDraftEdit(input, [task]), null);
});
test("chat proposes a diff without models or writes, then explicit confirmation appends an immutable version and replay receipt", async (t) => {
  const f = await ready(t);
  const before = f.counts();
  const response = await message(
    f,
    "把第一项改成每次15分钟，每周4次",
    "chat-edit-one",
  );
  assert.equal(response.status, 200);
  const data = (await response.json()).data,
    run = data.runs.at(-1);
  assert.equal(run.reply.stage, "edit_proposed");
  assert.equal(data.clarification_budget.used, 0);
  assert.deepEqual(f.counts(), before);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    0,
  );
  assert.equal(
    (await message(f, "把第一项改成每次15分钟，每周4次", "chat-edit-one"))
      .status,
    200,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM agent_runs").first()).n,
    2,
  );
  const result = await confirm(f, run);
  assert.equal(result.status, 200);
  const review = (await result.json()).data;
  assert.equal(review.receipt_revision, 1);
  assert.equal(review.reviews[0].draft.tasks[0].duration_minutes, 15);
  assert.equal(review.source.draft.tasks[0].duration_minutes, 20);
  assert.equal(
    review.reviews[0].draft.tasks[0].id,
    review.source.draft.tasks[0].id,
  );
  assert.equal((await confirm(f, run)).status, 200);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    1,
  );
  const get = await dialogueResponse(
    new globalThis.Request(
      "http://localhost/api/v1/goals/" + f.goal + "/messages",
    ),
    f.db,
    f.owner,
    "test",
    {},
  );
  assert.equal((await get.json()).data.runs.at(-1).edit_receipt_revision, 1);
  const jobs = (await (await f.get()).json()).data;
  assert.equal(jobs.jobs[0].review.revision, 1);
  assert.equal(jobs.jobs[0].review.draft.tasks[0].duration_minutes, 15);
  const goal = await f.db
    .prepare("SELECT revision,active_plan_version_id FROM goals")
    .first();
  assert.equal(goal.revision, 0);
  assert.equal(goal.active_plan_version_id, null);
});
test("tampering and competing proposals cannot silently change fields or overwrite another review", async (t) => {
  const f = await ready(t);
  const a = (
    await (await message(f, "第一项改为每次15分钟", "chat-edit-a")).json()
  ).data.runs.at(-1);
  const b = (
    await (await message(f, "第一项改为每次25分钟", "chat-edit-b", 2)).json()
  ).data.runs.at(-1);
  assert.equal(
    (
      await confirm(f, a, {
        changes: [
          {
            task_id: a.reply.edit_proposal.task_id,
            duration_minutes: 80,
            frequency_per_week: 3,
          },
        ],
      })
    ).status,
    422,
  );
  assert.equal((await confirm(f, a, {}, "forged-key")).status, 422);
  assert.equal((await confirm(f, a)).status, 200);
  assert.equal((await confirm(f, b)).status, 409);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    1,
  );
});
test("unsupported language remains guidance, policy blocks confirmation and another account cannot propose", async (t) => {
  const f = await ready(t);
  const a = (
    await (await message(f, "第一项改为每次15分钟", "safe-edit")).json()
  ).data.runs.at(-1);
  const guidance = await message(f, "第一项改短一点", "vague-edit", 2);
  assert.equal(guidance.status, 200);
  assert.equal(
    (await guidance.json()).data.runs.at(-1).reply.stage,
    "edit_guidance",
  );
  const risk = await message(
    f,
    "因为我有伤病，把第一项改为每次15分钟",
    "risk-edit",
    3,
  );
  assert.equal(risk.status, 200);
  assert.equal((await risk.json()).data.runs.at(-1).reply.source, "policy");
  assert.equal((await confirm(f, a)).status, 409);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    0,
  );
  const foreign = await dialogueResponse(
    new globalThis.Request(
      "http://localhost/api/v1/goals/" + f.goal + "/messages",
    ),
    f.db,
    "other",
    "test",
    {},
  );
  assert.equal(foreign.status, 404);
});

test("a newer generated source invalidates old proposals without touching their original draft", async (t) => {
  const f = await ready(t),
    a = (
      await (
        await message(f, "第一项改为每次15分钟", "old-source-proposal")
      ).json()
    ).data.runs.at(-1),
    run = globalThis.crypto.randomUUID(),
    job = globalThis.crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',3,0,'stop','succeeded','clarify-stop-v1',?,1,1,1)",
    )
    .bind(
      run,
      f.goal,
      f.owner,
      run,
      JSON.stringify({ source: "harness", stage: "draft_requested" }),
    )
    .run();
  await f.db
    .prepare(
      "INSERT INTO planning_jobs(id,source_run_id,goal_id,owner_id,goal_revision,status,context_json,created_at,updated_at,lease_until) VALUES(?,?,?,?,0,'queued',?, ?,?,?)",
    )
    .bind(
      job,
      run,
      f.goal,
      f.owner,
      JSON.stringify(f.context),
      Date.now() + 1000,
      Date.now(),
      Date.now() + 600000,
    )
    .run();
  const result = await confirm(f, a);
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error.code, "REVIEW_SOURCE_CHANGED");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    0,
  );
});
