import { approvalResponse } from "../src/scheduling/approval.ts";
import { checkedPlanning } from "../../apps/mobile/src/goals/planning.ts";
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
} from "../src/agent/planning-jobs.ts";
import { ASK_AUTO } from "../src/scheduling/chat.ts";
import { checkedDialogue } from "../../apps/mobile/src/goals/dialogue.ts";
import { dialogueResponse } from "../src/agent/harness.ts";
import { calendarResponse } from "../src/scheduling/calendar.ts";
import { createApp } from "../src/index.ts";
test("begin from a filled third card includes that answer without paying for another question", async (t) => {
  const f = await ready(t);
  for (const [i, slot] of [
    "outcome",
    "available_time",
    "constraints",
  ].entries()) {
    const id = globalThis.crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',?,0,'fixture','succeeded','qa',?,1,1,1)",
      )
      .bind(
        id,
        f.goal,
        f.owner,
        id,
        i + 2,
        JSON.stringify({
          schema_version: 1,
          kind: "question",
          source: "deepseek",
          question: "核心问题？",
          reason: "了解",
          requested_slot: slot,
          stage: "clarifying",
        }),
      )
      .run();
  }
  const r = await message(
    f,
    "根据当前回答开始制订：周三没空",
    "card-answer-start",
    4,
  );
  assert.equal(r.status, 200);
  const job = await f.db
    .prepare(
      "SELECT context_json FROM planning_jobs WHERE goal_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(f.goal)
    .first();
  assert.ok(JSON.parse(job.context_json).dialogue_notes.includes("周三没空"));
  assert.equal((await r.json()).data.clarification_budget.used, 0);
});
test("direct suggestions avoid clear unavailable weekdays but never turn conditional examples into facts", async (t) => {
  for (const [note, expected] of [
    ["周三没空", 1],
    ["如果周三没空再说", 0],
    ["不是周三没空", 0],
  ]) {
    const f = await ready(t),
      row = await f.db
        .prepare("SELECT context_json FROM plan_draft_attempts WHERE id=?")
        .bind(f.id)
        .first(),
      context = JSON.parse(row.context_json);
    context.dialogue_notes = [note];
    await f.db
      .prepare("UPDATE plan_draft_attempts SET context_json=? WHERE id=?")
      .bind(JSON.stringify(context), f.id)
      .run();
    const response = checkedDialogue(
      (await (await message(f, ASK_AUTO, `auto_schedule_${f.id}_0_0`)).json())
        .data,
    );
    assert.equal(
      response.auto_schedule.unavailable_from_notes.length,
      expected,
    );
    if (expected)
      assert.ok(
        response.auto_schedule.preview.placements.every(
          (p) => new Date(p.start_at + 8 * 3600000).getUTCDay() !== 3,
        ),
      );
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
      0,
    );
  }
});
test("continued card questions before a completed draft preserve model questions and user notes", async (t) => {
  const f = await setup(t);
  await f.db
    .prepare("UPDATE planning_jobs SET status='failed' WHERE id=?")
    .bind(f.id)
    .run();
  for (const [i, slot] of [
    "outcome",
    "available_time",
    "constraints",
  ].entries()) {
    const id = globalThis.crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',?,0,'fixture','succeeded','qa',?,1,1,1)",
      )
      .bind(
        id,
        f.goal,
        f.owner,
        id,
        i + 2,
        JSON.stringify({
          schema_version: 1,
          kind: "question",
          source: "deepseek",
          question: "核心问题？",
          reason: "了解",
          requested_slot: slot,
          stage: "clarifying",
        }),
      )
      .run();
  }
  let calls = 0;
  const provider = {
    complete: async () => {
      calls++;
      return {
        content: JSON.stringify({
          question:
            calls === 1 ? "你目前有什么基础？" : "你希望独自练习还是结伴练习？",
          reason: "完善方案",
          requested_slot: null,
        }),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const ask = (text, chat, key) =>
    dialogueResponse(
      new globalThis.Request(
        `http://localhost/api/v1/goals/${f.goal}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
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
      provider,
    );
  const more = checkedDialogue(
    (
      await (
        await ask("请继续问我一个有助于完善方案的问题。", 4, "more-card")
      ).json()
    ).data,
  );
  assert.equal(more.runs.at(-1).reply.question, "你目前有什么基础？");
  assert.equal(more.runs.at(-1).reply.stage, "clarifying");
  const answer = checkedDialogue(
    (await (await ask("我有一点基础", 5, "more-answer")).json()).data,
  );
  assert.equal(
    answer.runs.at(-1).reply.question,
    "你希望独自练习还是结伴练习？",
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM goal_slots").first()).n,
    0,
  );
  await ask("先到这里，请根据现有信息准备方案草稿。", 6, "more-plan");
  const job = await f.db
    .prepare(
      "SELECT context_json FROM planning_jobs WHERE goal_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(f.goal)
    .first();
  assert.ok(
    JSON.parse(job.context_json).dialogue_notes.includes("我有一点基础"),
  );
  assert.equal(calls, 2);
});
test("automatic timeline discloses assumptions without asking for windows or confirming user facts", async (t) => {
  const f = await ready(t),
    key = `auto_schedule_${f.id}_0_0`;
  const result = checkedDialogue(
    (await (await message(f, ASK_AUTO, key)).json()).data,
  );
  assert.equal(result.auto_schedule.window_basis, "assumed_default_v1");
  assert.equal(result.auto_schedule.preview.placements.length, 3);
  assert.equal(result.auto_schedule.confirmed_from_run_id, undefined);
  assert.equal(result.runs.at(-1).reply.stage, "schedule_preview");
  assert.equal(result.runs.at(-1).reply.schedule_help, undefined);
  assert.equal(result.clarification_budget.used, 0);
  assert.equal(
    (await (await message(f, ASK_AUTO, key)).json()).data.runs.length,
    2,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM goal_slots").first()).n,
    0,
  );
  assert.equal(
    (await message(f, ASK_AUTO, `auto_schedule_${f.id}_1_0`, 2)).status,
    409,
  );
});
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
  // Isolate manual/chat tests from the automatic timeline now emitted by Workflow completion.
  await f.db
    .prepare("DELETE FROM agent_runs WHERE goal_id=? AND user_text=?")
    .bind(f.goal, ASK_AUTO)
    .run();
  return f;
}
test("calendar reader bounds and authenticated router are registered without logging private queries", async (t) => {
  const f = await ready(t),
    logs = [],
    app = createApp({ logger: (r) => logs.push(r) }),
    env = {
      DB: f.db,
      GUIDY_AUTH_MODE: "local-inbox",
      BETTER_AUTH_SECRET: "test-only-local-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://localhost",
    };
  for (const method of ["GET", "POST"]) {
    const r = await app.fetch(
      new globalThis.Request(
        "http://localhost/api/v1/calendar/fixed-events?from=1&to=2",
        { method },
      ),
      env,
    );
    assert.equal(r.status, 401);
  }
  assert.ok(logs.every((l) => l.route === "/api/v1/calendar/fixed-events"));
  assert.equal(
    (
      await calendarResponse(
        new globalThis.Request(
          "http://localhost/api/v1/calendar/fixed-events?from=1&to=2&owner=other",
        ),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await calendarResponse(
        new globalThis.Request(
          "http://localhost/api/v1/calendar/fixed-events?from=0&to=99999999999999",
        ),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    422,
  );
});
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

test("numeric plan preferences follow Agent questions without creating unusable edit proposals", async (t) => {
  const f = await ready(t);
  let calls = 0;
  const request = () =>
    new globalThis.Request(`http://localhost/api/v1/goals/${f.goal}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "card-effort-preference",
      },
      body: JSON.stringify({
        text: "第一项改为每次15分钟",
        expected_chat_revision: 1,
        expected_goal_revision: 0,
      }),
    });
  const provider = {
    complete: async (context) => {
      calls++;
      assert.equal(JSON.parse(context).user_message, "第一项改为每次15分钟");
      return {
        content: JSON.stringify({
          question: "你希望最终达到什么成果？",
          reason: "将新偏好用于后续方案",
          requested_slot: "outcome",
        }),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const response = await dialogueResponse(
    request(),
    f.db,
    f.owner,
    "test",
    {},
    provider,
  );
  assert.equal(response.status, 200);
  const data = checkedDialogue((await response.json()).data);
  assert.equal(data.runs.at(-1).reply.kind, "question");
  assert.equal(data.runs.at(-1).reply.edit_proposal, undefined);
  assert.equal(data.runs.at(-1).user_text, "第一项改为每次15分钟");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    0,
  );
  assert.equal(
    (await dialogueResponse(request(), f.db, f.owner, "test", {}, provider))
      .status,
    200,
  );
  assert.equal(calls, 1);
});

test("retired window/week/occupancy commands follow Agent cards instead of reopening manual protocols", async (t) => {
  for (const text of [
    "请帮我按每周频次预览首阶段一周。",
    "确认这些时段，预览首阶段各项一次。",
    "已有占用：北京时间，2026-11-01 09:00-18:00",
    "可用时段：北京时间，2026-11-01 20:00-21:00",
  ]) {
    const f = await ready(t);
    let calls = 0;
    const response = await dialogueResponse(
      new globalThis.Request(
        `http://localhost/api/v1/goals/${f.goal}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "retired-command-card",
          },
          body: JSON.stringify({
            text,
            expected_chat_revision: 1,
            expected_goal_revision: 0,
          }),
        },
      ),
      f.db,
      f.owner,
      "test",
      {},
      {
        complete: async (context) => {
          calls++;
          assert.equal(JSON.parse(context).user_message, text);
          return {
            content: JSON.stringify({
              question: "还有哪些偏好希望我一并考虑？",
              reason: "结合你的补充制订方案",
              requested_slot: null,
            }),
            inputTokens: 1,
            outputTokens: 1,
          };
        },
      },
    );
    assert.equal(response.status, 200);
    const data = checkedDialogue((await response.json()).data);
    assert.equal(data.runs.at(-1).reply.kind, "question");
    assert.equal(data.runs.at(-1).reply.source, "deepseek");
    assert.equal(data.runs.at(-1).reply.schedule, undefined);
    assert.equal(data.runs.at(-1).reply.busy, undefined);
    assert.equal(calls, 1);
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
      0,
    );
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
      0,
    );
  }
});

async function refinementReady(t) {
  const f = await setup(t);
  await decidePlanning(f.db, f.id, {}, f.intent(true));
  await researchPlanning(f.db, f.id, {}, f.search);
  await generatePlanning(f.db, f.id, {}, f.model);
  await f.db
    .prepare("DELETE FROM agent_runs WHERE goal_id=? AND user_text=?")
    .bind(f.goal, ASK_AUTO)
    .run();
  for (const [i, topic] of [
    "outcome",
    "available_time",
    "constraints",
  ].entries()) {
    const id = globalThis.crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,reply_json,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',?,0,'fixture','succeeded','qa',?,1,1,1)",
      )
      .bind(
        id,
        f.goal,
        f.owner,
        id,
        i + 2,
        JSON.stringify({
          schema_version: 1,
          source: "deepseek",
          kind: "question",
          question: "核心问题",
          reason: "了解",
          requested_slot: topic,
          stage: "clarifying",
        }),
      )
      .run();
  }
  return f;
}
const refinedModel = (valid = true) => ({
  complete: async (input) => {
    const c = JSON.parse(input);
    assert.equal(c.previous_plan.tasks[0].duration_minutes, 20);
    assert.match(c.revision_request, /15分钟/);
    assert.equal(c.sources.length, 1);
    assert.equal(c.sources[0].url, undefined);
    return {
      content: JSON.stringify({
        title: "韩语调整草稿",
        summary: "保留目标，按本次要求减少投入并增加跟读",
        assumptions: ["时间仍是建议，尚未核实实际空闲"],
        risks: ["资料尚未核实"],
        time_preferences: {
          timezone: "Asia/Shanghai",
          start_minute: 420,
          end_minute: valid ? 480 : 400,
          excluded_weekdays: [2],
        },
        stage_weeks: [{ stage: 1, weeks: 2 }],
        tasks: [
          {
            key: "t1",
            stage: 1,
            title: "基础练习与跟读",
            instructions: "跟读基础对话并记录表达",
            duration_minutes: 15,
            frequency_per_week: 2,
            mandatory: true,
            depends_on: [],
            evidence_ids: ["E1"],
          },
        ],
      }),
      inputTokens: 3,
      outputTokens: 3,
    };
  },
});
test("refinement card creates a frozen new workflow, reuses sources and automatically previews content/frequency/time changes before explicit approval", async (t) => {
  const f = await refinementReady(t),
    old = await f.db
      .prepare("SELECT draft_json FROM plan_draft_attempts WHERE id=?")
      .bind(f.id)
      .first();
  const question = checkedDialogue(
    (
      await (
        await message(
          f,
          "请继续问我一个有助于完善方案的问题。",
          "refine-more",
          4,
        )
      ).json()
    ).data,
  );
  assert.equal(question.runs.at(-1).reply.stage, "refine_question");
  assert.equal(question.runs.at(-1).reply.base_attempt_id, f.id);
  assert.equal(question.clarification_budget.used, 0);
  const text = "每次改为15分钟、每周2次并增加跟读，早上7点到8点，周二不安排。";
  const result = checkedDialogue(
    (await (await message(f, text, "refine-answer", 5)).json()).data,
  );
  assert.equal(result.runs.at(-1).reply.stage, "draft_requested");
  const j = await f.db
    .prepare(
      "SELECT * FROM planning_jobs WHERE id!=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(f.id)
    .first();
  const frozen = JSON.parse(j.context_json);
  assert.equal(frozen.revision_request, text);
  assert.equal(frozen.base_attempt_id, f.id);
  assert.equal(JSON.parse(j.sources_json).length, 1);
  assert.equal((await message(f, text, "refine-answer", 5)).status, 200);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    2,
  );
  await decidePlanning(
    f.db,
    j.id,
    {},
    {
      complete: async (input) => {
        assert.equal(JSON.parse(input).has_sources, true);
        return {
          content: JSON.stringify({ needs_search: false, topic: "korean" }),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
  );
  await generatePlanning(f.db, j.id, {}, refinedModel());
  const snapshot = checkedPlanning((await (await f.get()).json()).data, f.goal);
  assert.equal(snapshot.jobs[0].plan.draft.tasks[0].duration_minutes, 15);
  assert.equal(snapshot.jobs[0].plan.draft.tasks[0].frequency_per_week, 2);
  assert.match(snapshot.jobs[0].plan.draft.tasks[0].instructions, /跟读/);
  const after = checkedDialogue(
    (
      await (
        await dialogueResponse(
          new globalThis.Request(
            `http://localhost/api/v1/goals/${f.goal}/messages`,
          ),
          f.db,
          f.owner,
          "test",
          {},
        )
      ).json()
    ).data,
  );
  assert.equal(after.auto_schedule.window_basis, "agent_proposal_v1");
  assert.equal(after.auto_schedule.preview.placements.length, 4);
  for (const p of after.auto_schedule.preview.placements) {
    const local = new Date(p.start_at + 8 * 3600000);
    assert.equal(local.getUTCHours(), 7);
    assert.notEqual(local.getUTCDay(), 2);
  }
  assert.equal(
    (
      await f.db
        .prepare("SELECT draft_json FROM plan_draft_attempts WHERE id=?")
        .bind(f.id)
        .first()
    ).draft_json,
    old.draft_json,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    0,
  );
  assert.equal(f.counts().searches, 1);
  const approved = await approvalResponse(
    new globalThis.Request(
      `http://localhost/api/v1/goals/${f.goal}/plan-approval`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "refined-plan-approval",
        },
        body: JSON.stringify({
          schedule_run_id: after.auto_schedule_run_id,
          expected_goal_revision: 0,
          expected_calendar_revision: 0,
        }),
      },
    ),
    f.db,
    f.owner,
    "test",
  );
  assert.equal(approved.status, 200);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM scheduled_occurrences").first())
      .n,
    4,
  );
});
test("invalid revised output retains original draft and policy prevents unsafe revisions", async (t) => {
  const f = await refinementReady(t);
  await message(
    f,
    "请继续问我一个有助于完善方案的问题。",
    "refine-question",
    4,
  );
  await message(f, "改成15分钟", "refine-bad", 5);
  const j = await f.db
    .prepare("SELECT id FROM planning_jobs WHERE id!=?")
    .bind(f.id)
    .first();
  await decidePlanning(f.db, j.id, {}, f.intent(false));
  await generatePlanning(f.db, j.id, {}, refinedModel(false));
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM planning_jobs WHERE id=?")
        .bind(j.id)
        .first()
    ).status,
    "failed",
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_attempts").first())
      .n,
    1,
  );
  const chat = (
    await f.db.prepare("SELECT max(turn_index) n FROM agent_runs").first()
  ).n;
  await message(
    f,
    "请继续问我一个有助于完善方案的问题。",
    "refine-risk-question",
    chat,
  );
  const risk = checkedDialogue(
    (
      await (
        await message(
          f,
          "我有伤病，请把动作改为15分钟",
          "refine-risk",
          chat + 1,
        )
      ).json()
    ).data,
  );
  assert.equal(risk.runs.at(-1).reply.source, "policy");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    2,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    0,
  );
});

