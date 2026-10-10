import assert from "node:assert/strict";
import { test } from "node:test";
import { sendOtpEmail } from "../src/email.ts";

test("Resend transport uses server key, fixed HTTPS endpoint and private idempotency key", async () => {
  let calls = 0;
  await sendOtpEmail(
    {
      RESEND_API_KEY: "test-only-key",
      GUIDY_EMAIL_FROM: "onboarding@resend.dev",
    },
    "receiver@example.invalid",
    "531246",
    async (url, options) => {
      calls++;
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer test-only-key");
      assert.match(
        options.headers["Idempotency-Key"],
        /^guidy-otp-[0-9a-f-]{36}$/,
      );
      assert.ok(!options.headers["Idempotency-Key"].includes("receiver"));
      const body = JSON.parse(options.body);
      assert.equal(body.from, "Guidy <onboarding@resend.dev>");
      assert.deepEqual(body.to, ["receiver@example.invalid"]);
      assert.ok(body.text.includes("531246"));
      assert.ok(!body.text.includes("test-only-key"));
      return globalThis.Response.json({ id: "test-provider-message-id" });
    },
  );
  assert.equal(calls, 1);
});

test("provider rejection, malformed response and network failure never echo provider secrets", async () => {
  const env = {
    RESEND_API_KEY: "test-only-key",
    GUIDY_EMAIL_FROM: "onboarding@resend.dev",
  };
  for (const fetcher of [
    async () =>
      new globalThis.Response("private-provider-error", { status: 403 }),
    async () => globalThis.Response.json({}),
    async () => {
      throw new Error("private-provider-error");
    },
  ]) {
    await assert.rejects(
      sendOtpEmail(env, "receiver@example.invalid", "531246", fetcher),
      (error) => error.message === "OTP email delivery failed",
    );
  }
  await assert.rejects(
    sendOtpEmail(
      { ...env, GUIDY_EMAIL_FROM: "bad\nheader" },
      "receiver@example.invalid",
      "531246",
      () => {
        assert.fail("unsafe sender must not fetch");
      },
    ),
  );
});
