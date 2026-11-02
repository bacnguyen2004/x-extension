import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { initUnfollowPanel } from "../src/sidepanel/unfollow-panel.ts";
import { createDefaultUnfollowSettings } from "../src/domain/unfollow-settings.ts";

test("unfollow panel explains conflicting tick rules and the effective Sorsa threshold", context => {
  const { document, window } = parseHTML(readFileSync(new URL("../src/sidepanel/sidepanel.html", import.meta.url), "utf8"));
  for (const select of document.querySelectorAll("select")) {
    Object.defineProperty(select, "value", { configurable: true, writable: true, value: "" });
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  context.after(() => original ? Object.defineProperty(globalThis, "document", original) : Reflect.deleteProperty(globalThis, "document"));
  const panel = initUnfollowPanel(async () => ({ ok: true }));
  const settings = createDefaultUnfollowSettings();
  settings.protect.protectVerified = true;
  settings.targets.verified = "require";
  settings.targets.sorsaMax = 800;
  panel.onMessage({ type: "unfollow_state", settings });
  const summary = document.getElementById("uf-rules-summary")!;
  assert.match(summary.textContent!, /Không có tài khoản nào đủ điều kiện/);
  assert.match(summary.textContent!, /Sorsa < 500/);
  assert.match(summary.textContent!, /Xét trực tiếp trên Following/);
  const keepTick = document.getElementById("uf-protect-verified") as unknown as HTMLInputElement;
  keepTick.checked = false;
  keepTick.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.doesNotMatch(summary.textContent!, /Không có tài khoản nào đủ điều kiện/);
});

test("a delayed Unfollow save response preserves edits made while saving", async context => {
  const { document, window } = parseHTML(readFileSync(new URL("../src/sidepanel/sidepanel.html", import.meta.url), "utf8"));
  for (const select of document.querySelectorAll("select")) {
    Object.defineProperty(select, "value", { configurable: true, writable: true, value: "" });
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  context.after(() => original ? Object.defineProperty(globalThis, "document", original) : Reflect.deleteProperty(globalThis, "document"));
  let release!: (value: { ok: boolean; settings: ReturnType<typeof createDefaultUnfollowSettings> }) => void;
  const response = new Promise<{ ok: boolean; settings: ReturnType<typeof createDefaultUnfollowSettings> }>(resolve => { release = resolve; });
  const panel = initUnfollowPanel(async () => response);
  const settings = createDefaultUnfollowSettings();
  panel.onMessage({ type: "unfollow_state", settings });
  document.getElementById("uf-save")!.click();
  const list = document.getElementById("uf-whitelist") as unknown as HTMLTextAreaElement;
  list.value = "@new_keep";
  list.dispatchEvent(new window.Event("input", { bubbles: true }));
  release({ ok: true, settings });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(list.value, "@new_keep");
  assert.match(document.getElementById("uf-save-state")!.textContent!, /chưa lưu/);
});
