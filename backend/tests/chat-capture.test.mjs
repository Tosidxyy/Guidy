import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { dialogueResponse } from "../src/agent/harness.ts";
import { chatCapture, nextChatSlot } from "../src/agent/chat-capture.ts";

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
        .map((s) => db.prepare(s)),
    );
  }
  const owner = "capture-test",
    goal = globalThis.crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
    )
    .bind(owner, "Test", "capture@example.invalid")
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
  let calls = 0;
  const provider = {
    complete: async (context) => {
      calls++;
      const c = JSON.parse(context);
      const answer = c.user_message;
      const suggestions =
        c.answer_to && answer !== "暂不确定"
          ? [{ key: c.answer_to, text: answer, evidence: answer }]
          : [];
      const next =
        c.answer_to === "outcome"
          ? "available_time"
          : c.answer_to === "available_time"
            ? "constraints"
            : c.answer_to === "constraints"
              ? null
              : "outcome";
      return {
        content: JSON.stringify({
          question:
            next === "outcome"
              ? "你希望达到什么结果？"
              : next === "available_time"
                ? "每周有哪些可用时间？"
                : next === "constraints"
                  ? "有哪些限制或资源？"
                  : "还有想补充的内容吗？",
          reason: "补齐必要信息",
          requested_slot: next,
          suggestions,
        }),
        inputTokens: 10,
        outputTokens: 20,
      };
    },
  };
  const req = (text, key, chat = 0, revision = 0) =>
    new globalThis.Request(`http://localhost/api/v1/goals/${goal}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({
        text,
        expected_chat_revision: chat,
        expected_goal_revision: revision,
      }),
    });
  const post = (text, key, chat = 0, revision = 0, p = provider) =>
    dialogueResponse(req(text, key, chat, revision), db, owner, "test", {}, p);
  const get = () =>
    dialogueResponse(
      new globalThis.Request(`http://localhost/api/v1/goals/${goal}/messages`),
      db,
      owner,
      "test",
      {},
    );
  return { db, goal, owner, provider, req, post, get, calls: () => calls };
}

test("only the current targeted complete user answer is admitted; ambiguity, inference and corrections remain pending", () => {
  const prev = {
    id: "question",
    goal_revision: 0,
    requested_slot: "outcome",
    source: "deepseek",
  };
  const s = (text) => [{ key: "outcome", text, evidence: text }];
  assert.equal(
    chatCapture("能用英语完成旅行交流", s("能用英语完成旅行交流"), prev, 0, [])
      .value.state,
    "confirmed",
  );
  for (const text of [
    "可能能完成",
    "怎么学习？",
    "其实我想换目标",
    "请帮我搜索",
    "改成商务英语",
    "x".repeat(301),
  ])
    assert.equal(chatCapture(text, s(text), prev, 0, []), null);
  assert.equal(
    chatCapture("我要能交流，每天30分钟", s("我要能交流"), prev, 0, []),
    null,
  );
  assert.equal(chatCapture("能交流", s("能交流"), prev, 1, []), null);
  assert.equal(
    chatCapture("能交流", s("能交流"), { ...prev, source: "policy" }, 0, []),
    null,
  );
  assert.equal(
    chatCapture(
      "能交流",
      [{ key: "available_time", text: "能交流", evidence: "能交流" }],
      prev,
      0,
      [],
    ),
    null,
  );
  assert.equal(chatCapture("暂不确定", [], prev, 0, []).value.state, "unknown");
  assert.equal(
    nextChatSlot([
      { key: "outcome", value: { state: "confirmed" } },
      { key: "available_time", value: { state: "confirmed" } },
      { key: "constraints", value: { state: "unknown" } },
    ]),
    null,
  );
});

test("chat answers atomically save private conditions with evidence, current snapshots and replay without extra calls", async (t) => {
  const f = await setup(t);
  assert.equal((await f.post("开始澄清", "capture-start")).status, 200);
  const answer = "能用英语完成旅行交流";
  const two = await f.post(answer, "capture-outcome", 1, 0);
  assert.equal(two.status, 200);
  const a = (await two.json()).data;
  assert.equal(a.goal.revision, 1);
  assert.equal(a.runs[1].reply.requested_slot, "available_time");
  assert.equal((await f.post(answer, "capture-outcome", 1, 0)).status, 200);
  assert.equal(f.calls(), 2);
  assert.equal(
    (await f.post("工作日晚上八点后半小时", "capture-time", 2, 1)).status,
    200,
  );
  assert.equal((await f.post("暂不确定", "capture-unknown", 3, 2)).status, 200);
  const snapshot = (await (await f.get()).json()).data;
  assert.equal(snapshot.goal.revision, 3);
  assert.equal(snapshot.runs[3].reply.stage, "research_ready");
  assert.equal(snapshot.runs[3].reply.requested_slot, null);
  const captures = (
    await f.db
      .prepare(
        "SELECT * FROM chat_condition_captures ORDER BY resulting_goal_revision",
      )
      .all()
  ).results;
  assert.equal(captures.length, 3);
  assert.equal(captures[0].evidence, answer);
  assert.equal(captures[0].question_run_id, snapshot.runs[0].id);
  assert.deepEqual(
    captures.map((c) => c.resulting_goal_revision),
    [1, 2, 3],
  );
  const slots = (
    await f.db
      .prepare(
        "SELECT key,value_json,source,confirmed_at FROM goal_slots ORDER BY key",
      )
      .all()
  ).results;
  assert.equal(
    slots.every((s) => s.source === "user"),
    true,
  );
  assert.equal(
    JSON.parse(slots.find((s) => s.key === "outcome").value_json).text,
    answer,
  );
  const unknown = slots.find((s) => s.key === "constraints");
  assert.equal(unknown.confirmed_at, null);
  assert.equal(JSON.parse(unknown.value_json).text, "");
  assert.equal((await f.post("能交流", "capture-outcome", 1, 0)).status, 409);
  assert.equal(
    (await f.db.prepare("SELECT active_plan_version_id FROM goals").first())
      .active_plan_version_id,
    null,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_attempts").first())
      .n,
    0,
  );
  await f.db.prepare("DELETE FROM goals WHERE id=?").bind(f.goal).run();
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM chat_condition_captures")
        .first()
    ).n,
    0,
  );
});

