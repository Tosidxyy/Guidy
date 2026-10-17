import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./replan-fixture.mjs";
import {
  conversationResponse,
  checkedDiscussion,
  compileDiscussion,
} from "../src/agent/conversation.ts";
import { createEventResponse } from "../src/scheduling/events.ts";
import { upcomingCalendarResponse } from "../src/scheduling/calendar.ts";
import { approvalResponse } from "../src/scheduling/approval.ts";
import {
  planOutputTool,
  normalizePlanOutput,
} from "../src/agent/plan-output.ts";
import { validateStrategy } from "../src/agent/strategy-contract.ts";
const req = (path, body, key = "event-test-key") =>
  new globalThis.Request("http://localhost/api/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const event = () => ({
  title: "散步",
  start_at: Math.floor(Date.now() / 60000) * 60000 + 86400000,
  end_at: Math.floor(Date.now() / 60000) * 60000 + 86400000 + 1800000,
  timezone: "Asia/Shanghai",
});
test("manual event creation is atomic, conflict-aware, owner scoped and idempotent", async (t) => {
  const f = await setup(t),
    e = event(),
    body = { event: e, expected_revision: 0 };
  const post = (b = body, key = "event-test-key") =>
    createEventResponse(req("calendar/events", b, key), f.db, f.owner, "test");
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
    1,
  );
  assert.equal(
    (await post({ ...body, event: { ...e, title: "不同内容" } })).status,
    409,
  );
  assert.equal(
    (await post({ ...body, expected_revision: 1 }, "overlap-test")).status,
    409,
  );
  assert.equal(
    (
      await post(
        {
          ...body,
          event: { ...e, start_at: e.end_at, end_at: e.end_at + 1800000 },
        },
        "stale-test-key",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await post(
        {
          event: { ...e, start_at: e.end_at, end_at: e.end_at + 1800000 },
          expected_revision: 1,
        },
        "adjacent-event",
      )
    ).status,
    200,
  );
  const r = await upcomingCalendarResponse(
    req(`calendar/events?from=${e.start_at}&to=${e.end_at + 1800000}`),
    f.db,
    f.owner,
    "test",
  );
  assert.equal((await r.json()).data.events.length, 2);
  const other = await upcomingCalendarResponse(
    req(`calendar/events?from=${e.start_at}&to=${e.end_at + 1800000}`),
    f.db,
    "other",
    "test",
  );
  assert.deepEqual((await other.json()).data.events, []);
});
test("manual events cannot overlap an approved plan; stale candidate cannot be approved after a manual write", async (t) => {
  const f = await setup(t),
    g = await f.goal(),
    p = g.schedule.preview.placements[0];
  assert.equal(
    (await approvalResponse(g.request(), f.db, f.owner, "test")).status,
    200,
  );
  const e = {
    title: "冲突",
    start_at: p.start_at,
    end_at: p.end_at,
    timezone: "Asia/Shanghai",
  };
  assert.equal(
    (
      await createEventResponse(
        req("calendar/events", { event: e, expected_revision: 1 }),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    409,
  );
  const g2 = await f.goal();
  const free = event();
  free.start_at += 100 * 86400000;
  free.end_at += 100 * 86400000;
  assert.equal(
    (
      await createEventResponse(
        req(
          "calendar/events",
          { event: free, expected_revision: 1 },
          "new-free-event",
        ),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await approvalResponse(
        g2.request("second-plan", {
          ...g2.body,
          expected_calendar_revision: 1,
        }),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    409,
  );
});
test("discussion produces a persisted proposal without writes; explicit confirmation creates one event and survives reload", async (t) => {
  const f = await setup(t),
    g = await f.goal(),
    e = event();
  let calls = 0;
  const provider = {
    complete: async () => {
      calls++;
      return {
        content: JSON.stringify({
          kind: "event",
          message: "建议这个时间，可以确认后加入日历。",
          event: civilEvent(e),
          revision: null,
        }),
      };
    },
  };
  const body = { text: "明天加半小时散步", expected_goal_revision: 0 },
    path = `goals/${g.id}/conversation`;
  const post = (b = body, key = "discussion-test-key") =>
    conversationResponse(
      req(path, b, key),
      f.db,
      f.owner,
      "test",
      {},
      provider,
    );
  const response = await post();
  assert.equal(response.status, 200);
  const turn = (await response.json()).data.turns[0];
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
    0,
  );
  assert.equal((await post()).status, 200);
  assert.equal(calls, 1);
  const wrong = {
    event: { ...e, title: "篡改提案" },
    expected_revision: 0,
    proposal_id: turn.id,
  };
  assert.equal(
    (
      await createEventResponse(
        req("calendar/events", wrong, "forged-event"),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    409,
  );
  const confirm = { event: e, expected_revision: 0, proposal_id: turn.id };
  assert.equal(
    (
      await createEventResponse(
        req("calendar/events", confirm),
        f.db,
        f.owner,
        "test",
      )
    ).status,
    200,
  );
  const loaded = await conversationResponse(
    req(path),
    f.db,
    f.owner,
    "test",
    {},
    provider,
  );
  assert.ok((await loaded.json()).data.turns[0].saved_event_id);
  assert.equal(calls, 1);
  assert.equal(
    (await conversationResponse(req(path), f.db, "other", "test", {}, provider))
      .status,
    404,
  );
});
test("invalid or stale discussion output never writes calendar, and same-key failed replay never calls again", async (t) => {
  const f = await setup(t),
    g = await f.goal();
  let calls = 0;
  const path = `goals/${g.id}/conversation`,
    body = { text: "聊一聊", expected_goal_revision: 0 };
  const bad = {
    complete: async () => {
      calls++;
      return {
        content: JSON.stringify({
          kind: "event",
          message: "已添加日历",
          event: event(),
          revision: null,
        }),
      };
    },
  };
  assert.equal(
    (
      await conversationResponse(
        req(path, body),
        f.db,
        f.owner,
        "test",
        {},
        bad,
      )
    ).status,
    502,
  );
  assert.equal(
    (
      await conversationResponse(
        req(path, body),
        f.db,
        f.owner,
        "test",
        {},
        bad,
      )
    ).status,
    200,
  );
  assert.equal(calls, 1);
  const stale = {
    complete: async () => {
      await f.db
        .prepare("UPDATE goals SET revision=revision+1 WHERE id=?")
        .bind(g.id)
        .run();
      return {
        content: JSON.stringify({
          kind: "reply",
          message: "我们可以调整节奏。",
          event: null,
          revision: null,
        }),
      };
    },
  };
  assert.equal(
    (
      await conversationResponse(
        req(path, body, "stale-discussion"),
        f.db,
        f.owner,
        "test",
        {},
        stale,
      )
    ).status,
    502,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
    0,
  );
});
test("discussion budget, pending reservation and policy referral prevent model execution", async (t) => {
  const f = await setup(t),
    g = await f.goal(),
    path = `goals/${g.id}/conversation`;
  let calls = 0;
  const provider = {
    complete: async () => {
      calls++;
      throw Error();
    },
  };
  assert.equal(
    (
      await conversationResponse(
        req(path, { text: "可以自行停药吗", expected_goal_revision: 0 }),
        f.db,
        f.owner,
        "test",
        {},
        provider,
      )
    ).status,
    200,
  );
  assert.equal(calls, 0);
  await f.db.prepare("UPDATE conversation_turns SET status='running'").run();
  assert.equal(
    (
      await conversationResponse(
        req(
          path,
          { text: "加一项任务", expected_goal_revision: 0 },
          "second-reservation",
        ),
        f.db,
        f.owner,
        "test",
        {},
        provider,
      )
    ).status,
    409,
  );
  assert.equal(calls, 0);
  await f.db.prepare("UPDATE conversation_turns SET status='failed'").run();
  for (let i = 1; i < 20; i++)
    assert.equal(
      (
        await conversationResponse(
          req(
            path,
            { text: "可以自行停药吗", expected_goal_revision: 0 },
            `budget-policy-${i}`,
          ),
          f.db,
          f.owner,
          "test",
          {},
          provider,
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await conversationResponse(
        req(
          path,
          { text: "聊聊安排", expected_goal_revision: 0 },
          "budget-over-limit",
        ),
        f.db,
        f.owner,
        "test",
        {},
        provider,
      )
    ).status,
    409,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM conversation_turns").first()).n,
    20,
  );
});
test("21-day strategy has three real weekly phases and executable segments, not just a prompt", () => {
  const draft = {
    stage_weeks: [
      { weeks: 1, stage: 1 },
      { weeks: 1, stage: 2 },
      { weeks: 1, stage: 3 },
    ],
    tasks: [1, 2, 3].map((stage) => ({
      id: `task${stage}`,
      title: "练习",
      stage,
      segments: [{}],
      duration_minutes: 20,
      frequency_per_week: 3,
      depends_on: [],
    })),
  };
  assert.doesNotThrow(() => validateStrategy(draft, "strategy_21_v1"));
  assert.throws(
    () =>
      validateStrategy(
        {
          ...draft,
          time_preferences: {
            timezone: "Asia/Shanghai",
            start_minute: 1200,
            end_minute: 1210,
            excluded_weekdays: [],
          },
        },
        "strategy_21_v1",
      ),
    { code: "STRATEGY_CAPACITY_FAILED" },
  );
  assert.throws(
    () =>
      validateStrategy(
        {
          ...draft,
          time_preferences: {
            timezone: "Asia/Shanghai",
            start_minute: 1200,
            end_minute: 1260,
            excluded_weekdays: [0, 1, 2, 3, 4],
          },
        },
        "strategy_21_v1",
      ),
    { code: "STRATEGY_CAPACITY_FAILED" },
  );
  assert.throws(
    () =>
      validateStrategy(
        {
          ...draft,
          tasks: draft.tasks.map((t, i) =>
            i === 1 ? { ...t, depends_on: ["task1"], stage: 1 } : t,
          ),
        },
        "strategy_21_v1",
      ),
    { code: "STRATEGY_CONTRACT_FAILED" },
  );
  assert.doesNotThrow(() =>
    validateStrategy(
      {
        ...draft,
        tasks: draft.tasks.map((t, i) => ({
          ...t,
          depends_on: i ? [`task${i}`] : [],
        })),
      },
      "strategy_21_v1",
    ),
  );
  assert.throws(() =>
    validateStrategy(
      { ...draft, stage_weeks: [{ stage: 1, weeks: 4 }] },
      "strategy_21_v1",
    ),
  );
  assert.throws(() =>
    validateStrategy(
      { ...draft, tasks: draft.tasks.slice(0, 2) },
      "strategy_21_v1",
    ),
  );
  assert.throws(() =>
    checkedDiscussion(
      JSON.stringify({
        kind: "reply",
        message: "绕过工具",
        event: event(),
        revision: null,
      }),
    ),
  );
  assert.throws(() =>
    checkedDiscussion(
      JSON.stringify({
        kind: "event",
        message: "建议",
        event: { ...event(), start_at: 1 },
        revision: null,
      }),
    ),
  );
});

test("21-day strict carrier has fixed weekly units and compiles structure without trusting model control fields", () => {
  const context = JSON.stringify({
    planning_contract: "strategy_21_v1",
    generation_mode: "chat_auto_v1",
    sources: [],
  });
  const schema = planOutputTool(context).function.parameters;
  assert.deepEqual(schema.properties.tasks.required, [
    "week1",
    "week2",
    "week3",
  ]);
  assert.equal(schema.properties.stage_weeks, undefined);
  assert.equal(
    schema.properties.tasks.properties.week1.properties.depends_on,
    undefined,
  );
  const unit = {
    title: "练习",
    instructions: "练习并记录",
    segments: [
      { title: "跟读", instructions: "跟读一句", duration_minutes: 20 },
    ],
    duration_minutes: 20,
    frequency_per_week: 3,
    mandatory: true,
    evidence_ids: [],
  };
  const carrier = {
    title: "策略",
    summary: "三周练习",
    assumptions: [],
    risks: [],
    time_preferences: {
      timezone: "Asia/Shanghai",
      start_minute: 1200,
      end_minute: 1260,
      excluded_weekdays: [3],
    },
    tasks: { week1: unit, week2: unit, week3: unit },
  };
  const draft = JSON.parse(
    normalizePlanOutput(JSON.stringify(carrier), context),
  );
  assert.deepEqual(
    draft.stage_weeks,
    [1, 2, 3].map((stage) => ({ stage, weeks: 1 })),
  );
  assert.deepEqual(
    draft.tasks.map((t) => [t.key, t.stage, t.depends_on]),
    [
      ["t1", 1, []],
      ["t2", 2, []],
      ["t3", 3, []],
    ],
  );
  assert.throws(() =>
    normalizePlanOutput(
      JSON.stringify({
        ...carrier,
        tasks: { ...carrier.tasks, week1: { ...unit, depends_on: ["t2"] } },
      }),
      context,
    ),
  );
  assert.throws(() =>
    normalizePlanOutput(
      JSON.stringify({ ...carrier, stage_weeks: [] }),
      context,
    ),
  );
});

function civilEvent(e) {
  const offset = e.timezone === "UTC" ? 0 : 28800000;
  return {
    title: e.title,
    date: new Date(e.start_at + offset).toISOString().slice(0, 10),
    start_time: new Date(e.start_at + offset).toISOString().slice(11, 16),
    end_time: new Date(e.end_at + offset).toISOString().slice(11, 16),
    timezone: e.timezone,
  };
}
test("discussion dates compile deterministically and reject invented epochs, invalid dates and backward intervals", () => {
  const e = event(),
    reply = {
      kind: "event",
      message: "请确认",
      event: civilEvent(e),
      revision: null,
    };
  assert.deepEqual(compileDiscussion(JSON.stringify(reply)).event, e);
  for (const patch of [
    { date: "2030-02-30" },
    { start_time: "24:00" },
    { end_time: reply.event.start_time },
  ])
    assert.throws(() =>
      compileDiscussion(
        JSON.stringify({ ...reply, event: { ...reply.event, ...patch } }),
      ),
    );
  assert.throws(() =>
    compileDiscussion(JSON.stringify({ ...reply, event: e })),
  );
});
