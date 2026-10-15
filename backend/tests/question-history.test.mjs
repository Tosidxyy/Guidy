import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { questionHistoryResponse } from "../src/agent/question-history.ts";
import { checkedHistory } from "../../apps/mobile/src/goals/question-history.ts";
import { createApp } from "../src/index.ts";
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
  const owner = "history-test",
    goal = globalThis.crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
      )
      .bind(owner, "Test", "history@example.invalid"),
    db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,1,1)",
      )
      .bind(owner),
    db
      .prepare(
        "INSERT INTO goals(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,1,1)",
      )
      .bind(goal, owner, "韩语"),
  ]);
  async function run(turn, text, question = true, status = "succeeded") {
    const id = globalThis.crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',?,0,?,?, 'qa',?,1,1,1)",
      )
      .bind(
        id,
        goal,
        owner,
        id,
        turn,
        text,
        status,
        question
          ? JSON.stringify({
              schema_version: 1,
              kind: "question",
              source: "deepseek",
              question: "问题" + turn,
              reason: "了解",
              requested_slot: "outcome",
              stage: "clarifying",
            })
          : JSON.stringify({
              schema_version: 1,
              kind: "notice",
              source: "harness",
              question: "内部阶段",
              reason: "处理",
              stage: "draft_requested",
              requested_slot: null,
            }),
      )
      .run();
  }
  const request = (query = "", method = "GET") =>
    new globalThis.Request(
      "http://localhost/api/v1/goals/" + goal + "/question-history" + query,
      { method },
    );
  const read = async (before) => {
    const response = await questionHistoryResponse(
      request(before === undefined ? "" : "?before=" + before),
      db,
      owner,
      "test",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    return checkedHistory((await response.json()).data, goal, before);
  };
  return { db, owner, goal, run, request, read };
}
test("private history traverses all questions beyond 30, preserves boundary answers and cursor stability without writes", async (t) => {
  const f = await setup(t);
  for (let i = 1; i <= 45; i++)
    await f.run(
      i,
      i === 1
        ? "请根据我的目标和已确认条件，提出一个必要的澄清问题。"
        : "回答" + (i - 1),
    );
  await f.run(46, "根据当前回答开始制订：回答45", false);
  const before = (
    await f.db.prepare("SELECT count(*) n FROM agent_runs").first()
  ).n;
  const first = await f.read();
  assert.equal(first.cards.length, 20);
  assert.equal(first.cards[0].turn_index, 26);
  assert.equal(first.cards.at(-1).answer, "回答45");
  await f.run(47, "请继续问我一个有助于完善方案的问题。");
  const second = await f.read(first.next_before),
    third = await f.read(second.next_before);
  const cards = [...third.cards, ...second.cards, ...first.cards];
  assert.equal(cards.length, 45);
  assert.deepEqual(
    cards.map((c) => c.turn_index),
    Array.from({ length: 45 }, (_, i) => i + 1),
  );
  assert.equal(third.next_before, null);
  assert.equal(cards[0].answer, "回答1");
  assert.equal(second.cards.at(-1).answer, "回答25");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM agent_runs").first()).n,
    before + 1,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM scheduled_occurrences").first())
      .n,
    0,
  );
});
test("history isolates owners, validates cursor/method, retains failed submitted answer and omits controls", async (t) => {
  const f = await setup(t);
  await f.run(1, "fixture");
  await f.run(2, "用户已经提交的回答", false, "failed");
  await f.run(3, "请继续问我一个有助于完善方案的问题。");
  await f.run(4, "请根据现有信息直接拟定一周安排。", false);
  const data = await f.read();
  assert.equal(data.cards[0].answer, "用户已经提交的回答");
  assert.equal(data.cards[1].answer, null);
  assert.equal(
    (await questionHistoryResponse(f.request(), f.db, "other", "test")).status,
    404,
  );
  for (const q of [
    "?before=0",
    "?before=-1",
    "?before=1.2",
    "?before=9007199254740992",
    "?before=1&before=2",
    "?extra=1",
  ])
    assert.equal(
      (await questionHistoryResponse(f.request(q), f.db, f.owner, "test"))
        .status,
      422,
    );
  assert.equal(
    (
      await questionHistoryResponse(
        f.request("", "POST"),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    405,
  );
  assert.equal((await f.read(1)).cards.length, 0);
  const app = createApp({ logger: () => {} });
  const res = await app.fetch(f.request(), {
    DB: f.db,
    BETTER_AUTH_SECRET: "synthetic-only-secret-long-enough",
    BETTER_AUTH_URL: "http://localhost",
    GUIDY_AUTH_MODE: "local-inbox",
  });
  assert.equal(res.status, 401);
});
