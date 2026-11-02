import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { waitForFollowProfile } from "../src/background/follow-profile.ts";
import { noteXPageReady, xPageRetryDelay } from "../src/background/x-page-health.ts";
import { findXNavigationLink } from "../src/x/navigation.ts";
import { goHomeNaturally } from "../src/x/home-nav.ts";
import { handleXCommand } from "../src/content/x-commands.ts";

test("slow profile loading navigates once and waits for the correct controls", async context => {
  let clock = 1900000000000, reads = 0;
  context.mock.method(Date, "now", () => clock);
  const navigations: string[] = [];
  const result = await waitForFollowProfile("alice", {
    read: async () => ++reads < 4 ? { ok: false, error: "need_navigate_profile" } :
      { ok: true, meta: { onProfile: true, verified: false, hasFollowButton: true } },
    navigate: async url => { navigations.push(url); return { ok: true }; },
    wait: async ms => { clock += ms; }, cancelled: () => false,
  });
  assert.equal(result.ok, true);
  assert.equal(reads, 4);
  assert.deepEqual(navigations, ["https://x.com/alice"]);
});

test("unresponsive profile expires without opening more links, and waiting respects Stop", async context => {
  let clock = 1900000000000, navigations = 0, cancelled = false;
  context.mock.method(Date, "now", () => clock);
  const deps = {
    read: async () => ({ ok: false, error: "need_navigate_profile" }),
    navigate: async () => { navigations++; return { ok: true }; },
    wait: async (ms: number) => { clock += ms; }, cancelled: () => cancelled,
  };
  assert.equal((await waitForFollowProfile("alice", deps)).error, "follow_profile_unverified");
  assert.equal(navigations, 1);
  assert.equal(clock, 1900000025000);
  assert.equal((await waitForFollowProfile("alice", { ...deps, wait: async () => { cancelled = true; } })).error, "stopped");
  assert.equal(navigations, 2);
});

test("legacy content navigation is awaited without issuing a second navigation", async () => {
  let reads = 0, navigations = 0;
  const result = await waitForFollowProfile("alice", {
    read: async () => ++reads === 1 ? { ok: false, error: "navigating_profile" } :
      { ok: true, meta: { onProfile: true, verified: true, alreadyFollowing: true } },
    navigate: async () => { navigations++; return { ok: true }; }, wait: async () => {}, cancelled: () => false,
  });
  assert.equal(result.ok, true);
  assert.equal(navigations, 0);
});

test("three consecutive page failures persist a two-minute break that clears on success", async context => {
  let clock = 1900000000000;
  context.mock.method(Date, "now", () => clock);
  const disk: Record<string, unknown> = {};
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); },
  } } } });
  context.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  await noteXPageReady(false); await noteXPageReady(false);
  assert.equal(await xPageRetryDelay(), 0);
  await noteXPageReady(false);
  assert.equal(await xPageRetryDelay(), 120000);
  clock += 30000;
  assert.equal(await xPageRetryDelay(), 90000);
  clock += 90001;
  assert.equal(await xPageRetryDelay(), 0);
  await noteXPageReady(true);
  await noteXPageReady(false);
  assert.equal(await xPageRetryDelay(), 0);
});

test("internal navigation uses an existing X link and Home defaults to its button", () => {
  const { document } = parseHTML('<html><body><a href="/home">Home</a><a href="/alice">Alice</a><a href="https://other.example/bob">Other</a></body></html>');
  assert.equal(findXNavigationLink(document as unknown as Document, "https://x.com/alice", "https://x.com/home")?.textContent, "Alice");
  assert.equal(findXNavigationLink(document as unknown as Document, "https://other.example/bob", "https://x.com/home"), null);
  let assigned = false, backed = false;
  assert.equal(goHomeNaturally({ pathname: "/alice", activateHome: () => true, assign: () => { assigned = true; }, back: () => { backed = true; } }), "link");
  assert.equal(assigned || backed, false);
  assert.equal(goHomeNaturally({ pathname: "/alice", historyLength: 3, rng: () => 0, back: () => {}, assign: () => { assigned = true; } }), "back");
});

test("content Follow and profile inspection do not open a URL themselves", async context => {
  const { document, window } = parseHTML('<html><body><main role="main"></main></body></html>');
  const assignments: string[] = [], messages: Array<{ type?: string; error?: string }> = [];
  for (const [key, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement,
    location: { pathname: "/home", href: "https://x.com/home", origin: "https://x.com", assign: (url: string) => assignments.push(url) } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  const port = { postMessage: (message: object) => { messages.push(message); } };
  await handleXCommand(port, { type: "x_follow_profile_meta", authorHandle: "alice" });
  await handleXCommand(port, { type: "x_follow", authorHandle: "alice" });
  assert.equal(messages.filter(message => message.error === "need_navigate_profile").length, 2);
  assert.deepEqual(assignments, []);
});
