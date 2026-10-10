import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { createApp } from "../src/index.ts";
import { createAuth } from "../src/auth.ts";
import { getMigrations } from "better-auth/db/migration";

async function fixture(t) {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: "2026-10-09",
      d1Databases: ["DB"],
      d1Persist: false,
    }),
  );
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  for (const file of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL("../migrations/" + file, import.meta.url),
      "utf8",
    );
    const statements = sql
      .replace(/^[ \t]*--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  const records = [];
  const app = createApp({ logger: (record) => records.push(record) });
  const env = {
    DB: db,
    GUIDY_AUTH_MODE: "local-inbox",
    BETTER_AUTH_SECRET: "test-only-unshared-secret-at-least-32-bytes",
    BETTER_AUTH_URL: "http://127.0.0.1:8787",
    GUIDY_CORS_ORIGINS: '["http://localhost:8090"]',
  };
  const request = (path, body, cookie = "", extra = {}) =>
    app.fetch(
      new globalThis.Request("http://127.0.0.1:8787" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:8090",
          "CF-Connecting-IP": "192.0.2.1",
          ...(cookie ? { Cookie: cookie } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const otp = async (email) =>
    (
      await db
        .prepare("SELECT otp FROM dev_auth_inbox WHERE email=?")
        .bind(email)
        .first()
    ).otp;
  const signIn = async (email) => {
    assert.equal(
      (
        await request("/api/auth/email-otp/send-verification-otp", {
          email,
          type: "sign-in",
        })
      ).status,
      200,
    );
    const response = await request("/api/auth/sign-in/email-otp", {
      email,
      otp: await otp(email),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    return { cookie, body: await response.json() };
  };
  return { db, env, request, otp, signIn, records, app };
}

test("real D1 OTP login, hashed verifier, profile, recovery, logout and revoked cookie", async (t) => {
  const { db, request, otp, records } = await fixture(t);
  const email = "alpha@example.invalid";
  assert.equal((await request("/api/v1/me")).status, 401);
  assert.equal(
    (
      await request("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      })
    ).status,
    200,
  );
  const code = await otp(email);
  const verifier = await db.prepare("SELECT value FROM verification").first();
  assert.ok(!verifier.value.includes(code));
  assert.equal(
    (await request("/api/auth/sign-in/email-otp", { email, otp: "not-an-otp" }))
      .status,
    400,
  );
  const success = await request("/api/auth/sign-in/email-otp", {
    email,
    otp: code,
  });
  assert.equal(success.status, 200);
  const cookies = success.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const me = await request("/api/v1/me", undefined, cookies);
  assert.equal(me.status, 200);
  const account = (await me.json()).data;
  assert.equal(account.email, email);
  assert.equal(account.name, "Guidy 用户");
  assert.equal(account.token, undefined);
  assert.ok(
    await db
      .prepare("SELECT user_id FROM profiles WHERE user_id=?")
      .bind(account.id)
      .first(),
  );
  assert.equal(
    (await request("/api/auth/get-session", undefined, cookies)).status,
    200,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM dev_auth_inbox").first()).n,
    0,
  );
  assert.equal(
    (await request("/api/auth/sign-in/email-otp", { email, otp: code })).status,
    400,
  );
  assert.equal((await request("/api/auth/sign-out", {}, cookies)).status, 200);
  assert.equal((await request("/api/v1/me", undefined, cookies)).status, 401);
  assert.ok(!JSON.stringify(records).includes(email));
  assert.ok(!JSON.stringify(records).includes(code));
});

test("cross-user identity, expired session and expired OTP are rejected", async (t) => {
  const { db, request, signIn, otp } = await fixture(t);
  const a = await signIn("a@example.invalid");
  const b = await signIn("b@example.invalid");
  const response = await request(
    "/api/v1/me?owner_id=" + b.body.user.id,
    undefined,
    a.cookie,
    { "X-User-ID": b.body.user.id },
  );
  assert.equal((await response.json()).data.id, a.body.user.id);
  await db
    .prepare("UPDATE session SET expiresAt=? WHERE userId=?")
    .bind(0, a.body.user.id)
    .run();
  assert.equal((await request("/api/v1/me", undefined, a.cookie)).status, 401);
  assert.equal((await request("/api/v1/me", undefined, b.cookie)).status, 200);
  const email = "expired@example.invalid";
  assert.equal(
    (
      await request("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      })
    ).status,
    200,
  );
  const code = await otp(email);
  await db.prepare("UPDATE verification SET expiresAt=?").bind(0).run();
  assert.equal(
    (await request("/api/auth/sign-in/email-otp", { email, otp: code })).status,
    400,
  );
});

test("native Expo origin and cookie authenticate without browser credentials", async (t) => {
  const { app, env, otp } = await fixture(t);
  const native = (path, body, cookie = "") =>
    app.fetch(
      new globalThis.Request("http://127.0.0.1:8787" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "expo-origin": "guidy://",
          "CF-Connecting-IP": "192.0.2.3",
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const email = "native@example.invalid";
  assert.equal(
    (
      await native("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      })
    ).status,
    200,
  );
  const login = await native("/api/auth/sign-in/email-otp", {
    email,
    otp: await otp(email),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.equal((await native("/api/v1/me", undefined, cookie)).status, 200);
  assert.equal((await native("/api/auth/sign-out", {}, cookie)).status, 200);
  assert.equal((await native("/api/auth/sign-out", {}, cookie)).status, 200);
  assert.equal((await native("/api/v1/me", undefined, cookie)).status, 401);
});

test("Resend test-mode OTP creates a real session without a plaintext inbox", async (t) => {
  const { db, env, app } = await fixture(t);
  const cloudEnv = {
    ...env,
    GUIDY_AUTH_MODE: "resend-test",
    BETTER_AUTH_URL: "https://guidy-test.example",
    RESEND_API_KEY: "test-only-resend-key",
    GUIDY_EMAIL_FROM: "onboarding@resend.dev",
    GUIDY_EMAIL_TEST_TO: "receiver@example.invalid",
  };
  let otp;
  let deliveries = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    deliveries++;
    otp = JSON.parse(options.body).text.match(/\b\d{6}\b/)[0];
    return globalThis.Response.json({ id: "test-message-id" });
  });
  const request = (path, body, cookie = "") =>
    app.fetch(
      new globalThis.Request(cloudEnv.BETTER_AUTH_URL + path, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "expo-origin": "guidy://",
          "CF-Connecting-IP": "192.0.2.7",
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      cloudEnv,
    );
  assert.equal(
    (
      await request("/api/auth/email-otp/send-verification-otp", {
        email: "other@example.invalid",
        type: "sign-in",
      })
    ).status,
    403,
  );
  assert.equal(deliveries, 0);
  const sent = await request("/api/auth/email-otp/send-verification-otp", {
    email: cloudEnv.GUIDY_EMAIL_TEST_TO,
    type: "sign-in",
  });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).delivery, "email");
  assert.equal(deliveries, 1);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM dev_auth_inbox").first()).n,
    0,
  );
  const signedIn = await request("/api/auth/sign-in/email-otp", {
    email: cloudEnv.GUIDY_EMAIL_TEST_TO,
    otp,
  });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie.includes("__Secure-"));
  assert.equal((await request("/api/v1/me", undefined, cookie)).status, 200);
  assert.equal((await request("/api/auth/sign-out", {}, cookie)).status, 200);
  assert.equal((await request("/api/v1/me", undefined, cookie)).status, 401);
});

test("failed email returns an error, never a delivered state or plaintext mailbox", async (t) => {
  const { db, env, app } = await fixture(t);
  const configured = {
    ...env,
    GUIDY_AUTH_MODE: "resend-test",
    BETTER_AUTH_URL: "https://guidy-test.example",
    RESEND_API_KEY: "test-only-key",
    GUIDY_EMAIL_FROM: "onboarding@resend.dev",
    GUIDY_EMAIL_TEST_TO: "receiver@example.invalid",
  };
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new globalThis.Response("private-provider-key-and-address", {
        status: 403,
      }),
  );
  const response = await app.fetch(
    new globalThis.Request(
      configured.BETTER_AUTH_URL + "/api/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "expo-origin": "guidy://",
        },
        body: JSON.stringify({
          email: configured.GUIDY_EMAIL_TEST_TO,
          type: "sign-in",
        }),
      },
    ),
    configured,
  );
  assert.equal(response.status, 502);
  const result = await response.text();
  assert.ok(result.includes("OTP_DELIVERY_FAILED"));
  assert.ok(!result.includes("private-provider"));
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM dev_auth_inbox").first()).n,
    0,
  );
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM "user"').first()).n,
    0,
  );
  assert.throws(() =>
    createAuth({ ...configured, GUIDY_EMAIL_TEST_TO: undefined }),
  );
  assert.throws(() => createAuth({ ...configured, GUIDY_AUTH_MODE: "resend" }));
});

test("auth guards, origin rejection, rate limits and actual plugin schema", async (t) => {
  const { db, env, request } = await fixture(t);
  const migrations = await getMigrations(createAuth(env).options);
  assert.equal(migrations.toBeCreated.length, 0);
  assert.equal(migrations.toBeAdded.length, 0);
  assert.equal(migrations.toBeAddedIndexes.length, 0);
  assert.equal(
    (
      await request(
        "/api/auth/email-otp/send-verification-otp",
        { email: "x@example.invalid", type: "sign-in" },
        "",
        { Origin: "https://evil.invalid" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/auth/email-otp/send-verification-otp", {
        email: "x@example.invalid",
        type: "forget-password",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/auth/sign-in/email-otp", { extra: "a".repeat(5000) }))
      .status,
    413,
  );
  assert.equal((await request("/api/auth/get-verification-otp")).status, 404);
  // Isolate the send limit from the rejected origin request, which also counts.
  await db.prepare('DELETE FROM "rateLimit"').run();
  assert.equal(
    (
      await request(
        "/api/auth/email-otp/send-verification-otp",
        {
          email: "x@example.invalid",
          type: "sign-in",
        },
        "",
        { "CF-Connecting-IP": "192.0.2.2" },
      )
    ).status,
    200,
  );
  for (let index = 0; index < 2; index++)
    assert.equal(
      (
        await request(
          "/api/auth/email-otp/send-verification-otp",
          {
            email: "x@example.invalid",
            type: "sign-in",
          },
          "",
          { "CF-Connecting-IP": "192.0.2.2" },
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await request(
        "/api/auth/email-otp/send-verification-otp",
        {
          email: "x@example.invalid",
          type: "sign-in",
        },
        "",
        { "CF-Connecting-IP": "192.0.2.2" },
      )
    ).status,
    429,
  );
  const disabled = createApp({ logger: () => {} });
  assert.equal(
    (
      await disabled.fetch(
        new globalThis.Request("https://public.example/api/auth/get-session"),
        env,
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await disabled.fetch(
        new globalThis.Request("http://127.0.0.1:8787/api/auth/get-session"),
        { ...env, BETTER_AUTH_SECRET: undefined },
      )
    ).status,
    503,
  );
  assert.ok(
    (await db.prepare('SELECT COUNT(*) AS n FROM "rateLimit"').first()).n > 0,
  );
});
