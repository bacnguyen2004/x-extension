import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { replyTweet } from "../src/x/actions/engage.ts";
import { beginAction, stopActions } from "../src/x/action-control.ts";
import { readReplyAttempt } from "../src/x/reply-history.ts";

function setup(t: TestContext, mode: "confirmed" | "uncertain" | "manual" | "switch" | "configured" | "compact" | "hidden") {
  const id = "2112825901511761984";
  const { document, window } = parseHTML(`<html><body><a data-testid="AppTabBar_Profile_Link" href="/me"></a>
    <article data-testid="tweet"><div data-testid="User-Name"><a href="/author">Author</a></div>
    <a href="/author/status/${id}"><time></time></a><button data-testid="reply"></button></article></body></html>`);
  const disk: Record<string, unknown> = {};
  if (mode === "configured") document.querySelector('[data-testid="AppTabBar_Profile_Link"]')!.remove();
  if (mode === "compact") {
    document.querySelector('[data-testid="AppTabBar_Profile_Link"]')!.remove();
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="SideNav_AccountSwitcher_Button"><div data-testid="UserAvatar-Container-me"></div></button>');
  }
  const globals = { document, window, HTMLElement: window.HTMLElement, InputEvent: window.InputEvent, Event: window.Event,
    location: { href: `https://x.com/author/status/${id}`, pathname: `/author/status/${id}` },
    chrome: { storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); } } } } };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  let clock = 1900000000000, clicks = 0;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms = 0) => { queueMicrotask(() => { clock += ms; fn(); }); return 1 as unknown as NodeJS.Timeout; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  document.querySelector('[data-testid="reply"]')!.addEventListener("click", () => {
    document.body.insertAdjacentHTML("beforeend", `<div role="dialog" aria-modal="true"><div data-testid="tweetTextarea_0" contenteditable="true"></div><button data-testid="tweetButton">Reply</button></div>`);
    document.querySelector('[data-testid="tweetTextarea_0"]')!.addEventListener("input", () => {
      if (mode === "switch") document.querySelector('[data-testid="AppTabBar_Profile_Link"]')!.setAttribute("href", "/other");
      if (mode === "hidden") document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.remove();
      if (mode === "manual" && !document.querySelector("#manual")) document.body.insertAdjacentHTML("beforeend", `<article id="manual" data-testid="tweet"><a href="/author/status/${id}">Replying to</a><div data-testid="User-Name"><a href="/me">Me</a></div><a href="/me/status/2112825901511761999"><time></time></a>Manual reply</article>`);
    });
    document.querySelector('[data-testid="tweetButton"]')!.addEventListener("click", () => {
      clicks++;
      if (mode === "confirmed") document.body.insertAdjacentHTML("beforeend", `<div data-testid="toast">Your post was sent</div>`);
    });
  });
  beginAction(); t.after(() => stopActions());
  return { clicks: () => clicks, post: () => replyTweet({ tweetId: id, tweetUrl: `https://x.com/author/status/${id}`, text: "A reply with enough context.", ...(mode === "configured" ? { ownHandle: "me" } : {}) }), evidence: () => readReplyAttempt(id, "me") };
}

test("a fresh X sent toast confirms the post and prevents another submit", async (t) => {
  const env = setup(t, "confirmed");
  assert.deepEqual(await env.post(), { ok: true, detail: "reply_confirmed" });
  assert.equal((await env.evidence())?.state, "confirmed");
  assert.deepEqual(await env.post(), { ok: true, detail: "already_replied" });
  assert.equal(env.clicks(), 1);
});

test("clicking without an X toast completes submission without waiting or posting twice", async (t) => {
  const env = setup(t, "uncertain");
  const before = Date.now();
  assert.deepEqual(await env.post(), { ok: true, detail: "reply_submitted" });
  assert.ok(Date.now() - before < 4000, "do not wait for X confirmation after submitting");
  assert.equal((await env.evidence())?.state, "submitted");
  assert.deepEqual(await env.post(), { ok: true, detail: "reply_attempt_exists" });
  assert.equal(env.clicks(), 1);
});

test("a manual reply appearing during composition is detected before Post", async (t) => {
  const env = setup(t, "manual");
  assert.deepEqual(await env.post(), { ok: true, detail: "already_replied" });
  assert.equal(env.clicks(), 0);
  assert.equal((await env.evidence())?.state, "confirmed");
});

test("switching accounts during composition prevents sending under the new account", async (t) => {
  const env = setup(t, "switch");
  assert.deepEqual(await env.post(), { ok: false, error: "reply_identity_missing" });
  assert.equal(env.clicks(), 0);
  assert.equal(document.querySelector('[data-testid="tweetTextarea_0"]')?.textContent, "", "unsent agent text must be cleared before any navigation");
});

for (const mode of ["configured", "compact", "hidden"] as const) test(`reply submits when account identity comes from ${mode}`, async t => {
  const env = setup(t, mode);
  assert.deepEqual(await env.post(), { ok: true, detail: "reply_submitted" });
  assert.equal(env.clicks(), 1);
  assert.equal((await env.evidence())?.state, "submitted");
});
