import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

test("cloud origin and exact custom domain share the expected development target", () => {
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.cloud.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(config.routes, [
    { pattern: "api.guidy.fun", custom_domain: true },
  ]);
  assert.equal(config.vars.BETTER_AUTH_URL, "https://api.guidy.fun");
  assert.equal(config.name, "guidy-api-development");
  assert.equal(config.vars.GUIDY_ENVIRONMENT, "development");
  assert.equal(config.vars.GUIDY_AUTH_MODE, "resend");
  assert.equal(config.vars.GUIDY_EMAIL_FROM, "noreply@auth.guidy.fun");
  assert.equal(config.d1_databases[0].database_name, "guidy-development");
});

test("cloud wrapper rejects target overrides and unsupported operations before invoking Wrangler", () => {
  const script = fileURLToPath(
    new URL("../scripts/cloud-dev.mjs", import.meta.url),
  );
  for (const args of [
    [],
    ["production"],
    ["deploy", "--config", "other.json"],
    ["migrate", "--local"],
    ["build", "--remote"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /target overrides are not supported/);
    assert.equal(result.stdout, "");
  }
});
