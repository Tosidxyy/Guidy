import assert from "node:assert/strict";
import test from "node:test";
import { weeklyTrial } from "../src/scheduling/weekly.ts";
import { previewSchedule } from "../src/scheduling/preview.ts";
const start = Date.parse("2026-10-20T12:00:00Z");
const windows = Array.from({ length: 7 }, (_, index) => ({
  start_at: start + index * 86400000,
  end_at: start + index * 86400000 + 3600000,
}));
const template = (id, frequency = 3, depends_on = []) => ({
  id,
  title: id,
  duration_minutes: 20,
  frequency_per_week: frequency,
  depends_on,
});
function preview(tasks, timezone = "Asia/Shanghai", busy = []) {
  const value = weeklyTrial(tasks, windows, timezone);
  return previewSchedule({
    schema_version: 1,
    timezone,
    horizon: value.period,
    windows,
    busy,
    tasks: value.tasks,
    completed_dependencies: [],
  });
}
test("seven daily instances respect local day, occupancy and exact weekly boundaries", () => {
  const result = preview([template("a", 7)]);
  assert.equal(result.placements.length, 7);
  const occupied = preview([template("a", 7)], "Asia/Shanghai", [windows[3]]);
  assert.equal(occupied.placements.length, 6);
  assert.equal(occupied.unplaced.length, 1);
  assert.equal(
    weeklyTrial(
      [template("a")],
      [
        windows[0],
        {
          start_at: windows[0].start_at + 7 * 86400000,
          end_at: windows[0].end_at + 7 * 86400000,
        },
      ],
      "UTC",
    ),
    null,
  );
  assert.equal(weeklyTrial([template("a")], [], "UTC"), null);
});
test("all prerequisite trial instances precede successors, own repetitions preserve ordinal", () => {
  const value = weeklyTrial(
    [template("a", 2), template("b", 2, ["a"])],
    windows,
    "UTC",
  );
  assert.deepEqual(value.tasks.find((task) => task.id === "b_1").depends_on, [
    "a_1",
    "a_2",
  ]);
  const result = preview([template("a", 2), template("b", 2, ["a"])], "UTC");
  assert.equal(result.placements.length, 4);
  assert.ok(
    result.placements.find((p) => p.task_id === "b_1").start_at >=
      result.placements.find((p) => p.task_id === "a_2").end_at,
  );
  assert.equal(
    weeklyTrial([template("a", 2, ["unknown"])], windows, "UTC"),
    null,
  );
});
test("daily constraints use confirmed timezone rather than UTC date and disallow crossing a local midnight", () => {
  const midnight = Date.parse("2026-10-20T16:00:00Z");
  const base = {
    schema_version: 1,
    timezone: "Asia/Shanghai",
    horizon: { start_at: midnight - 3600000, end_at: midnight + 3600000 },
    windows: [{ start_at: midnight - 3600000, end_at: midnight + 3600000 }],
    busy: [],
    completed_dependencies: [],
    tasks: [
      {
        id: "a",
        series_id: "x",
        max_per_day: 1,
        duration_minutes: 30,
        depends_on: [],
      },
      {
        id: "b",
        series_id: "x",
        max_per_day: 1,
        duration_minutes: 30,
        depends_on: [],
      },
    ],
  };
  assert.equal(previewSchedule(base).placements.length, 2);
  assert.equal(
    previewSchedule({ ...base, timezone: "UTC" }).placements.length,
    1,
  );
  assert.equal(
    previewSchedule({
      ...base,
      tasks: [{ ...base.tasks[0], duration_minutes: 90 }],
    }).placements.length,
    0,
  );
  assert.throws(
    () => previewSchedule({ ...base, timezone: "America/New_York" }),
    /INVALID_SCHEDULE_INPUT/,
  );
});
