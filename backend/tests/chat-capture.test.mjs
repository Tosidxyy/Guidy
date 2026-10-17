import {
  clarificationLimits,
  clarificationBudget,
} from "../src/agent/clarification-budget.ts";
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

test("partial or wrong-key suggestions never confirm facts while unknown answers advance to unasked topics", async (t) => {
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
  assert.equal(b.runs[1].reply.requested_slot, "available_time");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM goal_slots").first()).n,
    0,
  );
  assert.equal((await f.post("暂不确定", "capture-unknown", 2, 0)).status, 200);
  const latest = (await (await f.get()).json()).data;
  assert.equal(latest.goal.revision, 1);
  assert.equal(latest.runs[2].reply.stage, "clarifying");
  assert.equal(latest.runs[2].reply.requested_slot, "constraints");
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

test("delegated time advances to the third core topic without an extra confirmation and can stop after three questions", async (t) => {
  const f = await setup(t);
  await f.post("开始", "delegate-start");
  await f.post("学会基础韩语交流", "delegate-outcome", 1, 0);
  const r = await f.post("你来安排吧", "delegate-time", 2, 1);
  assert.equal(r.status, 200);
  const b = (await r.json()).data;
  assert.equal(b.goal.revision, 2);
  assert.equal(b.runs.at(-1).reply.requested_slot, "constraints");
  assert.equal(b.runs.at(-1).reply.time_proposal, undefined);
  assert.equal(b.asked_topics.length, 3);
  assert.doesNotMatch(b.runs.at(-1).reply.question, /60分钟|愿意先按/);
  const value = JSON.parse(
    (
      await f.db
        .prepare("SELECT value_json FROM goal_slots WHERE key='available_time'")
        .first()
    ).value_json,
  );
  assert.equal(value.state, "unknown");
  assert.equal((await f.post("你来安排吧", "delegate-time", 2, 1)).status, 200);
  const stopped = await f.post(
    "先到这里，请根据现有信息准备方案草稿。",
    "delegate-stop",
    3,
    2,
  );
  assert.equal(stopped.status, 200);
  assert.equal(
    (await stopped.json()).data.runs.at(-1).reply.stage,
    "draft_requested",
  );
  assert.equal(f.calls(), 3);
  const job = await f.db
    .prepare("SELECT context_json FROM planning_jobs")
    .first();
  assert.ok(JSON.parse(job.context_json).dialogue_notes.includes("你来安排吧"));
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    0,
  );
});

test("unknown answers advance once and only an explicit revisit can ask about time again", async (t) => {
  const f = await setup(t);
  await f.post("开始", "unknown-start");
  await f.post("学会基础韩语交流", "unknown-outcome", 1, 0);
  const third = await f.post("暂不确定", "unknown-time", 2, 1);
  assert.equal(
    (await third.json()).data.runs.at(-1).reply.requested_slot,
    "constraints",
  );
  const end = await f.post("暂不确定", "unknown-constraints", 3, 2);
  assert.equal(end.status, 200);
  const b = (await end.json()).data;
  assert.equal(b.runs.at(-1).reply.requested_slot, null);
  assert.equal(b.runs.at(-1).reply.stage, "needs_information");
  assert.equal(b.goal.revision, 3);
  const resume = await f.post(
    "请继续澄清仍未明确的条件。",
    "unknown-resume",
    4,
    3,
  );
  assert.equal(resume.status, 200);
  assert.equal(
    (await resume.json()).data.runs.at(-1).reply.requested_slot,
    "available_time",
  );
});

