import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { searchResponse } from "../src/research/search-service.ts";
import { reviewResponse } from "../src/agent/review-service.ts";
import { createApp } from "../src/index.ts";
const env = {};
async function fixture(t) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: "2026-10-09",
      d1Databases: ["DB"],
      d1Persist: false,
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL("../migrations/" + name, import.meta.url),
      "utf8",
    );
    await db.batch(
      sql
        .replace(/^[ \t]*--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((q) => db.prepare(q)),
    );
  }
  const owner = "search-test-owner",
    goal = globalThis.crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
    )
    .bind(owner, "Test", "search@example.invalid")
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
    .bind(goal, owner, "学习英语")
    .run();
  for (const key of ["outcome", "available_time"])
    await db
      .prepare(
        "INSERT INTO goal_slots(id,goal_id,key,value_json,source,confirmed_at,updated_at) VALUES(?,?,?,?,'user',1,1)",
      )
      .bind(
        globalThis.crypto.randomUUID(),
        goal,
        key,
        JSON.stringify({
          schema_version: 1,
          state: "confirmed",
          text: "基础学习每天半小时",
        }),
      )
      .run();
  const request = (key, query = "英语学习方法", revision = 0) =>
    new globalThis.Request(
      `http://127.0.0.1/api/v1/goals/${goal}/search-runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ query, expected_revision: revision }),
      },
    );
  const get = () =>
    new globalThis.Request(`http://127.0.0.1/api/v1/goals/${goal}/search-runs`);
  let calls = 0;
  const provider = {
    search: async () => {
      calls++;
      return {
        provider: "doubao-custom",
        provider_request_id: "synthetic",
        searched_at: Date.now(),
        sources: [],
      };
    },
  };
  const post = (key, query, revision) =>
    searchResponse(
      request(key, query, revision),
      db,
      owner,
      "test",
      env,
      provider,
    );
  return { db, owner, goal, request, get, provider, post, calls: () => calls };
}

