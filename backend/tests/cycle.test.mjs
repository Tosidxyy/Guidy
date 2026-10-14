import test from "node:test";
import assert from "node:assert/strict";
import { planCycle } from "../src/scheduling/cycle.ts";
import { previewSchedule } from "../src/scheduling/preview.ts";
import { checkedSchedule } from "../../apps/mobile/src/goals/schedule.ts";
import { checkedPlan } from "../src/agent/plan-schema.ts";
const DAY = 86400000;
const start = Date.parse("2026-10-15T00:00:00+08:00");
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
const tasks = [
  {
    id: ids[0],
    stage: 1,
    title: "基础",
    duration_minutes: 20,
    frequency_per_week: 3,
    depends_on: [],
  },
  {
    id: ids[1],
    stage: 2,
    title: "交流",
    duration_minutes: 20,
    frequency_per_week: 2,
    depends_on: [ids[0]],
  },
];
function make(
  weeks = [
    { stage: 1, weeks: 2 },
    { stage: 2, weeks: 3 },
  ],
) {
  const expanded = planCycle(tasks, weeks, start);
  assert.ok(expanded);
  const windows = Array.from(
    { length: (expanded.period.end_at - start) / DAY },
    (_, i) => ({
      start_at: start + i * DAY + 20 * 3600000,
      end_at: start + i * DAY + 21 * 3600000,
    }),
  );
  const preview = previewSchedule({
    schema_version: 1,
    period_mode: "full_plan_cycle_v1",
    timezone: "Asia/Shanghai",
    horizon: expanded.period,
    windows,
    busy: [],
    tasks: expanded.tasks,
    completed_dependencies: [],
  });
  return {
    attempt_id: ids[0],
    goal_revision: 0,
    review_revision: 0,
    timezone: "Asia/Shanghai",
    scope: "full_plan_cycle_v1",
    window_basis: "assumed_default_v1",
    windows,
    ...expanded,
    preview,
  };
}
test("all stages/weeks appear across month boundaries; dependencies and weekly frequency remain bounded", () => {
  const schedule = make();
  checkedSchedule(schedule, "schedule_preview");
  assert.equal(schedule.tasks.length, 12);
  assert.equal(schedule.preview.placements.length, 12);
  assert.equal(schedule.period.end_at - start, 35 * DAY);
  for (const t of schedule.tasks) {
    const p = schedule.preview.placements.find((p) => p.task_id === t.id);
    assert.ok(p.start_at >= t.earliest_at && p.end_at <= t.deadline_at);
  }
  const phase1 = schedule.preview.placements.filter((p) =>
      p.task_id.startsWith(ids[0]),
    ),
    phase2 = schedule.preview.placements.filter((p) =>
      p.task_id.startsWith(ids[1]),
    );
  assert.ok(
    Math.max(...phase1.map((p) => p.end_at)) <=
      Math.min(...phase2.map((p) => p.start_at)),
  );
  const forged = globalThis.structuredClone(schedule);
  forged.tasks[0].week = 3;
  assert.throws(() => checkedSchedule(forged, "schedule_preview"));
  const changed = globalThis.structuredClone(schedule);
  changed.stages[1].start_at += DAY;
  assert.throws(() => checkedSchedule(changed, "schedule_preview"));
});
test("84-day cycles cover more than 100 instances without relaxing legacy limits or inventing completion", () => {
  const templates = Array.from({ length: 6 }, (_, i) => ({
    ...tasks[0],
    id: `task${i}`,
    frequency_per_week: 7,
    duration_minutes: 5,
  }));
  const expanded = planCycle(templates, [{ stage: 1, weeks: 12 }], start);
  assert.equal(expanded.tasks.length, 504);
  const windows = Array.from({ length: 84 }, (_, i) => ({
    start_at: start + i * DAY + 20 * 3600000,
    end_at: start + i * DAY + 21 * 3600000,
  }));
  const input = {
    schema_version: 1,
    period_mode: "full_plan_cycle_v1",
    timezone: "Asia/Shanghai",
    horizon: expanded.period,
    windows,
    busy: [],
    tasks: expanded.tasks,
    completed_dependencies: [],
  };
  const preview = previewSchedule(input);
  assert.equal(preview.placements.length, 504);
  assert.equal(preview.unplaced.length, 0);
  const legacy = { ...input };
  delete legacy.period_mode;
  assert.throws(() => previewSchedule(legacy));
  assert.equal(planCycle(templates, [{ stage: 1, weeks: 13 }], start), null);
  assert.equal(planCycle(tasks, [{ stage: 1, weeks: 1 }], start), null);
});
test("blocked windows leave shortages in their own week and never silently push work into later weeks", () => {
  const schedule = make();
  const busy = schedule.windows.slice(0, 7);
  const preview = previewSchedule({
    schema_version: 1,
    period_mode: "full_plan_cycle_v1",
    timezone: schedule.timezone,
    horizon: schedule.period,
    windows: schedule.windows,
    busy,
    tasks: schedule.tasks,
    completed_dependencies: [],
  });
  assert.ok(preview.unplaced.length >= 3);
  for (const p of preview.placements) {
    const t = schedule.tasks.find((t) => t.id === p.task_id);
    assert.ok(p.start_at >= t.earliest_at && p.end_at <= t.deadline_at);
  }
});
test("stage weeks must cover exactly the ordered task phases and stay within the total bound", () => {
  const base = {
    title: "方案",
    summary: "练习",
    assumptions: [],
    risks: [],
    tasks: tasks.map((t, i) => ({
      ...t,
      key: `t${i + 1}`,
      instructions: "按步骤练习并记录结果",
      mandatory: true,
      evidence_ids: [],
      depends_on: i ? ["t1"] : [],
    })),
  };
  for (const t of base.tasks) delete t.id;
  assert.deepEqual(
    checkedPlan(
      JSON.stringify({
        ...base,
        stage_weeks: [
          { stage: 1, weeks: 2 },
          { stage: 2, weeks: 3 },
        ],
      }),
      [],
      true,
    ).stage_weeks,
    [
      { stage: 1, weeks: 2 },
      { stage: 2, weeks: 3 },
    ],
  );
  assert.throws(() =>
    checkedPlan(
      JSON.stringify({
        ...base,
        stage_weeks: [
          { stage: 1, weeks: 12 },
          { stage: 2, weeks: 1 },
        ],
      }),
      [],
      true,
    ),
  );
  assert.throws(() =>
    checkedPlan(
      JSON.stringify({
        ...base,
        stage_weeks: [
          { stage: 2, weeks: 1 },
          { stage: 1, weeks: 1 },
        ],
      }),
      [],
      true,
    ),
  );
  assert.equal(
    planCycle(tasks, undefined, start).period_basis,
    "assumed_one_week_per_stage_v1",
  );
});
