import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { boundedText } from "../src/http/bounded-text.ts";

test("retired manual routes cannot read or mutate data, including old deep links", async () => {
  const app = createApp({ logger: () => {} });
  const goal = "00000000-0000-4000-8000-000000000001";
  for (const route of [
    "slots",
    "evidence",
    "research-runs",
    "search-runs",
    "plan-drafts",
    "draft-reviews",
  ]) {
    for (const method of ["GET", "POST", "PATCH"]) {
      const response = await app.fetch(
        new globalThis.Request(
          `https://api.guidy.fun/api/v1/goals/${goal}/${route}`,
          {
            method,
          },
        ),
        {},
      );
      assert.equal(response.status, 404, `${route} ${method}`);
    }
  }
});

test("bounded body reader measures bytes and cancels excessive streamed input", async () => {
  assert.equal(
    await boundedText(new globalThis.Response("韩语").body, 6),
    "韩语",
  );
  let cancelled = false;
  const stream = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(boundedText(stream, 4), /Body limit/);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  await assert.rejects(boundedText(null, 4), /Empty body/);
});