async function setup(t) {
  const f = await fixture(t),
    attemptId = globalThis.crypto.randomUUID(),
    taskId = globalThis.crypto.randomUUID(),
    sourceId = globalThis.crypto.randomUUID();
  const draft = {
    schema_version: 1,
    status: "draft",
    verification_status: "unverified",
    title: "学习草稿",
    summary: "学习与复盘",
    assumptions: [],
    risks: ["资料未核实"],
    tasks: [
      {
        id: taskId,
        key: "t1",
        stage: 1,
        title: "练习",
        instructions: "练习并复盘",
        duration_minutes: 20,
        frequency_per_week: 3,
        mandatory: true,
        depends_on: [],
        evidence_ids: [sourceId],
      },
    ],
    weekly_minutes: 60,
    time_fit: "needs_user_review",
    cost_status: "unknown",
    scheduling_status: "not_checked",
  };
  await f.db
    .prepare(
      "INSERT INTO plan_draft_attempts(id,goal_id,owner_id,goal_revision,request_key,request_payload,context_json,status,draft_json,created_at,lease_until) VALUES(?,?,?,0,?,'{}','{}','succeeded',?,1,1)",
    )
    .bind(attemptId, f.goal, f.owner, attemptId, JSON.stringify(draft))
    .run();
  const request = (key, minutes = 30, frequency = 2, revision = 0) =>
    new globalThis.Request(
      `http://127.0.0.1/api/v1/goals/${f.goal}/draft-reviews?attempt_id=${attemptId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({
          expected_goal_revision: 0,
          expected_review_revision: revision,
          changes: [
            {
              task_id: taskId,
              duration_minutes: minutes,
              frequency_per_week: frequency,
            },
          ],
        }),
      },
    );
  const get = () =>
    new globalThis.Request(
      `http://127.0.0.1/api/v1/goals/${f.goal}/draft-reviews?attempt_id=${attemptId}`,
    );
  const post = (...args) =>
    reviewResponse(request(...args), f.db, f.owner, "test");
  return { ...f, attemptId, taskId, draft, request, get, post };
}
test("manual adjustments preserve original/task IDs/references/core rows and append immutable replayable versions", async (t) => {
  const f = await setup(t);
  const first = await f.post("review-key-one");
  assert.equal(first.status, 200);
  const one = (await first.json()).data;
  assert.equal(one.current_revision, 1);
  assert.equal(one.receipt_revision, 1);
  assert.equal(one.reviews[0].draft.tasks[0].duration_minutes, 30);
  assert.equal(one.source.draft.tasks[0].duration_minutes, 20);
  assert.equal(one.reviews[0].draft.tasks[0].id, f.taskId);
  assert.deepEqual(
    one.reviews[0].draft.tasks[0].evidence_ids,
    f.draft.tasks[0].evidence_ids,
  );
  assert.equal((await f.post("review-key-two", 15, 7, 1)).status, 200);
  const replay = (await (await f.post("review-key-one")).json()).data;
  assert.equal(replay.current_revision, 2);
  assert.equal(replay.receipt_revision, 1);
  assert.equal(replay.reviews[0].draft.weekly_minutes, 105);
  assert.equal(replay.reviews[1].draft.tasks[0].duration_minutes, 30);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    2,
  );
  assert.equal(
    JSON.parse(
      (await f.db.prepare("SELECT draft_json FROM plan_draft_attempts").first())
        .draft_json,
    ).tasks[0].duration_minutes,
    20,
  );
  const goal = await f.db
    .prepare("SELECT revision,active_plan_version_id FROM goals")
    .first();
  assert.equal(goal.revision, 0);
  assert.equal(goal.active_plan_version_id, null);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_usage").first()).n,
    0,
  );
  await f.db.prepare("DELETE FROM goals WHERE id=?").bind(f.goal).run();
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    0,
  );
});
test("invalid values, unsupported fields, unknown tasks, stale versions and owners cannot overwrite reviews", async (t) => {
  const f = await setup(t);
  for (const [minutes, freq] of [
    [0, 3],
    [121, 3],
    [20, 0],
    [20, 8],
    ["30", 3],
    [20.5, 3],
  ])
    assert.equal(
      (await f.post("bad-" + String(minutes) + "-" + freq, minutes, freq))
        .status,
      422,
    );
  assert.equal((await f.post("unchanged-values", 20, 3)).status, 422);
  const request = f.request("unsupported-fields");
  const body = await request.json();
  body.changes[0].status = "confirmed";
  assert.equal(
    (
      await reviewResponse(
        new globalThis.Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(body),
        }),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    422,
  );
  assert.equal(
    (await reviewResponse(f.get(), f.db, "another-owner", "test")).status,
    404,
  );
  await f.post("valid-review-key");
  assert.equal((await f.post("same-key-changed", 40, 2, 0)).status, 409);
  assert.equal((await f.post("valid-review-key", 40, 2, 0)).status, 409);
  await f.db
    .prepare("UPDATE goals SET revision=1 WHERE id=?")
    .bind(f.goal)
    .run();
  assert.equal((await f.post("changed-goal-key", 40, 2, 1)).status, 409);
  assert.equal(
    (await (await reviewResponse(f.get(), f.db, f.owner, "test")).json()).data
      .can_edit,
    false,
  );
});
test("concurrent saves claim one next revision; review endpoint requires authentication", async (t) => {
  const f = await setup(t);
  const results = await Promise.all([
    f.post("concurrent-review-a", 30, 2),
    f.post("concurrent-review-b", 40, 2),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    1,
  );
  const app = createApp({ logger: () => {} }),
    auth = {
      DB: f.db,
      GUIDY_AUTH_MODE: "local-inbox",
      BETTER_AUTH_SECRET: "test-only-unshared-secret-at-least-32-bytes",
      BETTER_AUTH_URL: "http://127.0.0.1:8787",
    };
  for (const r of [f.get(), f.request("anonymous-review")])
    assert.equal((await app.fetch(r, auth)).status, 401);
});

test("version ceiling is read-only and database rejects a review attached to another goal", async (t) => {
  const f = await setup(t);
  for (let i = 1; i <= 20; i++)
    await f.db
      .prepare(
        "INSERT INTO plan_draft_reviews(id,attempt_id,goal_id,owner_id,revision,goal_revision,request_key,request_payload,draft_json,created_at) VALUES(?,?,?,?,?,0,?,'{}',?,1)",
      )
      .bind(
        globalThis.crypto.randomUUID(),
        f.attemptId,
        f.goal,
        f.owner,
        i,
        "seed-" + i,
        JSON.stringify(f.draft),
      )
      .run();
  const snapshot = (
    await (await reviewResponse(f.get(), f.db, f.owner, "test")).json()
  ).data;
  assert.equal(snapshot.current_revision, 20);
  assert.equal(snapshot.can_edit, false);
  assert.equal((await f.post("over-limit-review", 40, 2, 20)).status, 409);
  const other = globalThis.crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO goals(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,1,1)",
    )
    .bind(other, f.owner, "其他目标")
    .run();
  await assert.rejects(
    f.db
      .prepare(
        "INSERT INTO plan_draft_reviews(id,attempt_id,goal_id,owner_id,revision,goal_revision,request_key,request_payload,draft_json,created_at) VALUES(?,?,?,?,1,0,'wrong-parent','{}',?,1)",
      )
      .bind(
        globalThis.crypto.randomUUID(),
        f.attemptId,
        other,
        f.owner,
        JSON.stringify(f.draft),
      )
      .run(),
  );
});

