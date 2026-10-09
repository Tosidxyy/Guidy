import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";

test("local migration wrapper rejects remote flags and unknown targets before spawning Wrangler", () => {
  const script = fileURLToPath(
    new URL("../scripts/local-db.mjs", import.meta.url),
  );
  for (const args of [
    ["migrate", "production"],
    ["migrate", "dev", "--remote"],
    ["execute", "test"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remote operations are not supported/);
  }
});
