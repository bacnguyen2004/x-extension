import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { extensionContextAlive, showContextReloadNotice } from "../src/content/extension-context.ts";

test("invalidated context stops being considered usable; reload notice is shown once and never auto reloads", (t) => {
  const { document } = parseHTML("<html><body></body></html>");
  const runtime: { id?: string } = { id: "test-extension" };
  let reloads = 0;
  for (const [key, value] of Object.entries({ document, chrome: { runtime }, location: { reload() { reloads++; } } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  assert.equal(extensionContextAlive(), true);
  delete runtime.id;
  assert.equal(extensionContextAlive(), false);
  Object.defineProperty(runtime, "id", { get() { throw new Error("Extension context invalidated"); } });
  assert.equal(extensionContextAlive(), false);
  showContextReloadNotice(); showContextReloadNotice();
  assert.equal(document.querySelectorAll("#xcc-context-reload").length, 1);
  assert.equal(document.documentElement.dataset.xContentCreator, "reload_required");
  assert.equal(reloads, 0);
  (document.querySelector("#xcc-context-reload") as unknown as HTMLElement).click();
  assert.equal(reloads, 1);
});