test("weekly capacity saves independently, replays exactly and legacy clients preserve it", async (t) => {
  const f = await setup(t);
  async function save(key, capacity, revision = 0, minutes = 20) {
    const r = f.request(key, minutes, 3, revision);
    const b = await r.json();
    if (capacity !== undefined) b.weekly_capacity_minutes = capacity;
    return reviewResponse(
      new globalThis.Request(r.url, {
        method: "POST",
        headers: r.headers,
        body: JSON.stringify(b),
      }),
      f.db,
      f.owner,
      "test",
    );
  }
  for (const c of [-1, 10081, 1.5, "90", {}, true])
    assert.equal((await save("invalid-capacity-" + String(c), c)).status, 422);
  const a = await save("capacity-only-save", 50);
  assert.equal(a.status, 200);
  const first = (await a.json()).data;
  assert.equal(first.reviews[0].weekly_capacity_minutes, 50);
  assert.equal(first.reviews[0].draft.weekly_minutes, 60);
  assert.deepEqual(first.source.draft, first.reviews[0].draft);
  assert.equal(
    (await save("legacy-preserve-save", undefined, 1, 30)).status,
    200,
  );
  const replay = (await (await save("capacity-only-save", 50)).json()).data;
  assert.equal(replay.receipt_revision, 1);
  assert.equal(replay.reviews[0].weekly_capacity_minutes, 50);
  assert.equal(replay.reviews[1].weekly_capacity_minutes, 50);
  assert.equal((await save("capacity-only-save", 60)).status, 409);
  assert.equal((await save("capacity-stale-save", 90, 1, 30)).status, 409);
  assert.equal((await save("capacity-zero-save", 0, 2, 30)).status, 200);
  assert.equal((await save("capacity-unknown-save", null, 3, 30)).status, 200);
  assert.equal((await save("capacity-unchanged", null, 4, 30)).status, 422);
  const snap = (
    await (await reviewResponse(f.get(), f.db, f.owner, "test")).json()
  ).data;
  assert.equal(snap.reviews[0].weekly_capacity_minutes, null);
  assert.equal(snap.reviews[1].weekly_capacity_minutes, 0);
  assert.equal(snap.source.draft.weekly_minutes, 60);
  await assert.rejects(
    f.db
      .prepare("UPDATE plan_draft_reviews SET weekly_capacity_minutes=-1")
      .run(),
  );
  assert.equal(
    (await f.db.prepare("SELECT revision FROM goals").first()).revision,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_usage").first()).n,
    0,
  );
});