test("unclassified answers and repeated model topic suggestions cannot prevent the three-card draft option", async (t) => {
  const f = await setup(t);
  const p = {
    complete: async () => ({
      content: JSON.stringify({
        question: "你希望达到什么结果？",
        reason: "了解目标",
        requested_slot: "outcome",
        suggestions: [],
      }),
      inputTokens: 1,
      outputTokens: 1,
    }),
  };
  const first = await f.post("开始", "unclassified-start", 0, 0, p);
  assert.equal(
    (await first.json()).data.runs.at(-1).reply.requested_slot,
    "outcome",
  );
  const second = await f.post("之后再看看", "unclassified-outcome", 1, 0, p);
  assert.equal(
    (await second.json()).data.runs.at(-1).reply.requested_slot,
    "available_time",
  );
  const third = await f.post("你帮我定吧", "unclassified-time", 2, 0, p);
  const state = (await third.json()).data;
  assert.equal(state.runs.at(-1).reply.requested_slot, "constraints");
  assert.equal(state.asked_topics.length, 3);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM goal_slots").first()).n,
    0,
  );
  const stopped = await f.post(
    "根据当前回答开始制订：暂时只有手机，基础未知。",
    "unclassified-stop",
    3,
    0,
    {
      complete: () => {
        throw Error("Stop must not call the model");
      },
    },
  );
  assert.equal(stopped.status, 200);
  assert.equal(
    (await stopped.json()).data.runs.at(-1).reply.stage,
    "draft_requested",
  );
  const context = JSON.parse(
    (await f.db.prepare("SELECT context_json FROM planning_jobs").first())
      .context_json,
  );
  assert.ok(context.conditions.every((s) => s.value.state === "unknown"));
  assert.ok(context.dialogue_notes.includes("暂时只有手机，基础未知。"));
});

test("stop requires three distinct core questions, works without a model at paid quota, and remains policy gated", async (t) => {
  const f = await setup(t),
    message = "先到这里，请根据现有信息准备方案草稿。";
  assert.equal((await f.post(message, "stop-too-early")).status, 422);
  assert.equal(f.calls(), 0);
  await f.post("开始", "stop-start");
  await f.post("学习韩语交流", "stop-outcome", 1, 0);
  await f.post("每天二十分钟", "stop-time", 2, 1);
  const before = (await (await f.get()).json()).data;
  assert.deepEqual([...before.asked_topics].sort(), [
    "available_time",
    "constraints",
    "outcome",
  ]);
  for (let i = 4; i <= 8; i++)
    await f.db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,created_at,updated_at,lease_until) VALUES(?,?,?,?,?, ?,2,'test','failed','clarify-v3.1',?,?,?)",
      )
      .bind(
        globalThis.crypto.randomUUID(),
        f.goal,
        f.owner,
        "quota-seed-" + i,
        "{}",
        i,
        Date.now(),
        Date.now(),
        Date.now(),
      )
      .run();
  const result = await f.post(message, "stop-after-questions", 8, 2);
  assert.equal(result.status, 200);
  const body = (await result.json()).data;
  assert.equal(body.runs.at(-1).reply.kind, "notice");
  assert.equal(body.runs.at(-1).reply.stage, "draft_requested");
  assert.equal(f.calls(), 3);
  assert.equal(body.goal.revision, 2);
  assert.equal(
    (await f.post(message, "stop-after-questions", 8, 2)).status,
    200,
  );
  assert.equal(f.calls(), 3);
  const noProvider = await dialogueResponse(
    f.req(message, "stop-no-provider", 9, 2),
    f.db,
    f.owner,
    "test",
    {},
  );
  assert.equal(noProvider.status, 200);
  assert.equal(
    (await f.post("继续", "quota-still-limited", 10, 2)).status,
    429,
  );
  await f.db
    .prepare("UPDATE goals SET description='我有伤病' WHERE id=?")
    .bind(f.goal)
    .run();
  const safe = await f.post(message, "stop-policy", 10, 2);
  assert.equal(safe.status, 200);
  assert.equal((await safe.json()).data.runs.at(-1).reply.source, "policy");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_attempts").first())
      .n,
    0,
  );
});

