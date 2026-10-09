import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/index.ts";

const id = "f3d9f28d-3d5f-47e9-9ad6-24601aa54930";
const quiet = { logger: () => {} };
const request = (path = "/health", options = {}) =>
  new globalThis.Request("https://api.example" + path, options);
async function envelope(response) {
  const body = await response.json();
  assert.equal(response.headers.get("X-Request-ID"), body.request_id);
  assert.match(body.request_id, /^[0-9a-f-]{36}$/);
  return body;
}

test("health retains the mobile API contract and unique tracking IDs", async () => {
  const app = createApp(quiet);
  const first = await app.fetch(request());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  const data = await envelope(first);
  assert.deepEqual(data.data, {
    status: "ok",
    service: "guidy-api",
    version: "0.1.0",
  });
  assert.equal(data.error, null);
  assert.notEqual(
    data.request_id,
    (await envelope(await app.fetch(request()))).request_id,
  );
});

test("UUIDs are normalized; arbitrary and invalid IDs are replaced", async () => {
  const app = createApp(quiet);
  assert.equal(
    (
      await envelope(
        await app.fetch(
          request("/health", { headers: { "X-Request-ID": id.toUpperCase() } }),
        ),
      )
    ).request_id,
    id,
  );
  for (const value of ["private-secret", "-".repeat(36), "x".repeat(500)]) {
    assert.notEqual(
      (
        await envelope(
          await app.fetch(
            request("/health", { headers: { "X-Request-ID": value } }),
          ),
        )
      ).request_id,
      value,
    );
  }
});

test("404 and 405 have stable envelopes and protocol headers", async () => {
  const app = createApp(quiet);
  const missing = await app.fetch(request("/unknown"));
  assert.equal(missing.status, 404);
  assert.equal((await envelope(missing)).error.code, "NOT_FOUND");
  const wrong = await app.fetch(request("/health", { method: "POST" }));
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("Allow"), "GET");
  assert.equal((await envelope(wrong)).error.code, "METHOD_NOT_ALLOWED");
});

test("unhandled failure cannot reveal exception detail", async () => {
  const app = createApp({
    ...quiet,
    routes: [
      {
        path: "/failure",
        method: "GET",
        handle: () => {
          throw new Error("private-secret");
        },
      },
    ],
  });
  const response = await app.fetch(request("/failure"));
  assert.equal(response.status, 500);
  const body = await envelope(response);
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("logs use the route template and never contain URL/body/header secrets", async () => {
  const logs = [];
  const app = createApp({ logger: (record) => logs.push(record) });
  await app.fetch(
    request("/health?token=private-secret", {
      headers: {
        Authorization: "Bearer private-secret",
        "X-Request-ID": "private-secret",
      },
    }),
  );
  await app.fetch(
    request("/private-secret", { method: "POST", body: "private-secret" }),
  );
  assert.deepEqual(
    logs.map((log) => log.route),
    ["/health", "unmatched"],
  );
  assert.equal(JSON.stringify(logs).includes("secret"), false);
  assert.deepEqual(Object.keys(logs[0]).sort(), [
    "duration_ms",
    "event",
    "method",
    "request_id",
    "route",
    "status_code",
  ]);
});

test("CORS is disabled by default and allows only explicit origin without credentials", async () => {
  const app = createApp(quiet);
  const input = request("/health", {
    headers: { Origin: "http://localhost:8082" },
  });
  assert.equal(
    (await app.fetch(input)).headers.has("Access-Control-Allow-Origin"),
    false,
  );
  const response = await app.fetch(input, {
    GUIDY_CORS_ORIGINS: '["http://localhost:8082"]',
  });
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:8082",
  );
  assert.equal(
    response.headers.get("Access-Control-Expose-Headers"),
    "X-Request-ID",
  );
  assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
  const rejected = await app.fetch(
    request("/health", { headers: { Origin: "https://untrusted.example" } }),
    { GUIDY_CORS_ORIGINS: '["http://localhost:8082"]' },
  );
  assert.equal(rejected.headers.has("Access-Control-Allow-Origin"), false);
});

test("unsafe CORS config fails closed", async () => {
  const app = createApp(quiet);
  for (const origin of [
    "*",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?secret=1",
  ]) {
    const response = await app.fetch(request(), {
      GUIDY_CORS_ORIGINS: JSON.stringify([origin]),
    });
    assert.equal(response.status, 500);
    assert.equal(
      JSON.stringify(await envelope(response)).includes("secret"),
      false,
    );
  }
});

test("preflight permits GET/request ID but rejects writes and unknown headers", async () => {
  const app = createApp(quiet);
  const env = { GUIDY_CORS_ORIGINS: '["http://localhost:8082"]' };
  for (const [method, header, status] of [
    ["GET", "x-request-id", 204],
    ["POST", "x-request-id", 400],
    ["GET", "authorization", 400],
  ]) {
    const response = await app.fetch(
      request("/health", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8082",
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": header,
        },
      }),
      env,
    );
    assert.equal(response.status, status);
    assert.ok(response.headers.get("X-Request-ID"));
  }
});

test("request state is isolated across concurrent requests", async () => {
  const app = createApp(quiet);
  const ids = Array.from({ length: 12 }, () => globalThis.crypto.randomUUID());
  const responses = await Promise.all(
    ids.map((value) =>
      app.fetch(request("/health", { headers: { "X-Request-ID": value } })),
    ),
  );
  const bodies = await Promise.all(responses.map(envelope));
  assert.deepEqual(
    bodies.map((body) => body.request_id),
    ids,
  );
});

test("unconfigured Auth fails closed and framework docs stay unavailable", async () => {
  const app = createApp(quiet);
  assert.equal((await app.fetch(request("/api/v1/me"))).status, 503);
  for (const path of ["/docs", "/openapi.json", "/_test/crash"]) {
    assert.equal((await app.fetch(request(path))).status, 404);
  }
});
