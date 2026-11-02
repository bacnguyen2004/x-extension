import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { renderFollowHistory, followHistoryCsv } from "../src/sidepanel/follow-history-panel.ts";
import { collectFollowingObservations } from "../src/content/x-follow-history.ts";
import type { FollowHistoryEntry } from "../src/domain/follow-history.ts";
import { readFileSync } from "node:fs";
import { initFollowPanel } from "../src/sidepanel/follow-panel.ts";
import { createDefaultFollowSettings } from "../src/domain/follow-settings.ts";

test("moving a completed handle updates the visible source list while preserving unsaved edits", context => {
  const { document, window } = parseHTML(readFileSync(new URL("../src/sidepanel/sidepanel.html", import.meta.url), "utf8"));
  for (const select of document.querySelectorAll("select")) Object.defineProperty(select, "value", { configurable: true, writable: true, value: "" });
  const listeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void> = [];
  for (const [key, value] of Object.entries({ document, window, chrome: { storage: { onChanged: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) } } } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  const panel = initFollowPanel(async () => ({ ok: true }));
  const initial = { ...createDefaultFollowSettings(), usernameList: "@alice\n@bob" };
  panel.onMessage({ type: "follow_state", settings: initial });
  const list = document.getElementById("fl-list") as unknown as HTMLTextAreaElement;
  const delay = document.getElementById("fl-delay-min") as unknown as HTMLInputElement;
  list.value = "@alice\n@bob\n@new_user";
  delay.value = "42";
  delay.dispatchEvent(new window.Event("input", { bubbles: true }));
  for (const listener of listeners) listener({ "xContentCreator.follow.v1": { oldValue: initial, newValue: { ...initial, usernameList: "@bob" } } }, "local");
  assert.equal(list.value, "@bob\n@new_user");
  assert.equal(delay.value, "42");
});

test("history rows and CSV distinguish unknown values, negative evidence, zero score and pending requests", context => {
  const { document } = parseHTML('<html><body><div id="list"></div></body></html>');
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  context.after(() => original ? Object.defineProperty(globalThis, "document", original) : Reflect.deleteProperty(globalThis, "document"));
  const entries: FollowHistoryEntry[] = [
    { handle: "alice", status: "following", verified: null, followsYou: null, sorsa: null, updatedAt: null },
    { handle: "bob", status: "requested", verified: false, followsYou: false, sorsa: 0, updatedAt: 1900000000000 },
    { handle: "carol", status: "following", verified: true, followsYou: true, sorsa: 1160.38, updatedAt: null },
  ];
  const container = document.getElementById("list")!;
  renderFollowHistory(container as unknown as HTMLElement, entries);
  assert.match(container.textContent!, /Follow back: chưa rõ/);
  assert.match(container.textContent!, /Chưa follow back/);
  assert.match(container.textContent!, /Đã gửi yêu cầu/);
  assert.match(container.textContent!, /Sorsa: 0/);
  assert.equal(container.querySelector("a")!.getAttribute("href"), "https://x.com/alice");
  const csv = followHistoryCsv(entries);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"bob","Requested","No","0","No"/);
  assert.match(csv, /"alice","Following","Unknown","","Unknown"/);
});

test("browsing records only accounts actually shown as Following with tick and follows-you observations", context => {
  const { document } = parseHTML(`<html><body><main role="main">
    <div data-testid="UserCell"><a href="/alice">@alice</a><svg data-testid="icon-verified"></svg><span>Follows you</span><button data-testid="123-unfollow">Following</button></div>
    <div data-testid="UserCell"><a href="/bob">@bob</a><button data-testid="456-follow">Follow</button></div>
  </main></body></html>`);
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  context.after(() => original ? Object.defineProperty(globalThis, "document", original) : Reflect.deleteProperty(globalThis, "document"));
  assert.deepEqual(collectFollowingObservations(), [{ handle: "alice", verified: true, followsYou: true }]);
});
