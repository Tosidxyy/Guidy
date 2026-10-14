import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const [target, ...extra] = process.argv.slice(2);
if (!["dev", "test", "cloud"].includes(target) || extra.length)
  throw new Error("Use plan-reset-audit.mjs dev|test|cloud");
const cloud = target === "cloud";
const config = cloud
  ? "wrangler.cloud.json"
  : `wrangler.${target === "dev" ? "local" : "test"}.jsonc`;
const database = cloud ? "guidy-development" : `guidy-local-${target}`;
if (cloud) {
  const conf = JSON.parse(
    readFileSync(new URL("../wrangler.cloud.json", import.meta.url), "utf8"),
  );
  if (
    conf.account_id !== "8ea47eed8a010eb55b3d512e14657497" ||
    conf.d1_databases?.length !== 1 ||
    conf.d1_databases[0].database_id !==
      "6c77640e-763f-46d7-ac5a-ae383cf540e5" ||
    conf.d1_databases[0].database_name !== database ||
    conf.vars.GUIDY_ENVIRONMENT !== "development"
  )
    throw new Error("Development audit target changed");
}
const queries = readFileSync(
  new URL("./plan-reset-audit.sql", import.meta.url),
  "utf8",
)
  .replace(/^[ \t]*--.*$/gm, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
const counts = {};
// D1 bounds statements per request. Arguments are passed directly, never through a shell.
for (let index = 0; index < queries.length; index += 5) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
      ),
      "d1",
      "execute",
      database,
      "--config",
      config,
      cloud ? "--remote" : "--local",
      ...(!cloud ? ["--persist-to", `.wrangler/state/${target}`] : []),
      "--command",
      queries.slice(index, index + 5).join(";"),
      "--json",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (result.status !== 0)
    throw new Error("Aggregate audit failed; no deletion executed");
  for (const response of JSON.parse(result.stdout)) {
    if (!response.success) throw new Error("Aggregate audit failed");
    for (const row of response.results) counts[row.category] = row.total;
  }
}
process.stdout.write(
  JSON.stringify({ target, cutoff: "2026-10-14T11:47:50Z", counts }) + "\n",
);
