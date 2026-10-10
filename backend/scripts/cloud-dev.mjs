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
  config.routes?.length !== 1 ||
  config.routes[0].pattern !== "api.guidy.fun" ||
  config.routes[0].custom_domain !== true ||
  config.vars.GUIDY_ENVIRONMENT !== "development" ||
  !["disabled", "resend-test", "resend"].includes(config.vars.GUIDY_AUTH_MODE)
) {
  throw new Error(
    "Cloud development target changed; review configuration before proceeding",
  );
}
if (
  config.vars.GUIDY_AUTH_MODE !== "disabled" &&
  (config.vars.BETTER_AUTH_URL !== "https://api.guidy.fun" ||
    !config.vars.GUIDY_EMAIL_FROM)
)
  throw new Error("Cloud auth origin/sender must be configured");
if (operation === "deploy" && config.vars.GUIDY_AUTH_MODE !== "disabled") {
  const secrets = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
      ),
      "secret",
      "list",
      "--config",
      "wrangler.cloud.json",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (secrets.status !== 0) throw new Error("Cannot verify cloud secret names");
  const names = JSON.parse(secrets.stdout).map((secret) => secret.name);
  const required = [
    "RESEND_API_KEY",
    "BETTER_AUTH_SECRET",
    ...(config.vars.GUIDY_AUTH_MODE === "resend-test"
      ? ["GUIDY_EMAIL_TEST_TO"]
      : []),
  ];
  if (required.some((name) => !names.includes(name)))
    throw new Error(
      "Required cloud secrets are missing; keep auth disabled until configured",
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
