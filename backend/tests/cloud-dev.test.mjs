import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

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
