import assert from "node:assert/strict";
import { test } from "node:test";
import { sendOtpEmail } from "../src/email.ts";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import ts from "typescript";

test("default mail transport runs inside the real Workers runtime", async (t) => {
  const source = await readFile(
    new URL("../src/email.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  let calls = 0;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-10-09",
      script:
        compiled +
        `\nexport default {async fetch(){await sendOtpEmail({RESEND_API_KEY:'test-only-key',GUIDY_EMAIL_FROM:'onboarding@resend.dev'},'receiver@example.invalid','531246');return new Response('ok')}}`,
      outboundService: async (request) => {
        calls++;
        assert.equal(request.url, "https://api.resend.com/emails");
        assert.equal(request.method, "POST");
        return globalThis.Response.json({ id: "test-worker-message" });
      },
    }),
  );
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch("http://localhost/");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 1);
});

test("safe provider status classification never includes response content", async () => {
  const env = {
    RESEND_API_KEY: "test-only-key",
    GUIDY_EMAIL_FROM: "onboarding@resend.dev",
  };
  for (const [status, code] of [
    [401, "EMAIL_PROVIDER_AUTH_FAILED"],
    [403, "EMAIL_PROVIDER_REJECTED"],
    [429, "EMAIL_PROVIDER_RATE_LIMITED"],
    [500, "EMAIL_PROVIDER_UNAVAILABLE"],
  ]) {
    await assert.rejects(
      sendOtpEmail(
        env,
        "receiver@example.invalid",
        "531246",
        async () =>
          new globalThis.Response("private-key-address-and-otp", { status }),
      ),
      (err) => err.code === code && err.message === "OTP email delivery failed",
    );
  }
});

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
      assert.equal(options.redirect, "manual");
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

test("clipboard whitespace is trimmed but malformed header keys are rejected privately", async () => {
  const env = {
    RESEND_API_KEY: "  test-only-key\n",
    GUIDY_EMAIL_FROM: "onboarding@resend.dev",
  };
  await sendOtpEmail(
    env,
    "receiver@example.invalid",
    "531246",
    async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer test-only-key");
      return globalThis.Response.json({ id: "test-id" });
    },
  );
  await assert.rejects(
    sendOtpEmail(
      { ...env, RESEND_API_KEY: "invalid\nheader" },
      "receiver@example.invalid",
      "531246",
      async () => assert.fail("Invalid credential must not fetch"),
    ),
    (err) => err.code === "EMAIL_PROVIDER_AUTH_FAILED",
  );
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
