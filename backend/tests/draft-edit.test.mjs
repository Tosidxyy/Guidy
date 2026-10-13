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
import {
  parseWindows,
  ASK_SCHEDULE,
  CONFIRM_SCHEDULE,
  ASK_WEEK,
  CONFIRM_WEEK,
} from "../src/scheduling/chat.ts";
import { checkedDialogue } from "../../apps/mobile/src/goals/dialogue.ts";
import { dialogueResponse } from "../src/agent/harness.ts";
import { reviewResponse } from "../src/agent/review-service.ts";
import { ASK_BUSY, CONFIRM_BUSY } from "../src/scheduling/busy-chat.ts";
import { calendarResponse } from "../src/scheduling/calendar.ts";
import { createApp } from "../src/index.ts";
test("account occupancy changed in another Goal rejects the pending schedule; busy-context dates are not mistaken for availability", async (t) => {
  const f = await ready(t);
  await message(f, ASK_WEEK, "cross-week-ask");
  const before = checkedDialogue(
    (await (await message(f, weekWindows(), "cross-week-pending", 2)).json())
      .data,
  ).runs.at(-1);
  const other = globalThis.crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO goals(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,1,1)",
    )
    .bind(other, f.owner, "other goal")
    .run();
  const g = { ...f, goal: other };
  await message(g, ASK_BUSY, "cross-busy-ask", 0);
  const busy = checkedDialogue(
    (
      await (
        await message(
          g,
          busyWindow().replace(/^已有占用：/, ""),
          "cross-busy-dates",
          1,
        )
      ).json()
    ).data,
  ).runs.at(-1);
  assert.equal(busy.reply.stage, "busy_proposed");
  await message(g, CONFIRM_BUSY, "cross-busy-save", 2);
  const result = checkedDialogue(
    (await (await message(f, CONFIRM_WEEK, "cross-week-confirm", 3)).json())
      .data,
  );
  assert.equal(result.runs.at(-1).reply.stage, "schedule_guidance");
  assert.equal(
    result.runs.find((r) => r.id === before.id).schedule_stale,
    true,
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
  return f;
}
function weekWindows(offsets = [2, 3, 4]) {
  return (
    "可用时段：北京时间，" +
    offsets
      .map(
        (offset) =>
          `${new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)} 20:00-21:00`,
      )
      .join("；")
  );
}
function busyWindow() {
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  return `已有占用：北京时间，${date} 20:00-20:30`;
}
test("busy declaration is only a proposal until confirmed, replay/duplicates preserve one account event, Goal deletion retains it", async (t) => {
  const f = await ready(t);
  const proposed = checkedDialogue(
    (await (await message(f, busyWindow(), "busy-propose")).json()).data,
  );
  assert.equal(proposed.runs.at(-1).reply.stage, "busy_proposed");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
    0,
  );
  const saved = checkedDialogue(
    (await (await message(f, CONFIRM_BUSY, "busy-confirm", 2)).json()).data,
  );
  assert.equal(saved.runs.at(-1).reply.stage, "busy_saved");
  assert.equal(saved.calendar_revision, 1);
  assert.equal(saved.clarification_budget.used, 0);
  assert.equal(
    (await (await message(f, CONFIRM_BUSY, "busy-confirm", 2)).json()).data.runs
      .length,
    3,
  );
  const duplicate = checkedDialogue(
    (await (await message(f, busyWindow(), "busy-duplicate", 3)).json()).data,
  );
  assert.equal(duplicate.runs.at(-1).reply.busy, undefined);
  assert.equal(duplicate.calendar_revision, 1);
  const from = Date.now(),
    to = from + 31 * 86400000;
  const request = new globalThis.Request(
    `http://localhost/api/v1/calendar/fixed-events?from=${from}&to=${to}`,
  );
  const mine = await calendarResponse(request, f.db, f.owner, "test");
  assert.equal((await mine.json()).data.events.length, 1);
  assert.equal(
    (
      await (
        await calendarResponse(request, f.db, "other-owner", "test")
      ).json()
    ).data.events.length,
    0,
  );
  await f.db.prepare("DELETE FROM goals WHERE id=?").bind(f.goal).run();
  const event = await f.db
    .prepare("SELECT source_goal_id,source_run_id FROM calendar_events")
    .first();
  assert.deepEqual(event, { source_goal_id: null, source_run_id: null });
  await f.db.prepare('DELETE FROM "user" WHERE id=?').bind(f.owner).run();
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
    0,
  );
});
test("weekly scheduling uses confirmed account occupancy and marks old previews stale after calendar changes", async (t) => {
  const f = await ready(t);
  await message(f, ASK_WEEK, "busy-week-ask");
  await message(f, weekWindows(), "busy-week-before", 2);
  const old = checkedDialogue(
    (
      await (
        await message(f, CONFIRM_WEEK, "busy-week-before-confirm", 3)
      ).json()
    ).data,
  ).runs.at(-1);
  await message(f, busyWindow(), "busy-week-propose", 4);
  const saved = checkedDialogue(
    (await (await message(f, CONFIRM_BUSY, "busy-week-save", 5)).json()).data,
  );
  assert.equal(
    saved.runs.find((run) => run.id === old.id).schedule_stale,
    true,
  );
  await message(f, ASK_WEEK, "busy-week-again", 6);
  await message(f, weekWindows(), "busy-week-after", 7);
  const result = checkedDialogue(
    (
      await (
        await message(f, CONFIRM_WEEK, "busy-week-after-confirm", 8)
      ).json()
    ).data,
  ).runs.at(-1).reply.schedule;
  assert.equal(result.calendar_snapshot.revision, 1);
  assert.equal(result.calendar_snapshot.busy.length, 1);
  assert.equal(result.preview.placements.length, 3);
  assert.ok(
    result.preview.placements[0].start_at >=
      result.calendar_snapshot.busy[0].end_at,
  );
});
test("competing account calendar versions reject old busy confirmation; atomic event failure rolls back run, version and messages", async (t) => {
  const f = await ready(t);
  await message(f, busyWindow(), "busy-race-propose");
  await f.db
    .prepare("INSERT INTO calendar_states(owner_id,revision) VALUES(?,1)")
    .bind(f.owner)
    .run();
  const rejected = checkedDialogue(
    (await (await message(f, CONFIRM_BUSY, "busy-race-confirm", 2)).json())
      .data,
  );
  assert.equal(rejected.runs.at(-1).reply.stage, "busy_guidance");
  assert.equal(
    rejected.runs.find((r) => r.turn_index === 2).busy_proposal_stale,
    true,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM calendar_events").first()).n,
    0,
  );
  await message(f, busyWindow(), "busy-atomic-propose", 3);
  const before = (
    await f.db.prepare("SELECT count(*) n FROM agent_messages").first()
  ).n;
  await f.db
    .prepare(
      "CREATE TRIGGER reject_calendar BEFORE INSERT ON calendar_events BEGIN SELECT RAISE(ABORT,'test-only'); END",
    )
    .run();
  await assert.rejects(() =>
    message(f, CONFIRM_BUSY, "busy-atomic-confirm", 4),
  );
  assert.equal(
    (await f.db.prepare("SELECT revision FROM calendar_states").first())
      .revision,
    1,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM agent_messages").first()).n,
    before,
  );
  assert.equal(
    (await f.db.prepare("SELECT max(turn_index) n FROM agent_runs").first()).n,
    4,
  );
  await f.db.prepare("DROP TRIGGER reject_calendar").run();
  assert.equal(
    (await message(f, CONFIRM_BUSY, "busy-atomic-confirm", 4)).status,
    200,
  );
  assert.equal(
    (await f.db.prepare("SELECT revision FROM calendar_states").first())
      .revision,
    2,
  );
});
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
  const ask = checkedDialogue(
    (await (await message(f, ASK_BUSY, "busy-vague-ask")).json()).data,
  );
  assert.equal(ask.runs.at(-1).reply.stage, "busy_guidance");
  const vague = checkedDialogue(
    (await (await message(f, "工作日9点到18点", "busy-vague-answer", 2)).json())
      .data,
  );
  assert.equal(vague.runs.at(-1).reply.busy, undefined);
  assert.equal(vague.clarification_budget.used, 0);
});
test("weekly chat freezes reviewed frequency, expands distinct instances and requires weekly confirmation", async (t) => {
  const f = await ready(t);
  assert.equal((await message(f, ASK_WEEK, "week-ask")).status, 200);
  const read = checkedDialogue(
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
  assert.ok(read.runs.at(-1).reply.question.length < 55);
  assert.match(
    read.runs.at(-1).reply.schedule_help.example_text,
    /^北京时间，\d{4}-\d{2}-\d{2}/,
  );
  assert.ok(!read.runs.at(-1).reply.question.includes("可用时段："));
  const proposal = checkedDialogue(
    (await (await message(f, weekWindows(), "week-propose", 2)).json()).data,
  ).runs.at(-1).reply.schedule;
  assert.equal(proposal.scope, "first_stage_week_v1");
  assert.equal(proposal.tasks.length, 3);
  assert.equal(new Set(proposal.tasks.map((task) => task.id)).size, 3);
  assert.equal(proposal.preview, undefined);
  const result = checkedDialogue(
    (await (await message(f, CONFIRM_WEEK, "week-confirm", 3)).json()).data,
  );
  const schedule = result.runs.at(-1).reply.schedule;
  assert.equal(schedule.preview.placements.length, 3);
  assert.equal(
    new Set(
      schedule.preview.placements.map((p) =>
        new Date(p.start_at + 8 * 3600000).toISOString().slice(0, 10),
      ),
    ).size,
    3,
  );
  assert.equal(result.clarification_budget.used, 0);
  assert.equal(
    (await (await message(f, CONFIRM_WEEK, "week-confirm", 3)).json()).data.runs
      .length,
    4,
  );
  const original = await f.db
    .prepare("SELECT draft_json FROM plan_draft_attempts WHERE id=?")
    .bind(f.id)
    .first();
  assert.equal(JSON.parse(original.draft_json).tasks.length, 1);
  assert.equal(
    (
      await f.db
        .prepare("SELECT active_plan_version_id FROM goals WHERE id=?")
        .bind(f.goal)
        .first()
    ).active_plan_version_id,
    null,
  );
});
test("weekly shortages are not packed into one day; out-of-week declarations remain guidance", async (t) => {
  const f = await ready(t);
  await message(f, ASK_WEEK, "week-short-ask");
  await message(f, weekWindows([2]), "week-short-window", 2);
  const schedule = checkedDialogue(
    (await (await message(f, CONFIRM_WEEK, "week-short-confirm", 3)).json())
      .data,
  ).runs.at(-1).reply.schedule;
  assert.equal(schedule.preview.placements.length, 1);
  assert.equal(schedule.preview.unplaced.length, 2);
  const invalid = checkedDialogue(
    (await (await message(f, weekWindows([2, 9]), "week-outside", 4)).json())
      .data,
  ).runs.at(-1).reply;
  assert.equal(invalid.stage, "schedule_guidance");
  assert.equal(invalid.schedule, undefined);
  assert.match(invalid.question, /连续7天/);
});
test("once-only confirmation cannot approve weekly scope; original once path remains readable", async (t) => {
  const f = await ready(t);
  await message(f, ASK_WEEK, "week-mismatch-ask");
  await message(f, weekWindows(), "week-mismatch-windows", 2);
  const invalid = checkedDialogue(
    (
      await (
        await message(f, CONFIRM_SCHEDULE, "week-mismatch-confirm", 3)
      ).json()
    ).data,
  ).runs.at(-1).reply;
  assert.equal(invalid.stage, "schedule_guidance");
  assert.equal(invalid.schedule, undefined);
  await message(f, ASK_SCHEDULE, "week-switch-once", 4);
  const once = checkedDialogue(
    (await (await message(f, weekWindows(), "week-once-windows", 5)).json())
      .data,
  ).runs.at(-1).reply.schedule;
  assert.equal(once.scope, "first_stage_once_v1");
  assert.equal(once.tasks.length, 1);
});
function futureWindows(minutes = 60) {
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  return `可用时段：北京时间，${date} 20:00-20:${String(minutes).padStart(2, "0")}`;
}
test("concrete date windows reject impossible, ambiguous, overlapping or unsupported local times", () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  const parsed = parseWindows(
    "可用时段：北京时间，2026-10-13 20:00-21:00",
    now,
  );
  assert.equal(parsed.timezone, "Asia/Shanghai");
  assert.equal(parsed.windows[0].start_at, Date.parse("2026-10-13T12:00:00Z"));
  assert.equal(
    parseWindows("UTC，2026-10-13 20:00-21:00", now).timezone,
    "UTC",
  );
  for (const text of [
    "北京时间，明天晚上",
    "北京时间，2026-10-13 24:00-24:30",
    "北京时间，2026-10-13 21:00-20:00",
    "北京时间，2026-02-30 20:00-21:00",
    "北京时间，2026-10-11 20:00-21:00",
    "UTC，2026-12-13 20:00-21:00",
    "America/New_York，2026-10-13 20:00-21:00",
    "北京时间，2026-10-13 20:00-21:00；2026-10-13 20:30-21:30",
    "北京时间，2026-10-13 20:00-21:00然后停药",
  ])
    assert.equal(parseWindows(text, now), null);
});
test("vague followup remains a free concrete-time question, not another model clarification", async (t) => {
  const f = await ready(t);
  await message(f, ASK_SCHEDULE, "schedule-context-ask");
  const answer = checkedDialogue(
    (
      await (
        await message(f, "你来安排吧", "schedule-vague-followup", 2)
      ).json()
    ).data,
  );
  assert.equal(answer.runs.at(-1).reply.stage, "schedule_guidance");
  assert.equal(answer.runs.at(-1).reply.schedule, undefined);
  assert.equal(answer.clarification_budget.used, 0);
});
test("exhausted model quota still permits deterministic window confirmation", async (t) => {
  const f = await ready(t);
  for (let index = 2; index <= 9; index++) {
    const id = globalThis.crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO agent_runs(id,goal_id,owner_id,request_key,request_payload,turn_index,goal_revision,user_text,status,harness_version,created_at,updated_at,lease_until) VALUES(?,?,?,?, '{}',?,0,'fixture','failed','clarify-v3',?,?,?)",
      )
      .bind(id, f.goal, f.owner, id, index, Date.now(), Date.now(), Date.now())
      .run();
  }
  const p = checkedDialogue(
    (
      await (
        await message(f, futureWindows(30), "schedule-quota-propose", 9)
      ).json()
    ).data,
  );
  assert.equal(p.clarification_budget.allowed, false);
  assert.equal(p.clarification_budget.used, 8);
  const result = checkedDialogue(
    (
      await (
        await message(f, CONFIRM_SCHEDULE, "schedule-quota-confirm", 10)
      ).json()
    ).data,
  );
  assert.equal(result.runs.at(-1).reply.schedule.preview.placements.length, 1);
  assert.equal(result.clarification_budget.used, 8);
});
test("trial respects first-stage boundary and reports expired declarations without reusing them", async (t) => {
  const f = await ready(t);
  const source = await f.db
    .prepare("SELECT draft_json FROM plan_draft_attempts WHERE id=?")
    .bind(f.id)
    .first();
  const draft = JSON.parse(source.draft_json);
  draft.tasks.push({
    ...draft.tasks[0],
    id: globalThis.crypto.randomUUID(),
    stage: 2,
    depends_on: [draft.tasks[0].id],
  });
  draft.weekly_minutes = 120;
  await f.db
    .prepare("UPDATE plan_draft_attempts SET draft_json=? WHERE id=?")
    .bind(JSON.stringify(draft), f.id)
    .run();
  const p = checkedDialogue(
    (await (await message(f, futureWindows(30), "schedule-stage")).json()).data,
  ).runs.at(-1);
  assert.equal(p.reply.schedule.tasks.length, 1);
  p.reply.schedule.windows = [
    { start_at: Date.now() - 60000, end_at: Date.now() + 60000 },
  ];
  await f.db
    .prepare("UPDATE agent_runs SET reply_json=? WHERE id=?")
    .bind(JSON.stringify(p.reply), p.id)
    .run();
  const result = checkedDialogue(
    (await (await message(f, CONFIRM_SCHEDULE, "schedule-expired", 2)).json())
      .data,
  );
  assert.equal(result.runs.at(-1).reply.stage, "schedule_guidance");
  assert.equal(result.runs.find((run) => run.id === p.id).schedule_stale, true);
});
test("chat trial only follows explicit window confirmation, persists and replays without quota or core writes", async (t) => {
  const f = await ready(t);
  const ask = await message(f, ASK_SCHEDULE, "schedule-ask");
  assert.equal(ask.status, 200);
  assert.equal(
    (await ask.json()).data.runs.at(-1).reply.stage,
    "schedule_guidance",
  );
  const p = await message(f, futureWindows(30), "schedule-windows", 2);
  assert.equal(p.status, 200);
  const proposal = checkedDialogue((await p.json()).data);
  assert.equal(proposal.runs.at(-1).reply.stage, "schedule_proposed");
  assert.equal(proposal.runs.at(-1).reply.schedule.preview, undefined);
  const confirmResponse = await message(
    f,
    CONFIRM_SCHEDULE,
    "schedule-confirm",
    3,
  );
  assert.equal(confirmResponse.status, 200);
  const result = checkedDialogue((await confirmResponse.json()).data);
  assert.equal(result.runs.at(-1).reply.schedule.preview.placements.length, 1);
  assert.equal(result.runs.at(-1).reply.schedule.tasks.length, 1);
  assert.equal(result.clarification_budget.used, 0);
  const replay = await message(f, CONFIRM_SCHEDULE, "schedule-confirm", 3);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.runs.length, 4);
  const reloaded = checkedDialogue(
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
  assert.deepEqual(
    reloaded.runs.at(-1).reply.schedule,
    result.runs.at(-1).reply.schedule,
  );
  const goal = await f.db
    .prepare("SELECT revision,active_plan_version_id FROM goals WHERE id=?")
    .bind(f.goal)
    .first();
  assert.deepEqual(goal, { revision: 0, active_plan_version_id: null });
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_reviews").first()).n,
    0,
  );
});
test("insufficient windows explain unscheduled trial without pretending success", async (t) => {
  const f = await ready(t);
  await message(f, futureWindows(10), "schedule-small");
  const result = await message(
    f,
    CONFIRM_SCHEDULE,
    "schedule-small-confirm",
    2,
  );
  const preview = checkedDialogue((await result.json()).data).runs.at(-1).reply
    .schedule.preview;
  assert.equal(preview.placements.length, 0);
  assert.equal(preview.unplaced[0].reason, "no_legal_window");
});
test("peer draft review invalidates owned window proposal and old confirmation; fresh proposal uses review", async (t) => {
  const f = await ready(t);
  const p = (
    await (await message(f, futureWindows(30), "schedule-peer")).json()
  ).data.runs.at(-1);
  const taskId = p.reply.schedule.tasks[0].id;
  const response = await reviewResponse(
    new globalThis.Request(
      `http://localhost/api/v1/goals/${f.goal}/draft-reviews?attempt_id=${f.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "schedule-peer-review",
        },
        body: JSON.stringify({
          expected_goal_revision: 0,
          expected_review_revision: 0,
          changes: [
            { task_id: taskId, duration_minutes: 25, frequency_per_week: 3 },
          ],
        }),
      },
    ),
    f.db,
    f.owner,
    "test",
  );
  assert.equal(response.status, 200);
  const result = checkedDialogue(
    (
      await (
        await message(f, CONFIRM_SCHEDULE, "schedule-old-confirm", 2)
      ).json()
    ).data,
  );
  assert.equal(result.runs.at(-1).reply.stage, "schedule_guidance");
  assert.equal(result.runs.find((r) => r.id === p.id).schedule_stale, true);
  const fresh = checkedDialogue(
    (
      await (
        await message(f, futureWindows(30), "schedule-new-windows", 3)
      ).json()
    ).data,
  ).runs.at(-1).reply.schedule;
  assert.equal(fresh.review_revision, 1);
  assert.equal(fresh.tasks[0].duration_minutes, 25);
});
test("schedule cannot bypass ownership, chat revision, Goal changes or policy", async (t) => {
  const f = await ready(t);
  assert.equal(
    (await message(f, futureWindows(30), "schedule-wrong-revision", 0)).status,
    409,
  );
  const wrong = await dialogueResponse(
    new globalThis.Request(`http://localhost/api/v1/goals/${f.goal}/messages`),
    f.db,
    "other-owner",
    "test",
    {},
  );
  assert.equal(wrong.status, 404);
  const policy = checkedDialogue(
    (
      await (
        await message(
          f,
          "可用时段：北京时间，2026-10-20 20:00-21:00，停药",
          "schedule-policy",
        )
      ).json()
    ).data,
  );
  assert.equal(policy.runs.at(-1).reply.source, "policy");
  const denied = checkedDialogue(
    (
      await (
        await message(f, futureWindows(30), "schedule-policy-inherited", 2)
      ).json()
    ).data,
  );
  assert.equal(denied.runs.at(-1).reply.schedule, undefined);
  await f.db
    .prepare("UPDATE goals SET revision=1 WHERE id=?")
    .bind(f.goal)
    .run();
  assert.equal(
    (await message(f, futureWindows(30), "schedule-old-goal", 3)).status,
    409,
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
