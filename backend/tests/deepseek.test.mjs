import assert from "node:assert/strict";
import { test } from "node:test";
import { deepseekProvider } from "../src/agent/provider.ts";
import { checkedSuggestions } from "../src/agent/suggestions.ts";
const env = {
  GUIDY_AI_ENABLED: "true",
  GUIDY_AI_MODEL: "deepseek-flash",
  DEEPSEEK_API_KEY: " unit-test-private-key ",
};
test("DeepSeek adapter bounds transport and returns content without reasoning or credentials", async () => {
  const provider = deepseekProvider(env, async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer unit-test-private-key");
    const body = JSON.parse(options.body);
    assert.equal(body.thinking.type, "disabled");
    assert.equal(body.max_tokens, 650);
    assert.equal(body.stream, false);
    assert.equal(body.response_format.type, "json_object");
    assert.deepEqual(
      body.messages.map((m) => m.role),
      ["system", "user"],
    );
    assert.ok(!JSON.stringify(body.messages).includes("unit-test-private-key"));
    return globalThis.Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: '{"question":"每周能安排几次？","reason":"确认时间"}',
            reasoning_content: "private reasoning",
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    });
  });
  const result = await provider.complete(
    "test context",
    new globalThis.AbortController().signal,
  );
  assert.equal(result.inputTokens, 12);
  assert.ok(!JSON.stringify(result).includes("private reasoning"));
});

test("slot suggestions require this user's exact evidence and a bounded unique schema", () => {
  const valid = {
    key: "available_time",
    text: "每晚20分钟",
    evidence: "每晚20分钟",
  };
  assert.deepEqual(checkedSuggestions([valid], "我能每晚20分钟"), [valid]);
  assert.deepEqual(checkedSuggestions(undefined, "不知道"), []);
  for (const value of [
    [{ ...valid, text: "每晚一小时" }],
    [{ ...valid, evidence: "旧消息" }],
    [{ ...valid, key: "owner_id" }],
    [{ ...valid, confirmed: true }],
    [valid, valid],
    [{ ...valid, text: " ", evidence: " " }],
    { suggestions: [valid] },
  ])
    assert.throws(() => checkedSuggestions(value, "我能每晚20分钟"));
  assert.throws(() => checkedSuggestions([valid], "当前消息没有这项信息"));
});
test("provider failures, tool calls and truncated replies fail without echoing upstream bodies", async () => {
  for (const response of [
    new globalThis.Response("private error", { status: 401 }),
    new globalThis.Response("private error", {
      status: 302,
      headers: { Location: "https://untrusted.invalid" },
    }),
    globalThis.Response.json({
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: "private" },
        },
      ],
    }),
    globalThis.Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "{}",
            tool_calls: [{ id: "unapproved" }],
          },
        },
      ],
    }),
  ]) {
    await assert.rejects(
      deepseekProvider(env, async () => response).complete(
        "{}",
        new globalThis.AbortController().signal,
      ),
      (error) =>
        error.message === "AI request failed" &&
        !error.message.includes("private"),
    );
  }
  assert.throws(() =>
    deepseekProvider({ ...env, GUIDY_AI_MODEL: "unapproved-model" }),
  );
});
