import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { getMigrations } from "better-auth/db/migration";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

async function sandbox(t) {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("test"); } };',
      compatibilityDate: "2026-10-09",
      d1Databases: { DEV: "dev-test-only", TEST: "test-only" },
      d1Persist: false,
    }),
  );
  t.after(() => runtime.dispose());
  const dev = await runtime.getD1Database("DEV");
  const db = await runtime.getD1Database("TEST");
  for (const database of [dev, db]) {
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((s) => s.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(
        new URL("../migrations/" + name, import.meta.url),
        "utf8",
      );
      // These immutable files contain DDL only; each complete statement ends with semicolon.
      const queries = sql
        .replace(/^[ \t]*--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      await database.batch(queries.map((query) => database.prepare(query)));
    }
  }
  return { db, dev };
}

async function owner(db, id = "test-user-a") {
  await db
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 0, ?, ?)',
    )
    .bind(id, "Test user", `${id}@example.invalid`, 1000, 1000)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles (user_id, created_at, updated_at) VALUES (?, ?, ?)",
    )
    .bind(id, 1000, 1000)
    .run();
  return id;
}
function insertGoal(db, id, user, title = "Test goal") {
  return db
    .prepare(
      "INSERT INTO goals (id,owner_id,title,created_at,updated_at) VALUES (?,?,?,1000,1000)",
    )
    .bind(id, user, title)
    .run();
}

test("D1 auth schema matches the locked library and scoped goal tables exist", async (t) => {
  const { db } = await sandbox(t);
  const migration = await getMigrations({
    database: db,
    logger: { disabled: true },
  });
  assert.equal(migration.toBeCreated.length, 0);
  assert.equal(migration.toBeAdded.length, 0);
  assert.equal(migration.toBeAddedIndexes.length, 0);
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all()
  ).results;
  assert.deepEqual(
    tables.map((row) => row.name),
    [
      "account",
      "agent_jobs",
      "agent_messages",
      "agent_runs",
      "calendar_event_receipts",
      "calendar_events",
      "calendar_states",
      "chat_condition_captures",
      "conversation_turns",
      "dev_auth_inbox",
      "goal_active_plans",
      "goal_mutations",
      "goal_slots",
      "goals",
      "plan_draft_attempts",
      "plan_draft_reviews",
      "plan_draft_usage",
      "plan_versions",
      "planning_jobs",
      "profiles",
      "rateLimit",
      "research_evidence",
      "research_job_items",
      "scheduled_occurrences",
      "search_attempts",
      "search_usage",
      "session",
      "tasks",
      "user",
      "verification",
    ],
  );
});

test("valid profiles/goals defaults and owner index work on D1", async (t) => {
  const { db } = await sandbox(t);
  const user = await owner(db);
  const id = globalThis.crypto.randomUUID();
  await insertGoal(db, id, user);
  const profile = await db
    .prepare("SELECT * FROM profiles WHERE user_id=?")
    .bind(user)
    .first();
  assert.equal(profile.timezone, "Asia/Shanghai");
  assert.equal(profile.locale, "zh-CN");
  const goal = await db
    .prepare("SELECT * FROM goals WHERE id=? AND owner_id=?")
    .bind(id, user)
    .first();
  assert.equal(goal.status, "draft");
  assert.equal(goal.revision, 0);
  assert.equal(goal.active_plan_version_id, null);
  const indexes = (await db.prepare("PRAGMA index_list('goals')").all())
    .results;
  assert.ok(
    indexes.some((row) => row.name === "idx_goals_owner_status_updated"),
  );
});

test("missing identity and profile owners are rejected by real foreign keys", async (t) => {
  const { db } = await sandbox(t);
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO profiles (user_id,created_at,updated_at) VALUES (?,1000,1000)",
      )
      .bind("missing-user")
      .run(),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    insertGoal(db, globalThis.crypto.randomUUID(), "missing-profile"),
    /FOREIGN KEY/,
  );
});

test("invalid title, UUID, state, revision, timestamps and plan pointer are rejected", async (t) => {
  const { db } = await sandbox(t);
  const user = await owner(db);
  const id = globalThis.crypto.randomUUID();
  await assert.rejects(insertGoal(db, "not-a-uuid", user), /CHECK/);
  for (const title of ["", "  ", "x".repeat(201)])
    await assert.rejects(insertGoal(db, id, user, title), /CHECK/);
  await insertGoal(db, id, user);
  for (const [field, value] of [
    ["status", "invented"],
    ["revision", -1],
    ["revision", 1.5],
    ["created_at", -1],
    ["updated_at", 999],
    ["deadline_at", -1],
    ["active_plan_version_id", globalThis.crypto.randomUUID()],
  ]) {
    await assert.rejects(
      db
        .prepare(`UPDATE goals SET ${field}=? WHERE id=?`)
        .bind(value, id)
        .run(),
      /CHECK|DATATYPE/,
    );
  }
  assert.equal(
    (await db.prepare("SELECT revision FROM goals WHERE id=?").bind(id).first())
      .revision,
    0,
  );
});

test("D1 batch failure rolls back an earlier valid write", async (t) => {
  const { db } = await sandbox(t);
  const user = await owner(db);
  const id = globalThis.crypto.randomUUID();
  await assert.rejects(
    db.batch([
      db
        .prepare(
          "INSERT INTO goals (id,owner_id,title,created_at,updated_at) VALUES (?,?,?,1000,1000)",
        )
        .bind(id, user, "Test goal"),
      db.prepare("UPDATE goals SET revision=-1 WHERE id=?").bind(id),
    ]),
    /CHECK/,
  );
  assert.equal(
    await db.prepare("SELECT id FROM goals WHERE id=?").bind(id).first(),
    null,
  );
});

test("duplicate IDs cannot overwrite data and owner deletion cascades consistently", async (t) => {
  const { db } = await sandbox(t);
  const user = await owner(db);
  const id = globalThis.crypto.randomUUID();
  await insertGoal(db, id, user);
  await assert.rejects(insertGoal(db, id, user, "Other goal"), /UNIQUE/);
  assert.equal(
    (await db.prepare("SELECT title FROM goals WHERE id=?").bind(id).first())
      .title,
    "Test goal",
  );
  await db.prepare('DELETE FROM "user" WHERE id=?').bind(user).run();
  assert.equal(
    await db
      .prepare("SELECT user_id FROM profiles WHERE user_id=?")
      .bind(user)
      .first(),
    null,
  );
  assert.equal(
    await db.prepare("SELECT id FROM goals WHERE id=?").bind(id).first(),
    null,
  );
});

test("development and test D1 bindings are isolated", async (t) => {
  const { db, dev } = await sandbox(t);
  const user = await owner(dev);
  const id = globalThis.crypto.randomUUID();
  await insertGoal(dev, id, user);
  assert.ok(
    await dev.prepare("SELECT id FROM goals WHERE id=?").bind(id).first(),
  );
  assert.equal(
    await db.prepare("SELECT id FROM goals WHERE id=?").bind(id).first(),
    null,
  );
  assert.equal(
    await db.prepare('SELECT id FROM "user" WHERE id=?').bind(user).first(),
    null,
  );
});
