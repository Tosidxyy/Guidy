import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const [operation, ...extra] = process.argv.slice(2);
if (!["build", "migrate", "deploy"].includes(operation) || extra.length) {
  throw new Error(
    "Use cloud-dev.mjs build|migrate|deploy; target overrides are not supported",
  );
}
const config = JSON.parse(
  readFileSync(new URL("../wrangler.cloud.json", import.meta.url), "utf8"),
);
if (
  config.name !== "guidy-api-development" ||
  config.account_id !== "8ea47eed8a010eb55b3d512e14657497" ||
  config.d1_databases?.length !== 1 ||
  config.d1_databases[0].database_name !== "guidy-development" ||
  config.d1_databases[0].database_id !==
    "6c77640e-763f-46d7-ac5a-ae383cf540e5" ||
  config.vars.GUIDY_AUTH_MODE !== "disabled"
) {
  throw new Error(
    "Cloud development target changed; review configuration before proceeding",
  );
}
const args =
  operation === "migrate"
    ? ["d1", "migrations", "apply", "guidy-development", "--remote"]
    : [
        "deploy",
        ...(operation === "build"
          ? ["--dry-run", "--outdir", "dist/cloud"]
          : []),
      ];
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    ),
    ...args,
    "--config",
    "wrangler.cloud.json",
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
