import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { getMigrations } from "better-auth/db/migration";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const target = new URL("../migrations/0001_auth_core.sql", import.meta.url);
const version = JSON.parse(
  await readFile(
    new URL("../node_modules/better-auth/package.json", import.meta.url),
    "utf8",
  ),
).version;
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("schema"); } };',
    compatibilityDate: "2026-10-09",
    d1Databases: ["DB"],
    d1Persist: false,
  }),
);
try {
  const database = await runtime.getD1Database("DB");
  const migration = await getMigrations({
    database,
    logger: { disabled: true },
  });
  const sql = `-- Generated from Better Auth ${version} core schema via getMigrations/compileMigrations.\n-- Immutable after application. Plugin/schema changes require a NEW migration.\n${await migration.compileMigrations()}\n`;
  if (process.argv.includes("--write")) {
    await writeFile(target, sql, { flag: "wx" });
    console.log(`Created auth core migration for Better Auth ${version}`);
  } else {
    assert.equal(
      await readFile(target, "utf8"),
      sql,
      "Locked auth schema drift: add a new migration instead of rewriting an applied one",
    );
    console.log(`PASS: committed auth schema matches Better Auth ${version}`);
  }
} finally {
  await runtime.dispose();
}
