import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const [operation, environment, ...extra] = process.argv.slice(2);
if (
  !["migrate", "list"].includes(operation) ||
  !["dev", "test"].includes(environment) ||
  extra.length
) {
  throw new Error(
    "Use local-db.mjs migrate|list dev|test; remote operations are not supported",
  );
}
const config =
  environment === "dev" ? "wrangler.local.jsonc" : "wrangler.test.jsonc";
const database = environment === "dev" ? "guidy-local-dev" : "guidy-local-test";
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    ),
    "d1",
    "migrations",
    operation === "migrate" ? "apply" : "list",
    database,
    "--config",
    config,
    "--local",
    "--persist-to",
    `.wrangler/state/${environment}`,
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
