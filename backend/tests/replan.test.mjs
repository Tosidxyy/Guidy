import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./replan-fixture.mjs";
import { approvalResponse } from "../src/scheduling/approval.ts";
import { dialogueResponse } from "../src/agent/harness.ts";
import {
  ASK_ADJUST,
  REFRESH_REPLAN,
  checkedPreferences,
} from "../src/agent/schedule-preferences.ts";
import { checkedDialogue } from "../../apps/mobile/src/goals/dialogue.ts";
import { checkedApproval } from "../../apps/mobile/src/goals/approval.ts";
const env = { GUIDY_ENVIRONMENT: "development" };
const preferences = (text) => ({
  needs_clarification: false,
  question: "",
  reason: "早晨避开周二",
  excluded_weekdays: [2],
  excluded_dates: [],
  preferred_start: 420,
  preferred_end: 480,
  request_echo: text,
});
async function approved(t) {
  const f = await setup(t),
    g = await f.goal();
  const response = await approvalResponse(g.request(), f.db, f.owner, "test");
  assert.equal(response.status, 200);
  return { ...f, g, parent: (await response.json()).data.approval };
}
async function send(f, text, key = "replan-test-key", provider) {
  const state = await dialogueResponse(
    new globalThis.Request(`http://localhost/api/v1/goals/${f.g.id}/messages`),
    f.db,
    f.owner,
    "test",
    env,
  );
  const d = (await state.json()).data;
  const body = {
    text,
    expected_chat_revision: d.chat_revision,
    expected_goal_revision: d.goal.revision,
  };
  const r = await dialogueResponse(
    new globalThis.Request(`http://localhost/api/v1/goals/${f.g.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
    f.db,
    f.owner,
    "test",
    env,
    provider,
  );
  return { response: r, body, data: (await r.json()).data };
}
test("active goal asks a card question, interprets changes once, previews without core writes and confirms version 2", async (t) => {
  const f = await approved(t);
  const ask = await send(f, ASK_ADJUST, "ask-change-key");
  assert.equal(ask.response.status, 200);
  checkedDialogue(ask.data);
  assert.equal(ask.data.runs.at(-1).reply.stage, "replan_question");
  let calls = 0;
  const provider = {
    complete: async (context) => {
      calls++;
      const value = JSON.parse(context);
      return {
        content: JSON.stringify(preferences(value.user_message)),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const changed = await send(
    f,
    "周二没空，改到早上7点到8点",
    "change-morning-key",
    provider,
  );
  assert.equal(changed.response.status, 200);
  checkedDialogue(changed.data);
  const candidate = changed.data.auto_schedule;
  assert.equal(candidate.scope, "remaining_plan_v1");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) n FROM scheduled_occurrences WHERE status='scheduled'",
        )
        .first()
    ).n,
    3,
  );
  for (const p of candidate.preview.placements) {
    const local = new Date(p.start_at + 8 * 3600000);
    assert.equal(local.getUTCHours(), 7);
    assert.notEqual(local.getUTCDay(), 2);
  }
  const request = () =>
    new globalThis.Request(`http://localhost/api/v1/goals/${f.g.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "change-morning-key",
      },
      body: JSON.stringify(changed.body),
    });
  const replay = await dialogueResponse(
    request(),
    f.db,
    f.owner,
    "test",
    env,
    provider,
  );
  assert.equal(replay.status, 200);
  assert.equal(calls, 1);
  const confirm = () =>
    new globalThis.Request(
      `http://localhost/api/v1/goals/${f.g.id}/plan-approval`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "confirm-change-key",
        },
        body: JSON.stringify({
          schedule_run_id: changed.data.auto_schedule_run_id,
          expected_goal_revision: 1,
          expected_calendar_revision: 1,
        }),
      },
    );
  const saved = await approvalResponse(confirm(), f.db, f.owner, "test");
  assert.equal(saved.status, 200);
  const data = (await saved.json()).data;
  checkedApproval(data, f.g.id);
  assert.equal(data.approval.version, 2);
  assert.equal(
    (await approvalResponse(confirm(), f.db, f.owner, "test")).status,
    200,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    2,
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) n FROM scheduled_occurrences WHERE status='superseded'",
        )
        .first()
    ).n,
    3,
  );
  assert.deepEqual(
    JSON.parse(
      (
        await f.db
          .prepare("SELECT draft_json FROM plan_versions WHERE id=?")
          .bind(f.parent.id)
          .first()
      ).draft_json,
    ),
    f.parent.draft,
  );
  assert.deepEqual(
    await f.db.prepare("SELECT status,revision FROM goals").first(),
    { status: "active", revision: 2 },
  );
});
test("free conflict refresh reuses preferences and never invokes the model again", async (t) => {
  const f = await approved(t);
  let calls = 0;
  const provider = {
    complete: async (context) => {
      calls++;
      return {
        content: JSON.stringify(preferences(JSON.parse(context).user_message)),
        inputTokens: null,
        outputTokens: null,
      };
    },
  };
  await send(f, "改到早上7点", "prepare-change-key", provider);
  const refresh = await send(f, REFRESH_REPLAN, "refresh-change-key", provider);
  assert.equal(refresh.response.status, 200);
  checkedDialogue(refresh.data);
  assert.equal(calls, 1);
  assert.equal(refresh.data.clarification_budget.used, 1);
});
test("invalid model preferences cannot write a proposal or change the active calendar", async (t) => {
  const f = await approved(t);
  const r = await send(f, "周二没空", "bad-change-key", {
    complete: async () => ({
      content: JSON.stringify(preferences("different text")),
      inputTokens: null,
      outputTokens: null,
    }),
  });
  assert.equal(r.response.status, 502);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) n FROM scheduled_occurrences WHERE status='scheduled'",
        )
        .first()
    ).n,
    3,
  );
  assert.throws(() =>
    checkedPreferences(
      JSON.stringify({ ...preferences("x"), excluded_dates: ["2026-02-30"] }),
      "x",
    ),
  );
  assert.throws(() =>
    checkedPreferences(
      JSON.stringify({ ...preferences("x"), preferred_end: 360 }),
      "x",
    ),
  );
});

