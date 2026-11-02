import assert from "node:assert/strict";
import test from "node:test";
import { postPogoFollowCheck } from "../src/api/follow-check-client.ts";

test("postPogoFollowCheck parses success body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        checked: true,
        unlocked_count: 1,
        awarded_count: 0,
        awarded_points: 0,
        unlocked_points: 10,
        target_followed: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const r = await postPogoFollowCheck("fake-jwt");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.checked, true);
    assert.equal(r.targetFollowed, true);
    assert.equal(r.unlockedCount, 1);
    assert.equal(r.unlockedPoints, 10);
  } finally {
    globalThis.fetch = original;
  }
});

test("postPogoFollowCheck sends POST with empty body + Bearer", async () => {
  const original = globalThis.fetch;
  let method = "";
  let auth = "";
  let body: BodyInit | null | undefined = "unset";
  globalThis.fetch = (async (_url, init) => {
    method = String(init?.method ?? "");
    auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    body = init?.body as BodyInit | null | undefined;
    return new Response(
      JSON.stringify({
        checked: true,
        unlocked_count: 0,
        awarded_count: 0,
        awarded_points: 0,
        unlocked_points: 0,
        target_followed: null,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const r = await postPogoFollowCheck("abc.token");
    assert.equal(r.ok, true);
    assert.equal(method, "POST");
    assert.equal(auth, "Bearer abc.token");
    assert.ok(body === null || body === undefined);
    if (r.ok) assert.equal(r.targetFollowed, null);
  } finally {
    globalThis.fetch = original;
  }
});
