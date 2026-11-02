import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { confirmOwnReply, hasReplyAttempt, readReplyAttempt, submitReplyOnce } from "../src/x/reply-history.ts";
import { hasOwnReplyToTweet } from "../src/x/actions/engage.ts";

test("reply reservation survives queue deletion, restart, lost response and account changes", async (t) => {
  const disk: Record<string, unknown> = {};
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: disk[key] }),
    set: async (patch: object) => { Object.assign(disk, patch); },
  } } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "chrome", descriptor) : Reflect.deleteProperty(globalThis, "chrome"));
  let clicks = 0;
  assert.equal(await submitReplyOnce("12345", "@Me", () => { clicks++; return true; }), "submitted");
  // Clearing the visible job queue cannot erase the independent marker.
  disk["agent.queue"] = { jobs: [] };
  assert.equal(await hasReplyAttempt("12345", "me"), true);
  assert.equal(await submitReplyOnce("12345", "ME", () => { clicks++; return true; }), "exists");
  assert.equal(clicks, 1);
  const concurrent = await Promise.all([1, 2, 3].map(() => submitReplyOnce("77777", "me", () => { clicks++; return true; })));
  assert.equal(concurrent.filter((result) => result === "submitted").length, 1);
  assert.equal(clicks, 2);
  assert.equal((await readReplyAttempt("77777", "me"))?.state, "submitted");
  await confirmOwnReply("77777", "me");
  assert.equal((await readReplyAttempt("77777", "me"))?.state, "confirmed");
  assert.equal(await hasReplyAttempt("12345", "other"), false);
  assert.equal(await hasReplyAttempt("99999", "me"), false);
  await assert.rejects(submitReplyOnce("99999", "me", () => { throw new Error("tab closed"); }));
  assert.equal(await submitReplyOnce("99999", "me", () => { clicks++; return true; }), "exists");
  assert.equal(clicks, 2);
});

test("storage failure prevents Post", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async () => ({}), set: async () => { throw new Error("disk full"); },
  } } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "chrome", descriptor) : Reflect.deleteProperty(globalThis, "chrome"));
  let clicked = false;
  await assert.rejects(submitReplyOnce("12345", "me", () => { clicked = true; return true; }));
  assert.equal(clicked, false);
});

test("manual reply uses author identity, not mentions; timestamp takes precedence over parent link", (t) => {
  const { document } = parseHTML(`<html><body>
    <article data-testid="tweet"><a href="/author/status/12345"><time></time></a></article>
    <article data-testid="tweet"><div data-testid="User-Name"><a href="/someone">Someone</a></div>
      <a href="/someone/status/34567"><time></time></a><span>Replying to <a href="/me">@me</a></span></article>
    </body></html>`);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "document", descriptor) : Reflect.deleteProperty(globalThis, "document"));
  assert.equal(hasOwnReplyToTweet("12345", "me"), false);
  document.body.insertAdjacentHTML("beforeend", `<article data-testid="tweet">
    <a href="/author/status/12345">Replying to</a>
    <div data-testid="User-Name"><a href="/Me">Me</a></div>
    <a href="/Me/status/45678"><time></time></a>My manual reply</article>`);
  assert.equal(hasOwnReplyToTweet("12345", "me"), true);
  assert.equal(hasOwnReplyToTweet("12345", "other"), false);
});