test("partial or wrong-key suggestions never confirm facts; unknown mandatory answers keep asking", async (t) => {
  const f = await setup(t);
  await f.post("开始", "capture-start");
  const bad = {
    complete: async () => ({
      content: JSON.stringify({
        question: "每周有哪些时间？",
        reason: "下一步",
        requested_slot: "available_time",
        suggestions: [
          { key: "available_time", text: "能交流", evidence: "能交流" },
        ],
      }),
      inputTokens: null,
      outputTokens: null,
    }),
  };
  const result = await f.post("能交流", "capture-wrong", 1, 0, bad);
  assert.equal(result.status, 200);
  const b = (await result.json()).data;
  assert.equal(b.goal.revision, 0);
  assert.equal(b.runs[1].reply.requested_slot, "outcome");
  assert.equal((await f.post("暂不确定", "capture-unknown", 2, 0)).status, 200);
  const latest = (await (await f.get()).json()).data;
  assert.equal(latest.goal.revision, 1);
  assert.equal(latest.runs[2].reply.stage, "clarifying");
  assert.equal(latest.runs[2].reply.requested_slot, "outcome");
  assert.equal(
    (await f.post("大概能交流", "capture-ambiguous", 3, 1)).status,
    200,
  );
  assert.equal((await (await f.get()).json()).data.goal.revision, 1);
});

test("version changes during model calls reject the entire capture and history policy blocks future admission", async (t) => {
  const f = await setup(t);
  await f.post("开始", "capture-start");
  let enter, release;
  const started = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  const delayed = {
    complete: async (context) => {
      enter();
      await gate;
      return f.provider.complete(context);
    },
  };
  const pending = f.post("能完成旅行交流", "capture-race", 1, 0, delayed);
  await started;
  await f.db
    .prepare("UPDATE goals SET revision=1 WHERE id=?")
    .bind(f.goal)
    .run();
  release();
  assert.equal((await pending).status, 409);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM chat_condition_captures")
        .first()
    ).n,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM goal_slots").first()).n,
    0,
  );
  assert.equal(
    (await f.post("能完成旅行交流", "capture-race", 1, 0)).status,
    200,
  );
  const policy = await f.post("我有伤病", "capture-policy", 2, 1);
  assert.equal(policy.status, 200);
  const later = await f.post("没有伤病", "capture-later", 3, 1);
  assert.equal(later.status, 200);
  assert.equal((await later.json()).data.runs.at(-1).reply.source, "policy");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM goal_slots").first()).n,
    0,
  );
  const foreign = await dialogueResponse(
    f.req("text", "capture-foreign", 4, 1),
    f.db,
    "other-owner",
    "test",
    {},
    f.provider,
  );
  assert.equal(foreign.status, 404);
});

test("a failed provenance insert rolls back condition and goal changes together with the assistant reply", async (t) => {
  const f = await setup(t);
  await f.post("开始", "rollback-start");
  const before = (await (await f.get()).json()).data;
  let enter, release;
  const started = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  const delayed = {
    complete: async (context) => {
      enter();
      await gate;
      return f.provider.complete(context);
    },
  };
  const pending = f.post("能在旅行中交流", "rollback-answer", 1, 0, delayed);
  await started;
  await f.db
    .prepare("DELETE FROM agent_runs WHERE id=?")
    .bind(before.runs[0].id)
    .run();
  release();
  assert.equal((await pending).status, 502);
  assert.equal(
    (await f.db.prepare("SELECT revision FROM goals").first()).revision,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM goal_slots").first()).n,
    0,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM chat_condition_captures")
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM agent_messages WHERE role='assistant'")
        .first()
    ).n,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT status FROM agent_runs").first()).status,
    "failed",
  );
});