test("delegated unknown time never loops or pays for another clarification", async (t) => {
  const f = await approved(t);
  const r = await send(f, "你来安排吧", "delegated-adjust-key", {
    complete: async () => {
      throw new Error("must not call");
    },
  });
  assert.equal(r.response.status, 200);
  checkedDialogue(r.data);
  assert.equal(r.data.runs.at(-1).reply.stage, "schedule_preview");
  assert.equal(r.data.clarification_budget.used, 0);
});

test("past instances and completion state remain untouched when future work is superseded", async (t) => {
  const f = await approved(t);
  const past = await f.db
    .prepare(
      "SELECT id FROM scheduled_occurrences WHERE plan_version_id=? ORDER BY start_at LIMIT 1",
    )
    .bind(f.parent.id)
    .first();
  await f.db
    .prepare(
      "UPDATE scheduled_occurrences SET start_at=1,end_at=2,status='completed' WHERE id=?",
    )
    .bind(past.id)
    .run();
  const r = await send(f, "改到早上7点", "remaining-adjust-key", {
    complete: async (context) => ({
      content: JSON.stringify(preferences(JSON.parse(context).user_message)),
      inputTokens: null,
      outputTokens: null,
    }),
  });
  assert.equal(r.response.status, 200);
  checkedDialogue(r.data);
  assert.equal(r.data.auto_schedule.tasks.length, 2);
  const body = {
    schedule_run_id: r.data.auto_schedule_run_id,
    expected_goal_revision: 1,
    expected_calendar_revision: 1,
  };
  const request = new globalThis.Request(
    `http://localhost/api/v1/goals/${f.g.id}/plan-approval`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "approve-remaining-key",
      },
      body: JSON.stringify(body),
    },
  );
  assert.equal(
    (await approvalResponse(request, f.db, f.owner, "test")).status,
    200,
  );
  assert.deepEqual(
    await f.db
      .prepare(
        "SELECT start_at,end_at,status FROM scheduled_occurrences WHERE id=?",
      )
      .bind(past.id)
      .first(),
    { start_at: 1, end_at: 2, status: "completed" },
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) n FROM scheduled_occurrences WHERE status='superseded'",
        )
        .first()
    ).n,
    2,
  );
});

test("expired pending adjustment refresh clears obsolete candidate when no future work remains", async (t) => {
  const f = await approved(t);
  let calls = 0;
  const provider = {
    complete: async (context) => {
      calls++;
      return {
        content: JSON.stringify(preferences(JSON.parse(context).user_message)),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const changed = await send(f, "改到早上7点", "expiry-prepare-key", provider);
  assert.ok(changed.data.auto_schedule.replaces_plan_id);
  const old = await f.db
    .prepare("SELECT schedule_json FROM plan_versions WHERE id=?")
    .bind(f.parent.id)
    .first();
  // Mark controlled fixture work as actually complete; refresh may never fabricate completion.
  await f.db
    .prepare(
      "UPDATE scheduled_occurrences SET status='completed' WHERE plan_version_id=?",
    )
    .bind(f.parent.id)
    .run();
  const refresh = await send(f, REFRESH_REPLAN, "expiry-refresh-key", provider);
  assert.equal(refresh.response.status, 200);
  checkedDialogue(refresh.data);
  assert.equal(refresh.data.auto_schedule, null);
  assert.equal(refresh.data.auto_schedule_run_id, null);
  assert.equal(
    refresh.data.runs.at(-1).reply.clears_schedule_for_plan,
    f.parent.id,
  );
  assert.equal(calls, 1);
  assert.equal(refresh.data.clarification_budget.used, 1);
  assert.deepEqual(
    await f.db
      .prepare("SELECT schedule_json FROM plan_versions WHERE id=?")
      .bind(f.parent.id)
      .first(),
    old,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) n FROM scheduled_occurrences WHERE status='completed'",
        )
        .first()
    ).n,
    3,
  );
});
