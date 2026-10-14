import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedPlan } from "../src/agent/plan-schema.ts";
import { deepseekProvider } from "../src/agent/provider.ts";
const env = {
  GUIDY_AI_ENABLED: "true",
  GUIDY_AI_MODEL: "deepseek-flash",
  DEEPSEEK_API_KEY: "synthetic-only-key",
};
const sourceId = "00000000-0000-0000-0000-000000000001";
const modelDraft = () => ({
  title: "基础学习草稿",
  summary: "以练习与复盘推进",
  assumptions: ["具体时间窗口待确认"],
  risks: ["引用内容未核实"],
  tasks: [
    {
      key: "t1",
      stage: 1,
      title: "准备资料",
      instructions: "阅读资料并列出问题",
      duration_minutes: 20,
      frequency_per_week: 3,
      mandatory: true,
      depends_on: [],
      evidence_ids: [sourceId],
    },
    {
      key: "t2",
      stage: 2,
      title: "复盘",
      instructions: "回顾练习与调整",
      duration_minutes: 10,
      frequency_per_week: 1,
      mandatory: false,
      depends_on: ["t1"],
      evidence_ids: [],
    },
  ],
});
test("draft schema rejects hallucinated citations, cycles, invalid numbers, false execution claims and unsupported fields", () => {
  const good = checkedPlan(JSON.stringify(modelDraft()), [sourceId]);
  assert.equal(good.weekly_minutes, 70);
  assert.equal(good.tasks[1].depends_on[0], good.tasks[0].id);
  assert.equal(good.scheduling_status, "not_checked");
  for (const mutate of [
    (d) => (d.tasks[0].evidence_ids = ["fake"]),
    (d) => (d.tasks[0].depends_on = ["t2"]),
    (d) => (d.tasks[0].duration_minutes = 0),
    (d) => (d.tasks[0].frequency_per_week = 8),
    (d) => (d.summary = "已入历"),
    (d) => (d.tasks[0].instructions = "服用50mg"),
    (d) => (d.extra = "untrusted"),
    (d) => (d.tasks[0].key = "t2"),
  ]) {
    const d = modelDraft();
    mutate(d);
    assert.throws(() => checkedPlan(JSON.stringify(d), [sourceId]));
  }
});
test("plan provider has distinct JSON prompt/output cap and preserves existing transport boundaries", async () => {
  const provider = deepseekProvider(
    env,
    async (url, options) => {
      const b = JSON.parse(options.body);
      assert.equal(b.max_tokens, 1800);
      assert.match(b.messages[0].content, /计划草稿/);
      assert.equal(options.redirect, "manual");
      assert.equal(url, "https://api.deepseek.com/beta/chat/completions");
      assert.equal(b.tools[0].function.strict, true);
      assert.equal(b.tools[0].function.parameters.additionalProperties, false);
      assert.deepEqual(
        b.tools[0].function.parameters.properties.tasks.items.properties
          .evidence_ids.items.enum,
        ["E1"],
      );
      assert.equal(b.tool_choice.function.name, "emit_plan");
      return globalThis.Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: "emit_plan",
                    arguments: JSON.stringify(modelDraft()),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    },
    "plan",
  );
  assert.equal(
    (
      await provider.complete(
        '{"sources":[{"evidence_ref":"E1"}]}',
        new globalThis.AbortController().signal,
      )
    ).outputTokens,
    20,
  );
});
