import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { followAuthor } from "../src/x/actions/engage.ts";
import { beginAction, stopActions } from "../src/x/action-control.ts";

const opts = { authorHandle: "writer", tweetId: "12345", tweetUrl: "https://x.com/writer/status/12345", preferInline: true };
function page(t: TestContext, initial: string, confirm = true, author = "writer") {
  const { document, window } = parseHTML(`<html><body><article data-testid="tweet"><a href="/${author}/status/12345">post</a><button data-testid="caret">menu</button></article></body></html>`);
  for (const [key, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, location: { pathname: "/home", href: "https://x.com/home" } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  let clock = 0, clicks = 0, label = initial;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms: number) => {
    clock += ms; queueMicrotask(fn); return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  const caret = document.querySelector("button")!;
  caret.addEventListener("click", () => {
    const old = document.querySelector('[role="menu"]');
    if (old) { old.remove(); return; }
    const menu = document.createElement("div"); menu.setAttribute("role", "menu");
    const item = document.createElement("button"); item.setAttribute("role", "menuitem"); item.textContent = label;
    item.addEventListener("click", () => { clicks++; if (confirm) label = "Unfollow @writer"; menu.remove(); });
    menu.append(item); document.body.append(menu);
  });
  beginAction(); t.after(stopActions);
  return { document, clicks: () => clicks };
}

test("Follow from target post menu verifies Following without navigating or leaving a menu open", async t => {
  const p = page(t, "Follow @writer");
  assert.deepEqual(await followAuthor(opts), { ok: true, detail: "follow_confirmed" });
  assert.equal(p.clicks(), 1);
  assert.equal(p.document.querySelector('[role="menu"]'), null);
  assert.equal(location.pathname, "/home");
});
for (const [label, detail] of [["Unfollow @writer", "already_following"], ["Cancel follow request @writer", "follow_requested"]]) {
  test(`existing state ${detail} never clicks the menu item`, async t => {
    const p = page(t, label);
    assert.deepEqual(await followAuthor(opts), { ok: true, detail });
    assert.equal(p.clicks(), 0);
  });
}
test("uncertain inline submission is not repeated or converted into profile fallback", async t => {
  const p = page(t, "Follow @writer", false);
  const result = await followAuthor(opts);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "follow_not_confirmed");
  assert.equal(p.clicks(), 1);
});
test("a different username in the menu is never followed and safely falls back", async t => {
  const p = page(t, "Follow @someone_else");
  assert.deepEqual(await followAuthor(opts), { ok: false, error: "need_navigate_profile", detail: "https://x.com/writer" });
  assert.equal(p.clicks(), 0);
  assert.equal(p.document.querySelector('[role="menu"]'), null);
});
test("a mismatched post author cannot be used to Follow the requested account", async t => {
  const p = page(t, "Follow @writer", true, "someone_else");
  const result = await followAuthor(opts);
  assert.equal(!result.ok && result.error, "need_navigate_profile");
  assert.equal(p.clicks(), 0);
});
test("an existing user menu is left untouched and no inline action is attempted", async t => {
  const p = page(t, "Follow @writer");
  const menu = p.document.createElement("div"); menu.setAttribute("role", "menu"); p.document.body.append(menu);
  await followAuthor(opts);
  assert.equal(p.clicks(), 0); assert.ok(menu.isConnected);
});
test("Stop cancels inline Follow before any click", async t => {
  const p = page(t, "Follow @writer"); stopActions();
  await assert.rejects(followAuthor(opts)); assert.equal(p.clicks(), 0);
});
