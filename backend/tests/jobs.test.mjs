import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import ts from "typescript";
import {
  jobResponse,
  startJob,
  processSource,
  finishJob,
} from "../src/research/jobs.ts";
async function fixture(t, workflow = false) {
  const options = {
    name: "guidy-jobs-test",
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-10-09",
    d1Databases: ["DB"],
    d1Persist: false,
  };
  let calls = 0;
  if (workflow) {
    const modules = [
      {
        type: "ESModule",
        path: "/test/entry.js",
        contents: `export {ResearchWorkflow} from './workflow.js'; export default {async fetch(req,env){const id=new URL(req.url).searchParams.get('id');if(req.method==='POST'){await env.RESEARCH_WORKFLOW.create({id,params:{jobId:id}});return Response.json({ok:true});}return Response.json(await (await env.RESEARCH_WORKFLOW.get(id)).status());}}`,
      },
    ];
    for (const name of ["provider", "jobs", "workflow"]) {
      const source = await readFile(
        new URL("../src/research/" + name + ".ts", import.meta.url),
        "utf8",
      );
      const compiled = ts
        .transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        })
        .outputText.replaceAll("./provider.ts", "./provider.js")
        .replaceAll("./jobs.ts", "./jobs.js");
      modules.push({
        type: "ESModule",
        path: "/test/" + name + ".js",
        contents: compiled,
      });
    }
    options.modules = true;
    const compiledParts = modules
      .slice(1)
      .map((module) =>
        module.contents.replace(
          /import\s*\{[^}]*\}\s*from\s*["']\.\/(?:provider|jobs)\.js["'];?\s*/g,
          "",
        ),
      );
    options.script =
      compiledParts.join("\n") +
      modules[0].contents.replace(
        "export {ResearchWorkflow} from './workflow.js';",
        "",
      );
    options.workflows = {
      RESEARCH_WORKFLOW: {
        name: "guidy-workflow-test",
        className: "ResearchWorkflow",
      },
    };
    options.workflowExports = {
      ResearchWorkflow: { name: "guidy-workflow-test" },
    };
    options.outboundService = async () => {
      calls++;
      return new globalThis.Response(
        "<title>Fixture</title><main>Untrusted public source fixture</main>",
        { headers: { "Content-Type": "text/html" } },
      );
    };
  }
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const queries = (
      await readFile(new URL("../migrations/" + name, import.meta.url), "utf8")
    )
      .replace(/^[ \t]*--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(queries.map((q) => db.prepare(q)));
  }
  const owner = "job-test-owner";
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
    )
    .bind(owner, "Test", "job@example.invalid")
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,1,1)",
    )
    .bind(owner)
    .run();
  const goal = globalThis.crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO goals(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,1,1)",
    )
    .bind(goal, owner, "学习英语")
    .run();
  const evidence = globalThis.crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO research_evidence(id,goal_id,owner_id,request_key,request_payload,goal_revision,source_url,claim,caveat,status,created_at,lease_until) VALUES(?,?,?,'fixture-source','{}',0,'https://www.nhs.uk/','待核对问题','','failed',1,1)",
    )
    .bind(evidence, goal, owner)
    .run();
  return { runtime, db, owner, goal, evidence, calls: () => calls };
}
const binding = () => ({
  create: async () => {},
  get: async () => ({ status: async () => ({ status: "running" }) }),
});
test("job claim rejects duplicate selection, concurrent jobs and daily quota without creating extra items", async (t) => {
  const f = await fixture(t);
  const body = { evidence_ids: [f.evidence], expected_revision: 0 };
  assert.equal(
    (
      await jobResponse(
        request(f.goal, { ...body, evidence_ids: [f.evidence, f.evidence] }),
        f.db,
        f.owner,
        "test",
        binding(),
      )
    ).status,
    422,
  );
  const results = await Promise.all(
    ["concurrent-job-one", "concurrent-job-two"].map((key) =>
      jobResponse(request(f.goal, body, key), f.db, f.owner, "test", binding()),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM research_job_items").first())
      .n,
    1,
  );
  const id = (await f.db.prepare("SELECT id FROM agent_jobs").first()).id;
  await startJob(f.db, id);
  await processSource(f.db, id, 0, {
    read: async () => ({ title: "fixture", excerpt: "untrusted" }),
  });
  await finishJob(f.db, id);
  for (let i = 0; i < 2; i++)
    await f.db
      .prepare(
        "INSERT INTO agent_jobs(id,goal_id,owner_id,request_key,request_payload,goal_revision,status,created_at,updated_at) VALUES(?,?,?,?,'{}',0,'failed',?,?)",
      )
      .bind(
        globalThis.crypto.randomUUID(),
        f.goal,
        f.owner,
        "quota-" + i,
        Date.now(),
        Date.now(),
      )
      .run();
  assert.equal(
    (
      await jobResponse(
        request(f.goal, body, "quota-request-key"),
        f.db,
        f.owner,
        "test",
        binding(),
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM agent_jobs").first()).n,
    3,
  );
});
function request(goal, body, key = "job-idempotency-key") {
  return new globalThis.Request(
    "https://test.invalid/api/v1/goals/" + goal + "/research-runs",
    {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}
test("job dispatch failure survives reload and resumes the same durable instance", async (t) => {
  const f = await fixture(t);
  const broken = {
    create: async () => {
      throw new Error("private token");
    },
    get: async () => {
      throw new Error("private token");
    },
  };
  const body = { evidence_ids: [f.evidence], expected_revision: 0 };
  const response = await jobResponse(
    request(f.goal, body),
    f.db,
    f.owner,
    "test",
    broken,
  );
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private token"));
  const state = (
    await (
      await jobResponse(request(f.goal), f.db, f.owner, "test", broken)
    ).json()
  ).data.jobs[0];
  assert.equal(state.dispatched, 0);
  let created;
  const live = binding();
  live.create = async (options) => {
    created = options.id;
  };
  assert.equal(
    (
      await jobResponse(
        request(f.goal, { resume_job_id: state.id }),
        f.db,
        f.owner,
        "test",
        live,
      )
    ).status,
    202,
  );
  assert.equal(created, state.id);
  assert.equal(
    (await jobResponse(request(f.goal, body), f.db, f.owner, "test", live))
      .status,
    200,
  );
  assert.equal(
    (
      await jobResponse(
        request(f.goal, { ...body, expected_revision: 1 }),
        f.db,
        f.owner,
        "test",
        live,
      )
    ).status,
    409,
  );
  assert.equal(
    (await jobResponse(request(f.goal), f.db, "other-owner", "test", live))
      .status,
    404,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM agent_jobs").first()).n,
    1,
  );
});
test("checkpoint, lease and stale-version guards preserve finished items without repeat reads", async (t) => {
  const f = await fixture(t);
  const result = await jobResponse(
    request(f.goal, { evidence_ids: [f.evidence], expected_revision: 0 }),
    f.db,
    f.owner,
    "test",
    binding(),
  );
  const id = (await result.json()).data.jobs[0].id;
  assert.deepEqual(await startJob(f.db, id), [0]);
  let reads = 0;
  const provider = {
    read: async () => {
      reads++;
      return { title: "Fixture", excerpt: "untrusted" };
    },
  };
  await processSource(f.db, id, 0, provider);
  await processSource(f.db, id, 0, provider);
  assert.equal(reads, 1);
  await assert.rejects(
    f.db
      .prepare("UPDATE research_job_items SET retrieved_at=NULL WHERE job_id=?")
      .bind(id)
      .run(),
  );
  await finishJob(f.db, id);
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM agent_jobs WHERE id=?")
        .bind(id)
        .first()
    ).status,
    "completed",
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT revision FROM goals WHERE id=?")
        .bind(f.goal)
        .first()
    ).revision,
    0,
  );
  await f.db.prepare("DELETE FROM goals WHERE id=?").bind(f.goal).run();
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM research_job_items").first())
      .n,
    0,
  );
});
test("platform failure becomes a safe terminal job and closes pending item state without restarting", async (t) => {
  const f = await fixture(t);
  const b = binding();
  const result = await jobResponse(
    request(f.goal, { evidence_ids: [f.evidence], expected_revision: 0 }),
    f.db,
    f.owner,
    "test",
    b,
  );
  const id = (await result.json()).data.jobs[0].id;
  b.get = async () => ({
    status: async () => ({
      status: "errored",
      error: "private provider error",
    }),
  });
  const state = (
    await (await jobResponse(request(f.goal), f.db, f.owner, "test", b)).json()
  ).data.jobs[0];
  assert.equal(state.status, "failed");
  assert.equal(state.items[0].status, "failed");
  assert.equal(state.error_code, "WORKFLOW_FAILED");
  assert.ok(!JSON.stringify(state).includes("private provider error"));
  assert.equal(
    (
      await jobResponse(
        request(f.goal, { resume_job_id: id }),
        f.db,
        f.owner,
        "test",
        b,
      )
    ).status,
    409,
  );
});
test("interrupted claim reclaims after lease; changed goal prevents storing an in-flight result", async (t) => {
  const f = await fixture(t);
  const result = await jobResponse(
    request(f.goal, { evidence_ids: [f.evidence], expected_revision: 0 }),
    f.db,
    f.owner,
    "test",
    binding(),
  );
  const id = (await result.json()).data.jobs[0].id;
  await startJob(f.db, id);
  await f.db
    .prepare(
      "UPDATE research_job_items SET status='reading',lease_until=0,attempts=1 WHERE job_id=?",
    )
    .bind(id)
    .run();
  let release, enter;
  const gate = new Promise((r) => (release = r));
  const entered = new Promise((r) => (enter = r));
  const pending = processSource(f.db, id, 0, {
    read: async () => {
      enter();
      await gate;
      return { title: "stale", excerpt: "stale" };
    },
  });
  await entered;
  await assert.rejects(
    processSource(f.db, id, 0, {
      read: async () => {
        assert.fail("duplicate read");
      },
    }),
  );
  await f.db
    .prepare("UPDATE goals SET revision=1 WHERE id=?")
    .bind(f.goal)
    .run();
  release();
  await pending;
  await finishJob(f.db, id);
  const item = await f.db
    .prepare(
      "SELECT status,excerpt,attempts FROM research_job_items WHERE job_id=?",
    )
    .bind(id)
    .first();
  assert.equal(item.status, "failed");
  assert.equal(item.excerpt, "");
  assert.equal(item.attempts, 2);
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM agent_jobs WHERE id=?")
        .bind(id)
        .first()
    ).status,
    "failed",
  );
});
test("real Workers Workflow executes and persists source checkpoints after HTTP submission", async (t) => {
  const f = await fixture(t, true);
  const b = {
    create: async (options) => {
      const res = await f.runtime.dispatchFetch(
        "http://localhost/?id=" + options.id,
        { method: "POST" },
      );
      assert.equal(res.status, 200);
    },
    get: async (id) => ({
      status: async () =>
        await (
          await f.runtime.dispatchFetch("http://localhost/?id=" + id)
        ).json(),
    }),
  };
  const result = await jobResponse(
    request(f.goal, { evidence_ids: [f.evidence], expected_revision: 0 }),
    f.db,
    f.owner,
    "test",
    b,
  );
  assert.equal(result.status, 202);
  const id = (await result.json()).data.jobs[0].id;
  let status;
  for (let i = 0; i < 80; i++) {
    status = (
      await f.db
        .prepare("SELECT status FROM agent_jobs WHERE id=?")
        .bind(id)
        .first()
    ).status;
    if (["completed", "failed"].includes(status)) break;
    await new Promise((r) => globalThis.setTimeout(r, 100));
  }
  assert.equal(status, "completed");
  assert.equal(f.calls(), 1);
  assert.equal(
    (
      await f.db
        .prepare("SELECT status FROM research_job_items WHERE job_id=?")
        .bind(id)
        .first()
    ).status,
    "available",
  );
  await processSource(f.db, id, 0, {
    read: async () => assert.fail("completed work repeated"),
  });
  assert.equal(f.calls(), 1);
});
