import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { clarificationReadiness } from "../src/agent/readiness.ts";
const confirmed = (key, text) => ({
  key,
  source: "user",
  confirmed_at: 123,
  value: { schema_version: 1, state: "confirmed", text },
});
test("learning, fitness and skincare readiness fixtures remain deterministic", async () => {
  const cases = JSON.parse(
    await readFile(
      new URL("../evals/clarification-readiness.json", import.meta.url),
      "utf8",
    ),
  );
  for (const item of cases) {
    const slots = Object.entries(item.confirmed).map(([key, text]) =>
      confirmed(key, text),
    );
    const result = clarificationReadiness(
      { revision: 4, status: item.status ?? "draft", description: item.goal },
      slots,
      item.policy ?? false,
    );
    assert.equal(result.phase, item.expected, item.name);
    assert.equal(result.goal_revision, 4);
  }
});
test("unknown and untrusted slots never count as user-confirmed prerequisites", () => {
  const goal = { revision: 0, status: "draft", description: "学习英语" };
  for (const override of [
    { source: "deepseek" },
    { confirmed_at: null },
    { value: { schema_version: 1, state: "unknown", text: "每晚20分钟" } },
    { value: { schema_version: 2, state: "confirmed", text: "每晚20分钟" } },
  ]) {
    const value = clarificationReadiness(
      goal,
      [
        confirmed("outcome", "旅行交流"),
        { ...confirmed("available_time", "每晚20分钟"), ...override },
      ],
      false,
    );
    assert.equal(value.phase, "needs_confirmation");
    assert.deepEqual(value.missing_required, ["available_time"]);
  }
});
