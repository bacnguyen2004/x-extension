import assert from "node:assert/strict";
import test from "node:test";
import { fetchPogoFeed, extractLinkedAccount } from "../src/api/feed-client.ts";

test("feed resolves viewer from authenticated /api/me, never from task authors", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); urls.push(url);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-token");
    return new Response(JSON.stringify(url.endsWith("/api/me")
      ? { telegram_username: "telegram_person", twitter_link: { twitter_handle: "actual_viewer" } }
      : { campaigns: [{ tweet_id: "2112057695247180169", author_handle: "task_author" }], retweet_power: { used: 4, full: 10, reduced: 10 } }), { status: 200 });
  };
  const result = await fetchPogoFeed("test-token");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.linked_account?.handle, "actual_viewer");
  assert.equal(result.snapshot.retweet_remaining, 6);
  assert.equal(urls.length, 2);
  assert.equal(extractLinkedAccount({ campaigns: [{ author_handle: "task_author" }], telegram_username: "telegram_person" }), null);
});

test("expired identity request prevents accepting a previously readable feed", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => String(input).endsWith("/api/me")
    ? new Response("{}", { status: 401 })
    : new Response('{"campaigns":[]}', { status: 200 });
  const result = await fetchPogoFeed("test-token");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.login_required, true);
});

test("identity outage preserves feed without inventing a viewer", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => {
    if (String(input).endsWith("/api/me")) throw new Error("offline");
    return new Response('{"campaigns":[]}', { status: 200 });
  };
  const result = await fetchPogoFeed("test-token");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.snapshot.linked_account, null);
});
