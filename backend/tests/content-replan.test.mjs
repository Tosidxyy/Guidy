import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./replan-fixture.mjs";
import { approvalResponse } from "../src/scheduling/approval.ts";
import { dialogueResponse } from "../src/agent/harness.ts";
import {
  planningResponse,
  decidePlanning,
  generatePlanning,
} from "../src/agent/planning-jobs.ts";
import { ASK_AUTO } from "../src/scheduling/chat.ts";
import { checkedDialogue } from "../../apps/mobile/src/goals/dialogue.ts";
import { checkedApproval } from "../../apps/mobile/src/goals/approval.ts";
const MORE = "请继续问我一个有助于完善方案的问题。";
async function approved(t, contract = false) {
  const f = await setup(t),
    g = await f.goal();
  if (contract)
    await f.db
      .prepare(
        "UPDATE plan_draft_attempts SET context_json=json_set(context_json,'$.planning_contract','strategy_21_v1') WHERE goal_id=?",
      )
      .bind(g.id)
      .run();
  const r = await approvalResponse(g.request(), f.db, f.owner, "test");
  assert.equal(r.status, 200);
  return { ...f, g, parent: (await r.json()).data.approval };
}
async function state(f) {
  const r = await dialogueResponse(
    new globalThis.Request(`http://localhost/api/v1/goals/${f.g.id}/messages`),
    f.db,
    f.owner,
    "test",
    {},
  );
  assert.equal(r.status, 200);
  return checkedDialogue((await r.json()).data);
}
async function send(f, text, key) {
  const d = await state(f),
    body = {
      text,
      expected_chat_revision: d.chat_revision,
      expected_goal_revision: d.goal.revision,
    };
  const request = () =>
    new globalThis.Request(`http://localhost/api/v1/goals/${f.g.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
  const call = () =>
    dialogueResponse(
      request(),
      f.db,
      f.owner,
      "test",
      {},
      {
        complete: async () => {
          throw Error("Card/request must not call a synchronous model");
        },
      },
    );
  const r = await call();
  assert.equal(r.status, 200);
  return { data: checkedDialogue((await r.json()).data), call };
}
const changedPlan = {
  title: "韩语跟读新方案",
  summary: "调整练习内容与投入",
  assumptions: ["新的两周周期待核对"],
  risks: [],
  stage_weeks: [{ stage: 1, weeks: 2 }],
  time_preferences: {
    timezone: "Asia/Shanghai",
    start_minute: 420,
    end_minute: 480,
    excluded_weekdays: [2],
  },
  tasks: [
    {
      key: "t1",
      stage: 1,
      title: "韩语跟读",
      instructions: "听一句并跟读，记录发音",
      duration_minutes: 15,
      frequency_per_week: 2,
      mandatory: true,
      depends_on: [],
      evidence_ids: [],
    },
  ],
};
async function generate(f, id, content = JSON.stringify(changedPlan)) {
  let calls = 0;
  await decidePlanning(
    f.db,
    id,
    {},
    {
      complete: async () => {
        calls++;
        return {
          content: JSON.stringify({ needs_search: false, topic: "general" }),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
  );
  await generatePlanning(
    f.db,
    id,
    {},
    {
      complete: async (input) => {
        calls++;
        const c = JSON.parse(input);
        assert.equal(c.replan_parent_id, f.parent.id);
        assert.ok(c.revision_request);
        return { content, inputTokens: 1, outputTokens: 1 };
      },
    },
  );
  assert.equal(calls, 2);
}

test("approved plan can be revised through cards and workflow; explicit version 2 preserves completed/skipped/history", async (t) => {
  const f = await approved(t),
    old = await f.db
      .prepare("SELECT * FROM plan_versions WHERE id=?")
      .bind(f.parent.id)
      .first();
  const rows = (
    await f.db
      .prepare(
        "SELECT * FROM scheduled_occurrences WHERE goal_id=? ORDER BY start_at",
      )
      .bind(f.g.id)
      .all()
  ).results;
  await f.db
    .prepare("UPDATE scheduled_occurrences SET status='completed' WHERE id=?")
    .bind(rows[0].id)
    .run();
  await f.db
    .prepare("UPDATE scheduled_occurrences SET status='skipped' WHERE id=?")
    .bind(rows[1].id)
    .run();
  const history = (
    await f.db
      .prepare(
        "SELECT * FROM scheduled_occurrences WHERE status IN ('completed','skipped') ORDER BY id",
      )
      .all()
  ).results;
  const question = await send(f, MORE, "content-question-key");
  assert.equal(question.data.runs.at(-1).reply.stage, "refine_question");
  assert.equal(question.data.clarification_budget.used, 0);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    1,
  );
  const submit = await send(
    f,
    "改成韩语跟读，每次15分钟，每周2次，早上7点，两周",
    "content-answer-key",
  );
  assert.equal(submit.data.runs.at(-1).reply.stage, "draft_requested");
  assert.equal((await submit.call()).status, 200);
  const job = await f.db
    .prepare("SELECT * FROM planning_jobs WHERE goal_revision=1")
    .first();
  assert.ok(job);
  const frozen = JSON.parse(job.context_json);
  assert.equal(frozen.replan_parent_id, f.parent.id);
  assert.equal(frozen.execution_summary.length, 2);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    2,
  );
  await generate(f, job.id);
  const d = await state(f);
  assert.equal(d.auto_schedule.attempt_id, job.id);
  assert.equal(d.auto_schedule.scope, "full_plan_cycle_v1");
  assert.equal(d.auto_schedule.replaces_plan_id, f.parent.id);
  assert.deepEqual(d.auto_schedule.parent_instance_ids, [rows[2].id]);
  assert.equal(d.auto_schedule.preview.placements.length, 4);
  assert.equal(d.auto_schedule.preview.unplaced.length, 0);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM scheduled_occurrences WHERE id=?")
        .bind(rows[2].id)
        .first()
    ).status,
    "scheduled",
  );
  const body = {
    schedule_run_id: d.auto_schedule_run_id,
    expected_goal_revision: 1,
    expected_calendar_revision: 1,
  };
  const request = () => f.g.request("approve-content-key", body);
  const r = await approvalResponse(request(), f.db, f.owner, "test");
  assert.equal(r.status, 200);
  const a = checkedApproval(
    { schema_version: 1, approval: (await r.json()).data.approval },
    f.g.id,
  ).approval;
  assert.equal(a.version, 2);
  assert.equal(a.draft.tasks[0].title, "韩语跟读");
  assert.deepEqual(
    await f.db
      .prepare("SELECT * FROM plan_versions WHERE id=?")
      .bind(f.parent.id)
      .first(),
    old,
  );
  assert.deepEqual(
    (
      await f.db
        .prepare(
          "SELECT * FROM scheduled_occurrences WHERE status IN ('completed','skipped') ORDER BY id",
        )
        .all()
    ).results,
    history,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM scheduled_occurrences WHERE id=?")
        .bind(rows[2].id)
        .first()
    ).status,
    "superseded",
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) n FROM scheduled_occurrences WHERE plan_version_id=?",
        )
        .bind(a.id)
        .first()
    ).n,
    4,
  );
  assert.equal(
    (await (await approvalResponse(request(), f.db, f.owner, "test")).json())
      .data.approval.id,
    a.id,
  );
  assert.equal((await state(f)).auto_schedule_key, null);
});

test("failed content regeneration leaves the approved calendar and draft unchanged", async (t) => {
  const f = await approved(t),
    old = (
      await f.db
        .prepare("SELECT * FROM scheduled_occurrences ORDER BY id")
        .all()
    ).results;
  await send(f, MORE, "failed-content-question");
  await send(f, "减少频次", "failed-content-answer");
  const job = await f.db
    .prepare("SELECT id FROM planning_jobs WHERE goal_revision=1")
    .first();
  await generate(f, job.id, "{}");
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM planning_jobs WHERE id=?")
        .bind(job.id)
        .first()
    ).status,
    "failed",
  );
  assert.deepEqual(
    (
      await f.db
        .prepare("SELECT * FROM scheduled_occurrences ORDER BY id")
        .all()
    ).results,
    old,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT plan_version_id FROM goal_active_plans")
        .first()
    ).plan_version_id,
    f.parent.id,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
});

test("automatic candidate recovery while a refinement card is open never starts a new paid job", async (t) => {
  const f = await approved(t);
  await send(f, MORE, "recovery-question");
  await send(f, "每周两次跟读", "recovery-answer");
  const job = await f.db
    .prepare("SELECT id FROM planning_jobs WHERE goal_revision=1")
    .first();
  await generate(f, job.id);
  await f.db
    .prepare("UPDATE calendar_states SET revision=revision+1 WHERE owner_id=?")
    .bind(f.owner)
    .run();
  const d = await state(f);
  await send(f, MORE, "second-question");
  await send(f, ASK_AUTO, d.auto_schedule_key);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    2,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_usage").first()).n,
    1,
  );
});

test("approval atomically rejects a different future instance set even when its count is unchanged", async (t) => {
  const f = await approved(t);
  const rows = (
    await f.db
      .prepare(
        "SELECT id FROM scheduled_occurrences WHERE goal_id=? ORDER BY start_at",
      )
      .bind(f.g.id)
      .all()
  ).results;
  await f.db
    .prepare("UPDATE scheduled_occurrences SET status='completed' WHERE id=?")
    .bind(rows[0].id)
    .run();
  await send(f, MORE, "racing-content-question");
  await send(f, "改成跟读", "racing-content-answer");
  const job = await f.db
    .prepare("SELECT id FROM planning_jobs WHERE goal_revision=1")
    .first();
  await generate(f, job.id);
  const d = await state(f);
  let armed = false,
    changed = false;
  const db = {
    prepare(query) {
      if (query.startsWith("INSERT OR IGNORE INTO plan_versions")) armed = true;
      return f.db.prepare(query);
    },
    async batch(statements) {
      if (armed && !changed) {
        changed = true;
        await f.db.batch([
          f.db
            .prepare(
              "UPDATE scheduled_occurrences SET status='scheduled' WHERE id=?",
            )
            .bind(rows[0].id),
          f.db
            .prepare(
              "UPDATE scheduled_occurrences SET status='completed' WHERE id=?",
            )
            .bind(rows[1].id),
        ]);
      }
      return f.db.batch(statements);
    },
  };
  const r = await approvalResponse(
    f.g.request("racing-content-approve", {
      schedule_run_id: d.auto_schedule_run_id,
      expected_goal_revision: 1,
      expected_calendar_revision: 1,
    }),
    db,
    f.owner,
    "test",
  );
  assert.equal(changed, true);
  assert.equal(r.status, 409);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT plan_version_id FROM goal_active_plans")
        .first()
    ).plan_version_id,
    f.parent.id,
  );
});

test("explicit retry preserves the complete failed revision across another question card and reserves once", async (t) => {
  const f = await approved(t),
    request = "改成韩语跟读，每次15分钟、每周2次，早上7点";
  await send(f, MORE, "retry-first-question");
  await send(f, request, "retry-first-answer");
  const first = await f.db
    .prepare("SELECT * FROM planning_jobs WHERE goal_revision=1")
    .first();
  await generate(f, first.id, "{}");
  assert.equal((await state(f)).retry_refinement, true);
  const progress = await planningResponse(
    new globalThis.Request(
      "http://localhost/api/v1/goals/" + f.g.id + "/planning-runs",
    ),
    f.db,
    f.owner,
    "test",
  );
  assert.equal((await progress.json()).data.retry_refinement, true);
  await send(f, MORE, "retry-open-question");
  const retried = await send(f, "按上次要求再试。", "retry-failed-revision");
  assert.equal((await retried.call()).status, 200);
  const jobs = (
    await f.db
      .prepare(
        "SELECT * FROM planning_jobs WHERE goal_revision=1 ORDER BY created_at,id",
      )
      .all()
  ).results;
  assert.equal(jobs.length, 2);
  const next = jobs.find((j) => j.id !== first.id),
    frozen = JSON.parse(next.context_json);
  assert.equal(frozen.revision_request, request);
  assert.equal(frozen.retry_of_run_id, first.source_run_id);
  assert.equal(frozen.retry_of_job_id, first.id);
  assert.equal(frozen.replan_parent_id, f.parent.id);
  assert.equal(retried.data.retry_refinement, false);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM plan_draft_usage WHERE owner_id=?")
        .bind(f.owner)
        .first()
    ).n,
    2,
  );
  await generate(f, next.id);
  assert.equal((await state(f)).retry_refinement, false);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
});

test("quota-rejected revision retains its requirements through repeated explicit retry without granting quota", async (t) => {
  const f = await approved(t),
    now = Date.now();
  for (let i = 0; i < 3; i++)
    await f.db
      .prepare(
        "INSERT INTO plan_draft_usage(id,owner_id,created_at) VALUES(?,?,?)",
      )
      .bind(globalThis.crypto.randomUUID(), f.owner, now)
      .run();
  const request = "改为15分钟并加入跟读，每周2次";
  await send(f, MORE, "quota-retry-question");
  await send(f, request, "quota-retry-answer");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    1,
  );
  assert.equal((await state(f)).retry_refinement, true);
  await send(f, "按上次要求再试。", "quota-still-full");
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_usage").first()).n,
    3,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    1,
  );
  await f.db
    .prepare("DELETE FROM plan_draft_usage WHERE owner_id=?")
    .bind(f.owner)
    .run();
  await send(f, "按上次要求再试。", "quota-restored-retry");
  const j = await f.db
    .prepare("SELECT context_json FROM planning_jobs WHERE goal_revision=1")
    .first();
  assert.equal(JSON.parse(j.context_json).revision_request, request);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_draft_usage").first()).n,
    1,
  );
});

test("a changed goal cannot retry an old frozen revision and GET never starts unknown work", async (t) => {
  const f = await approved(t);
  await send(f, MORE, "stale-retry-question");
  await send(f, "改成跟读", "stale-retry-answer");
  await f.db
    .prepare(
      "UPDATE planning_jobs SET status='unknown',error_code='PLANNING_RESULT_UNKNOWN' WHERE goal_revision=1",
    )
    .run();
  assert.equal((await state(f)).retry_refinement, true);
  assert.equal((await state(f)).retry_refinement, true);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    2,
  );
  await f.db
    .prepare("UPDATE goals SET revision=revision+1 WHERE id=?")
    .bind(f.g.id)
    .run();
  const d = await state(f);
  assert.equal(d.retry_refinement, false);
  const r = await dialogueResponse(
    new globalThis.Request(
      "http://localhost/api/v1/goals/" + f.g.id + "/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "stale-explicit-retry",
        },
        body: JSON.stringify({
          text: "按上次要求再试。",
          expected_chat_revision: d.chat_revision,
          expected_goal_revision: d.goal.revision,
        }),
      },
    ),
    f.db,
    f.owner,
    "test",
    {},
  );
  assert.equal(r.status, 409);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    2,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT plan_version_id FROM goal_active_plans")
        .first()
    ).plan_version_id,
    f.parent.id,
  );
});

test("discussion revision directly reserves a new draft, preserves the 21-day contract and leaves accepted history intact", async (t) => {
  const f = await approved(t, true);
  const before = (
    await f.db.prepare("SELECT * FROM scheduled_occurrences ORDER BY id").all()
  ).results;
  const result = await send(
    f,
    "按讨论修改策略：保留21天，把练习改到早上7点。",
    "direct-discussion-revision",
  );
  assert.equal(result.data.runs.at(-1).reply.stage, "draft_requested");
  assert.equal((await result.call()).status, 200);
  const job = await f.db
    .prepare("SELECT * FROM planning_jobs WHERE goal_revision=1")
    .first();
  const context = JSON.parse(job.context_json);
  assert.equal(context.planning_contract, "strategy_21_v1");
  assert.equal(context.revision_request, "保留21天，把练习改到早上7点。");
  assert.equal(context.replan_parent_id, f.parent.id);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    2,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM plan_versions").first()).n,
    1,
  );
  assert.deepEqual(
    (
      await f.db
        .prepare("SELECT * FROM scheduled_occurrences ORDER BY id")
        .all()
    ).results,
    before,
  );
});