test("development daily budget extends existing attempts without deleting records; production retains the original cap", async (t) => {
  const f = await setup(t);
  for (let i = 1; i <= 8; i++)
    await f.db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',?,0,'budget','failed',?,?,1)",
      )
      .bind(
        globalThis.crypto.randomUUID(),
        f.goal,
        f.owner,
        "old-budget-" + i,
        i,
        Date.now(),
        Date.now(),
      )
      .run();
  assert.deepEqual(clarificationLimits({}), { personal: 8, global: 20 });
  assert.deepEqual(clarificationLimits({ GUIDY_ENVIRONMENT: "production" }), {
    personal: 8,
    global: 20,
  });
  const before = await clarificationBudget(f.db, f.owner, {
    GUIDY_ENVIRONMENT: "development",
  });
  assert.equal(before.used, 8);
  assert.equal(before.remaining, 16);
  const r = await dialogueResponse(
    f.req("继续澄清", "development-budget-resume", 8, 0),
    f.db,
    f.owner,
    "test",
    { GUIDY_ENVIRONMENT: "development" },
    f.provider,
  );
  assert.equal(r.status, 200);
  const data = (await r.json()).data;
  assert.equal(data.clarification_budget.used, 9);
  assert.equal(data.clarification_budget.remaining, 15);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM agent_runs").first()).n,
    9,
  );
  for (let i = 10; i <= 24; i++)
    await f.db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',?,0,'budget','failed',?,?,1)",
      )
      .bind(
        globalThis.crypto.randomUUID(),
        f.goal,
        f.owner,
        "new-budget-" + i,
        i,
        Date.now(),
        Date.now(),
      )
      .run();
  const blocked = await dialogueResponse(
    f.req("继续", "development-budget-limit", 24, 0),
    f.db,
    f.owner,
    "test",
    { GUIDY_ENVIRONMENT: "development" },
    f.provider,
  );
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, "AI_DAILY_LIMIT");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM agent_runs").first()).n,
    24,
  );
});

test("development global limit blocks model work without exposing other account usage", async (t) => {
  const f = await setup(t),
    other = "budget-other",
    otherGoal = globalThis.crypto.randomUUID();
  await f.db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
    )
    .bind(other, "Test", "other@example.invalid")
    .run();
  await f.db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,1,1)",
    )
    .bind(other)
    .run();
  await f.db
    .prepare(
      "INSERT INTO goals(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,1,1)",
    )
    .bind(otherGoal, other, "Test")
    .run();
  for (let i = 1; i <= 60; i++)
    await f.db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',?,0,'budget','failed',?,?,1)",
      )
      .bind(
        globalThis.crypto.randomUUID(),
        otherGoal,
        other,
        "global-budget-" + i,
        i,
        Date.now(),
        Date.now(),
      )
      .run();
  const budget = await clarificationBudget(f.db, f.owner, {
    GUIDY_ENVIRONMENT: "development",
  });
  assert.equal(budget.used, 0);
  assert.equal(budget.remaining, 24);
  assert.equal(budget.global_limited, true);
  assert.equal(budget.allowed, false);
  assert.equal(JSON.stringify(budget).includes(other), false);
  const response = await dialogueResponse(
    f.req("开始", "global-budget-blocked"),
    f.db,
    f.owner,
    "test",
    { GUIDY_ENVIRONMENT: "development" },
    f.provider,
  );
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "AI_GLOBAL_LIMIT");
  assert.equal(f.calls(), 0);
});

test("21-day planning requires three answered rounds and freezes its contract without an extra model call", async (t) => {
  const f = await setup(t);
  let r = await f.post(
    "请根据我的目标和已确认条件，提出一个必要的澄清问题。",
    "strategy-start",
  );
  let d = (await r.json()).data;
  for (const [i, text] of ["能独立完成旅行交流", "你来安排吧"].entries()) {
    r = await f.post(
      text,
      "strategy-answer-" + i,
      d.chat_revision,
      d.goal.revision,
    );
    assert.equal(r.status, 200);
    d = (await r.json()).data;
  }
  assert.equal(
    (
      await f.post(
        "制订21天策略。",
        "strategy-too-early",
        d.chat_revision,
        d.goal.revision,
      )
    ).status,
    422,
  );
  r = await f.post(
    "根据当前回答制订21天策略：完全零基础，只用免费资源。",
    "strategy-ready",
    d.chat_revision,
    d.goal.revision,
  );
  assert.equal(r.status, 200);
  assert.equal(f.calls(), 3);
  const row = await f.db
    .prepare("SELECT context_json FROM planning_jobs WHERE goal_id=?")
    .bind(f.goal)
    .first();
  const c = JSON.parse(row.context_json);
  assert.equal(c.planning_contract, "strategy_21_v1");
  assert.ok(c.dialogue_notes.includes("完全零基础，只用免费资源。"));
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    0,
  );
});
