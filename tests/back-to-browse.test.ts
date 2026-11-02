import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { backToBrowse } from "../src/x/back-to-browse.ts";
import { beginAction, stopActions } from "../src/x/action-control.ts";

const tweetId = "2112057695247180195", post = `https://x.com/alice/status/${tweetId}`, list = "https://x.com/i/lists/1234567890";
function setup(t: TestContext, initial = post, destinations: string[] = [], arrow = true) {
  const { document, window } = parseHTML(`<main>${arrow ? '<button data-testid="app-bar-back">Back</button>' : ''}</main>`);
  const location = { href: initial, pathname: new URL(initial).pathname, assign() { throw new Error("must not reopen a URL"); } };
  for (const [key, value] of Object.entries({ document, window, location, HTMLElement: window.HTMLElement })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : Reflect.deleteProperty(globalThis, key));
  }
  let clicks = 0, clock = 1900000000000;
  document.querySelector("button")?.addEventListener("click", () => {
    clicks++;
    location.href = destinations.shift() || location.href;
    location.pathname = new URL(location.href).pathname;
  });
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms = 0) => { queueMicrotask(() => { clock += ms; fn(); }); return 1 as unknown as NodeJS.Timeout; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  beginAction(); t.after(stopActions);
  return { clicks: () => clicks, location };
}

for (const surface of ["home", "following", "lists", "mentions"] as const) test(`click the X arrow back to the originating ${surface}`, async t => {
  const url = surface === "lists" ? list : surface === "mentions" ? "https://x.com/notifications" : "https://x.com/home";
  const env = setup(t, post, [url]);
  assert.deepEqual(await backToBrowse({ surface, tweetId, listUrl: list }), { ok: true, detail: "browse_back_done" });
  assert.equal(env.clicks(), 1);
});

test("already on the source stays put without clicking its URL or the arrow", async t => {
  const env = setup(t, list);
  assert.equal((await backToBrowse({ surface: "lists", listUrl: list, tweetId })).detail, "browse_back_already");
  assert.equal(env.clicks(), 0);
});

test("Follow uses the same arrow from profile to post and then back to its feed", async t => {
  const env = setup(t, "https://x.com/alice", [post, "https://x.com/home"]);
  assert.equal((await backToBrowse({ surface: "home", tweetId, followedProfile: "alice" })).ok, true);
  assert.equal(env.clicks(), 2);
});

test("a missing arrow does not reopen the source URL", async t => {
  const env = setup(t, post, [], false);
  assert.equal((await backToBrowse({ surface: "home", tweetId })).error, "back_arrow_missing");
  assert.equal(env.clicks(), 0);
});

test("an ineffective arrow is clicked once without a URL fallback", async t => {
  const env = setup(t);
  assert.equal((await backToBrowse({ surface: "home", tweetId })).error, "back_not_at_source");
  assert.equal(env.clicks(), 1);
  assert.equal(env.location.href, post);
});

test("Back stops after an unexpected destination rather than clicking through unrelated pages", async t => {
  const env = setup(t, "https://x.com/alice", ["https://x.com/bob", list]);
  assert.equal((await backToBrowse({ surface: "lists", listUrl: list, tweetId, followedProfile: "alice" })).error, "back_not_at_source");
  assert.equal(env.clicks(), 1);
});

test("Stop prevents the arrow click", async t => {
  const env = setup(t, post, [list]); stopActions();
  await assert.rejects(backToBrowse({ surface: "lists", listUrl: list, tweetId }), /stopped/);
  assert.equal(env.clicks(), 0);
});
