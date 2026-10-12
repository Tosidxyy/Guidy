import assert from "node:assert/strict";
import test from "node:test";
import { previewSchedule } from "../src/scheduling/preview.ts";

const M = 60_000;
const T = Date.parse("2026-10-12T00:00:00Z");
const span = (start, end) => ({ start_at: T + start * M, end_at: T + end * M });
const task = (id, extra = {}) => ({
  id,
  duration_minutes: 20,
  depends_on: [],
  ...extra,
});
const input = (extra = {}) => ({
  schema_version: 1,
  timezone: "Asia/Shanghai",
  horizon: span(0, 1440),
  windows: [span(0, 60)],
  busy: [],
  tasks: [task("a")],
  completed_dependencies: [],
  ...extra,
});

test("earliest preview merges windows, respects half-open busy bounds, preserves input", () => {
  const value = input({
    windows: [span(20, 60), span(0, 30)],
    busy: [span(0, 10), span(10, 20), span(40, 50)],
    tasks: [task("b"), task("a")],
  });
  const original = JSON.parse(JSON.stringify(value));
  const result = previewSchedule(value);
  assert.deepEqual(result.placements, [{ task_id: "a", ...span(20, 40) }]);
  assert.deepEqual(result.unplaced, [
    { task_id: "b", reason: "no_legal_window" },
  ]);
  assert.equal(result.status, "preview_only");
  assert.deepEqual(value, original);
  assert.deepEqual(
    result,
    previewSchedule({
      ...value,
      tasks: [...value.tasks].reverse(),
      windows: [...value.windows].reverse(),
    }),
  );
});

test("dependencies precede successors; unplaced ancestors block descendants", () => {
  const result = previewSchedule(
    input({
      tasks: [
        task("a", { depends_on: ["z"] }),
        task("z"),
        task("b", { depends_on: ["a"] }),
        task("c", { depends_on: ["b"] }),
      ],
    }),
  );
  assert.deepEqual(
    result.placements.map((entry) => entry.task_id),
    ["z", "a", "b"],
  );
  assert.deepEqual(result.unplaced, [
    { task_id: "c", reason: "no_legal_window" },
  ]);
  const blocked = previewSchedule(
    input({
      windows: [],
      tasks: [task("a"), task("b", { depends_on: ["a"] })],
    }),
  );
  assert.deepEqual(blocked.unplaced, [
    { task_id: "a", reason: "no_legal_window" },
    { task_id: "b", reason: "dependency_unplaced" },
  ]);
});

test("verified prior completion is allowed; missing or future completion is rejected", () => {
  assert.equal(
    previewSchedule(
      input({
        completed_dependencies: [{ id: "prior", completed_at: T }],
        tasks: [task("a", { depends_on: ["prior"] })],
      }),
    ).placements.length,
    1,
  );
  for (const value of [
    input({ tasks: [task("a", { depends_on: ["missing"] })] }),
    input({ completed_dependencies: [{ id: "prior", completed_at: T + 1 }] }),
  ]) {
    assert.throws(() => previewSchedule(value), /INVALID_SCHEDULE_INPUT/);
  }
});

test("cycles, duplicate task IDs and duplicate edges fail the entire preview", () => {
  for (const tasks of [
    [task("a", { depends_on: ["b"] }), task("b", { depends_on: ["a"] })],
    [task("a"), task("a")],
    [task("a", { depends_on: ["a"] })],
    [task("a"), task("b", { depends_on: ["a", "a"] })],
  ]) {
    assert.throws(
      () => previewSchedule(input({ tasks })),
      /INVALID_SCHEDULE_INPUT/,
    );
  }
});

test("fixed time, earliest, deadline and non-splitting constraints", () => {
  assert.deepEqual(
    previewSchedule(
      input({
        tasks: [
          task("a", { fixed_start_at: T + 40 * M, deadline_at: T + 60 * M }),
        ],
      }),
    ).placements,
    [{ task_id: "a", ...span(40, 60) }],
  );
  for (const extra of [
    { tasks: [task("a", { earliest_at: T + 41 * M })] },
    { tasks: [task("a", { deadline_at: T + 19 * M })] },
    {
      tasks: [task("a", { fixed_start_at: T + 10 * M })],
      busy: [span(20, 30)],
    },
    { windows: [span(0, 10), span(20, 30)] },
  ]) {
    assert.equal(previewSchedule(input(extra)).placements.length, 0);
  }
});

test("same series requires the larger of both rest gaps; unrelated tasks can use gap", () => {
  const result = previewSchedule(
    input({
      windows: [span(0, 100)],
      tasks: [
        task("a", { series_id: "study", minimum_gap_minutes: 30 }),
        task("b", { series_id: "study", minimum_gap_minutes: 10 }),
        task("c"),
      ],
    }),
  );
  assert.deepEqual(result.placements, [
    { task_id: "a", ...span(0, 20) },
    { task_id: "b", ...span(50, 70) },
    { task_id: "c", ...span(20, 40) },
  ]);
});

test("UTC instants support cross-midnight and real DST duration, never infer wall time", () => {
  const start = Date.parse("2026-11-01T01:30:00-04:00");
  const end = Date.parse("2026-11-01T01:30:00-05:00");
  const result = previewSchedule(
    input({
      timezone: "America/New_York",
      horizon: { start_at: start, end_at: end },
      windows: [{ start_at: start, end_at: end }],
      tasks: [task("a", { duration_minutes: 60 })],
    }),
  );
  assert.equal(
    result.placements[0].end_at - result.placements[0].start_at,
    60 * M,
  );
  assert.deepEqual(
    previewSchedule(
      input({
        horizon: span(1400, 1500),
        windows: [span(1430, 1460)],
        tasks: [task("a", { duration_minutes: 30 })],
      }),
    ).placements,
    [{ task_id: "a", ...span(1430, 1460) }],
  );
});

test("malformed runtime input, invalid zone, unbounded horizon/count and invalid ranges", () => {
  for (const value of [
    null,
    input({ timezone: "UTC+8" }),
    input({ timezone: "Asia/Fake" }),
    input({ windows: null }),
    input({ busy: [span(2, 1)] }),
    input({ horizon: span(0, 32 * 1440) }),
    input({ tasks: Array.from({ length: 101 }, (_, i) => task(`t${i}`)) }),
    input({ tasks: [task("a", { duration_minutes: NaN })] }),
    input({ tasks: [task("a", { fixed_start_at: "tomorrow" })] }),
    input({ tasks: [task("a", { minimum_gap_minutes: 20 })] }),
    input({ horizon: { start_at: -1, end_at: T } }),
  ]) {
    assert.throws(() => previewSchedule(value), /INVALID_SCHEDULE_INPUT/);
  }
});

test("bounded generated cases: every placement fits a window and avoids all occupancy", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const value = input({
      windows: [span(0, 90), span(100, 200)],
      busy: [span(seed, seed + 15), span(130, 140)],
      tasks: Array.from({ length: 8 }, (_, index) =>
        task(`t${index}`, { duration_minutes: 5 + ((index * seed) % 30) }),
      ),
    });
    const result = previewSchedule(value);
    assert.equal(
      result.placements.length + result.unplaced.length,
      value.tasks.length,
    );
    for (const [index, entry] of result.placements.entries()) {
      assert.ok(
        value.windows.some(
          (window) =>
            entry.start_at >= window.start_at && entry.end_at <= window.end_at,
        ),
      );
      assert.ok(
        [...value.busy, ...result.placements.slice(0, index)].every(
          (block) =>
            entry.end_at <= block.start_at || entry.start_at >= block.end_at,
        ),
      );
    }
  }
});
