import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { AUTO_LEAVE_ATTR, AUTO_LEAVE_KEY, armAutoLeave, autoLeaveActive, clearAutoLeave, installLeaveGuard } from "../src/x/auto-leave.ts";
import { cleanupOwnedComposer, dismissDraftConfirmation, watchDraftConfirmations } from "../src/x/draft-confirmation.ts";
import { beginAction, stopActions } from "../src/x/action-control.ts";

function setup(t: TestContext, html = "<html><body></body></html>") {
  const { document, window } = parseHTML(html);
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  for (const [key, value] of Object.entries({ document, sessionStorage: storage, location: { origin: "https://x.com" } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  t.after(() => { delete (window as unknown as { __xccLeaveGuard?: boolean }).__xccLeaveGuard; });
  return { document, window, storage };
}

test("active navigation skips X's beforeunload confirmation and Stop restores it", t => {
  const { document, window, storage } = setup(t);
  installLeaveGuard(window as unknown as Window);
  installLeaveGuard(window as unknown as Window);
  let warnings = 0;
  window.addEventListener("beforeunload", event => { warnings++; event.preventDefault(); });
  armAutoLeave(Date.now() + 45000);
  assert.equal(autoLeaveActive(document, storage), true);
  window.dispatchEvent(new window.Event("beforeunload", { cancelable: true }));
  assert.equal(warnings, 0);
  clearAutoLeave();
  window.dispatchEvent(new window.Event("beforeunload", { cancelable: true }));
  assert.equal(warnings, 1);
});

test("navigation permission survives reload but expires and ignores malformed leases", t => {
  const { document, storage } = setup(t);
  let now = 1000; t.mock.method(Date, "now", () => now);
  armAutoLeave(now + 45000);
  const reloaded = parseHTML("<html><body></body></html>").document;
  assert.equal(autoLeaveActive(reloaded, storage), true);
  now += 20 * 60000;
  assert.equal(autoLeaveActive(document, storage), false);
  document.documentElement.removeAttribute(AUTO_LEAVE_ATTR);
  for (const value of ["NaN", "Infinity", String(now + 86400000)]) {
    storage.setItem(AUTO_LEAVE_KEY, value);
    assert.equal(autoLeaveActive(document, storage), false);
  }
});

test("draft confirmation chooses Discard and never Save or unrelated confirmation buttons", t => {
  const { document } = setup(t, '<html><body><div role="dialog"><h2>Save draft?</h2><button id="save">Save</button><button id="discard">Discard</button></div></body></html>');
  const clicked: string[] = [];
  for (const button of document.querySelectorAll("button")) button.addEventListener("click", () => clicked.push(button.id));
  assert.equal(dismissDraftConfirmation(document), true);
  assert.deepEqual(clicked, ["discard"]);
  document.body.innerHTML = '<div role="dialog"><h2>Delete this post?</h2><button data-testid="confirmationSheetConfirm">Delete</button></div>';
  assert.equal(dismissDraftConfirmation(document), false);
  document.body.innerHTML = '<div role="dialog"><h2>Save draft?</h2><button>Save</button><button>Cancel</button></div>';
  assert.equal(dismissDraftConfirmation(document), false);
});

test("owned composer is cleaned even after cancellation and the discard sheet is handled", t => {
  const { document } = setup(t, '<html><body><div role="dialog" id="composer"><div contenteditable="true">Agent text</div><button data-testid="app-bar-close">Close</button></div></body></html>');
  const box = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
  let discarded = 0;
  document.querySelector("button")!.addEventListener("click", () => {
    document.body.insertAdjacentHTML("beforeend", '<div role="alertdialog"><h2>Lưu bản nháp?</h2><button id="discard">Không lưu</button></div>');
    document.querySelector("#discard")!.addEventListener("click", () => { discarded++; });
  });
  beginAction(); stopActions();
  assert.equal(cleanupOwnedComposer(box, "Agent text", document), true);
  assert.equal(box.textContent, ""); assert.equal(discarded, 1);
});

test("cleanup preserves text that a person changed during an action", t => {
  const { document } = setup(t, '<html><body><div contenteditable="true">My manual edit</div></body></html>');
  const box = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
  assert.equal(cleanupOwnedComposer(box, "Original agent text", document), false);
  assert.equal(box.textContent, "My manual edit");
});

test("late draft sheets are dismissed only during an active automation lease", async t => {
  const { document, window } = setup(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: window.MutationObserver });
  t.after(() => original ? Object.defineProperty(globalThis, "MutationObserver", original) : Reflect.deleteProperty(globalThis, "MutationObserver"));
  watchDraftConfirmations(document);
  let discarded = 0;
  const insert = () => {
    document.body.innerHTML = '<div role="alertdialog"><h2>Discard unsent post?</h2><button>Discard</button></div>';
    document.querySelector("button")!.addEventListener("click", () => { discarded++; });
  };
  armAutoLeave(Date.now() + 45000); insert();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(discarded, 1);
  clearAutoLeave(); insert();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(discarded, 1);
});