test("opening the refinement question alone does not invalidate explicit approval of the unchanged current candidate", async (t) => {
  const f = await refinementReady(t);
  const preview = checkedDialogue(
    (await (await message(f, ASK_AUTO, `auto_schedule_${f.id}_0_0`, 4)).json())
      .data,
  );
  await message(f, "请继续问我一个有助于完善方案的问题。", "refine-cancel", 5);
  const response = await approvalResponse(
    new globalThis.Request(
      `http://localhost/api/v1/goals/${f.goal}/plan-approval`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "keep-original-plan",
        },
        body: JSON.stringify({
          schedule_run_id: preview.auto_schedule_run_id,
          expected_goal_revision: 0,
          expected_calendar_revision: 0,
        }),
      },
    ),
    f.db,
    f.owner,
    "test",
  );
  assert.equal(response.status, 200);
});

test("another completed draft invalidates a refinement card bound to the older source", async (t) => {
  const f = await refinementReady(t);
  await message(
    f,
    "请继续问我一个有助于完善方案的问题。",
    "refine-old-source",
    4,
  );
  const id = globalThis.crypto.randomUUID(),
    now = Date.now() + 1000;
  await f.db.batch([
    f.db
      .prepare(
        "INSERT INTO planning_jobs(id,source_run_id,goal_id,owner_id,goal_revision,status,context_json,created_at,updated_at,lease_until) SELECT ?, (SELECT id FROM agent_runs WHERE goal_id=? AND turn_index=3),goal_id,owner_id,goal_revision,'completed',context_json,?,?,0 FROM planning_jobs WHERE id=?",
      )
      .bind(id, f.goal, now, now, f.id),
    f.db
      .prepare(
        "INSERT INTO plan_draft_attempts(id,goal_id,owner_id,goal_revision,request_key,request_payload,context_json,status,draft_json,created_at,lease_until) SELECT ?,goal_id,owner_id,goal_revision,?,'{}',context_json,'succeeded',draft_json,?,0 FROM plan_draft_attempts WHERE id=?",
      )
      .bind(id, id, now, f.id),
  ]);
  const result = await message(f, "改成15分钟", "refine-stale-answer", 5);
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error.code, "CONTEXT_CHANGED");
  assert.equal(
    (await f.db.prepare("SELECT max(turn_index) n FROM agent_runs").first()).n,
    5,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    2,
  );
});
