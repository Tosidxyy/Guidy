import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const [email, ...extra] = process.argv.slice(2);
if (
  !email ||
  extra.length ||
  email.length > 254 ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
) {
  throw new Error("Use npm run auth:inbox -- your-email; local dev only");
}
const escaped = email.toLowerCase().replaceAll("'", "''");
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    ),
    "d1",
    "execute",
    "guidy-local-dev",
    "--config",
    "wrangler.local.jsonc",
    "--local",
    "--persist-to",
    ".wrangler/state/dev",
    "--json",
    "--command",
    `SELECT otp,expires_at FROM dev_auth_inbox WHERE email='${escaped}' AND expires_at>${Date.now()}`,
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  },
);
if (result.status !== 0)
  throw new Error("Local inbox unavailable; apply local migrations first");
const row = JSON.parse(result.stdout)[0]?.results?.[0];
if (!row) console.log("没有未过期验证码，请先在 App 请求验证码。");
else
  console.log(
    `本地开发验证码：${row.otp}（有效至 ${new Date(row.expires_at).toLocaleTimeString()}）。请勿分享或提交此输出。`,
  );
