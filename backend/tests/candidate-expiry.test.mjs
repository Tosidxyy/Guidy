import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./replan-fixture.mjs";
import { dialogueResponse } from "../src/agent/harness.ts";
import { approvalResponse } from "../src/scheduling/approval.ts";
import { ASK_AUTO } from "../src/scheduling/chat.ts";
import { automaticScheduleKey } from "../src/scheduling/automatic-key.ts";
import { checkedDialogue } from "../../apps/mobile/src/goals/dialogue.ts";
import { candidateExpired } from "../../apps/mobile/src/goals/candidate-expiry.ts";

test("expired candidate refresh is free, immutable, replayable and never confirms itself", async (t) => {
  const f = await setup(t),
    g = await f.goal();
  const original = await f.db
    .prepare("SELECT * FROM agent_runs WHERE id=?")
    .bind(g.body.schedule_run_id)
    .first();
  const yesterday = automaticScheduleKey(
    g.attempt,
    0,
    0,
    "Asia/Shanghai",
    Date.now() - 86400000,
  );
  const expired = JSON.parse(original.reply_json);
  const delta =
    Math.ceil(
      (expired.schedule.preview.placements[0].start_at - Date.now() + 1000) /
        86400000,
    ) * 86400000;
  const shift = (value) => {
    if (Array.isArray(value)) value.forEach(shift);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (["start_at", "end_at", "earliest_at", "deadline_at"].includes(key))
          value[key] -= delta;
        else shift(child);
      }
  };
  shift(expired.schedule);
  // Only fixtures are altered; production candidates are append-only.
  await f.db
    .prepare("UPDATE agent_runs SET request_key=?,reply_json=? WHERE id=?")
    .bind(yesterday, JSON.stringify(expired), original.id)
    .run();
  const before = await f.db
    .prepare("SELECT draft_json FROM plan_draft_attempts WHERE id=?")
    .bind(g.attempt)
    .first();
  const url = `http://localhost/api/v1/goals/${g.id}/messages`;
  const read = async () => {
    const r = await dialogueResponse(
      new globalThis.Request(url),
      f.db,
      f.owner,
      "test",
      {},
    );
    assert.equal(r.status, 200);
    return (await r.json()).data;
  };
  const state = await read();
  checkedDialogue(state);
  assert.ok(candidateExpired(state.auto_schedule));
  assert.notEqual(state.auto_schedule_key, yesterday);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM agent_runs").first()).n,
    2,
  );
  const body = {
    text: ASK_AUTO,
    expected_chat_revision: state.chat_revision,
    expected_goal_revision: state.goal.revision,
  };
  const request = () =>
    new globalThis.Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": state.auto_schedule_key,
      },
      body: JSON.stringify(body),
    });
  const provider = {
    complete: async () => {
      throw Error("Refresh must not call a model");
    },
  };
  for (let i = 0; i < 2; i++) {
    const r = await dialogueResponse(
      request(),
      f.db,
      f.owner,
      "test",
      {},
      provider,
    );
    assert.equal(r.status, 200);
  }
  const fresh = await read();
  checkedDialogue(fresh);
  assert.equal(candidateExpired(fresh.auto_schedule), false);
  assert.notEqual(fresh.auto_schedule_run_id, original.id);
  assert.equal(
    (
      await f.db
        .prepare("SELECT reply_json FROM agent_runs WHERE id=?")
        .bind(original.id)
        .first()
    ).reply_json,
    JSON.stringify(expired),
  );
  assert.deepEqual(
    await f.db
      .prepare("SELECT draft_json FROM plan_draft_attempts WHERE id=?")
      .bind(g.attempt)
      .first(),
    before,
  );
  for (const table of [
    "plan_versions",
    "tasks",
    "scheduled_occurrences",
    "search_attempts",
  ]) {
    assert.equal(
      (await f.db.prepare(`SELECT count(*) n FROM ${table}`).first()).n,
      0,
    );
  }
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM planning_jobs").first()).n,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) n FROM agent_runs WHERE harness_version='schedule-chat-v1'",
        )
        .first()
    ).n,
    2,
  );
  const confirmed = await approvalResponse(
    g.request("fresh-confirm-key", {
      ...g.body,
      schedule_run_id: fresh.auto_schedule_run_id,
    }),
    f.db,
    f.owner,
    "test",
  );
  assert.equal(confirmed.status, 200);
  const accepted = (await confirmed.json()).data.approval;
  assert.equal((await read()).auto_schedule_key, null);
  const replay = await approvalResponse(
    g.request("fresh-confirm-key", {
      ...g.body,
      schedule_run_id: fresh.auto_schedule_run_id,
    }),
    f.db,
    f.owner,
    "test",
  );
  assert.equal((await replay.json()).data.approval.id, accepted.id);
});
