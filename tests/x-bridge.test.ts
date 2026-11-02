import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { attachXPort, getXConnection, navigateXTab, requestFollow, requestPostScanCollect, selectXTab, waitForXConnection } from "../src/background/x-bridge.ts";

function connect(t: TestContext, id: number, home = false) {
  const messages: Array<{ type: string; requestId?: string; targetRequestId?: string; deadlineAt?: number }> = [];
  const listeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const emit = (message: object) => { for (const fn of [...listeners]) fn(message); };
  const disconnect = () => { for (const fn of [...disconnectListeners]) fn(); };
  const port = {
    sender: { id: "bridge-test", url: `https://x.com/${home ? "home" : "target"}`, tab: { id }, frameId: 0 },
    onMessage: { addListener: (fn: (message: unknown) => void) => listeners.add(fn), removeListener: (fn: (message: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.add(fn), removeListener: (fn: () => void) => disconnectListeners.delete(fn) },
    postMessage: (message: { type: string; requestId?: string }) => {
      messages.push(message);
      if (message.type === "x_navigate_link") emit({ type: "x_navigate_link_result", requestId: message.requestId, ok: false, error: "navigation_link_missing" });
    },
    disconnect,
  };
  attachXPort(port as unknown as chrome.runtime.Port, "bridge-test");
  emit({ type: "x_hello", onHome: home });
  t.after(disconnect);
  return { messages, listeners, disconnectListeners, emit, disconnect };
}

test("navigation and profile scanning use the same tab when another Home tab is open", async (t) => {
  const home = connect(t, 1, true);
  const profile = connect(t, 2);
  const updates: number[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: {},
    tabs: {
      query: async () => [{ id: 2 }, { id: 1 }],
      update: async (id: number) => { updates.push(id); },
      get: (_id: number, callback: (tab: { status: string }) => void) => callback({ status: "complete" }),
      onUpdated: { addListener() {}, removeListener() {} },
    },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const nav = await navigateXTab("https://x.com/target");
  assert.equal(nav.tabId, 2);
  assert.deepEqual(updates, [2]);
  const scan = requestPostScanCollect({ username: "target", targetCount: 10, thresholds: { views: 1, likes: 0, replies: 0, reposts: 0 }, tabId: nav.tabId });
  assert.equal(home.messages.length, 1, "Home only receives its initial ping");
  const command = profile.messages.at(-1)!;
  assert.equal(command.type, "x_post_scan_collect");
  profile.emit({ type: "x_post_scan_collect_result", requestId: command.requestId, ok: true, posts: [] });
  assert.equal((await scan).ok, true);
  assert.equal((await requestPostScanCollect({ username: "target", targetCount: 10, thresholds: { views: 1, likes: 0, replies: 0, reposts: 0 }, tabId: 1 })).error, "x_tab_not_selected");
  profile.disconnect();
  assert.equal(getXConnection().connected, false, "do not silently fall back to another account/tab");
  assert.equal((await waitForXConnection(1, 2)).ok, false);
});

test("concurrent navigation creates one shared X tab and reuses it", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let created = 0;
  const existing: { id: number }[] = [], updates: number[] = [];
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: {}, tabs: {
    query: async () => [...existing],
    create: async () => { created++; existing.push({ id: 55 }); return { id: 55 }; },
    update: async (id: number) => { updates.push(id); },
    get: (_id: number, done: (tab: { status: string }) => void) => done({ status: "complete" }),
    onUpdated: { addListener() {}, removeListener() {} },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const [a,b] = await Promise.all([navigateXTab("https://x.com/home"), navigateXTab("https://x.com/alice")]);
  assert.equal(created, 1); assert.equal(a.tabId, b.tabId); assert.deepEqual(updates, [55]);
});

test("out-of-order responses and busy errors only complete their own request", async (t) => {
  const port = connect(t, 3);
  selectXTab(3);
  const a = requestFollow({ authorHandle: "alice", tweetUrl: null });
  const b = requestFollow({ authorHandle: "bob", tweetUrl: null });
  const [first, second] = port.messages.slice(1);
  assert.notEqual(first.requestId, second.requestId);
  let firstDone = false;
  void a.then(() => { firstDone = true; });
  port.emit({ type: "x_follow_result", requestId: second.requestId, ok: false, error: "busy" });
  assert.equal((await b).error, "busy");
  port.emit({ type: "x_follow_result", ok: true });
  port.emit({ type: "x_follow_result", requestId: "old-request", ok: true });
  await Promise.resolve();
  assert.equal(firstDone, false);
  port.emit({ type: "x_follow_result", requestId: first.requestId, ok: true, detail: "follow_confirmed" });
  assert.equal((await a).detail, "follow_confirmed");
  assert.equal(port.listeners.size, 1);
  assert.equal(port.disconnectListeners.size, 1);
});

test("disconnect resolves pending requests and an old port cannot remove its replacement", async (t) => {
  const old = connect(t, 4);
  selectXTab(4);
  const pending = requestFollow({ authorHandle: "alice", tweetUrl: null });
  const replacement = connect(t, 4);
  old.disconnect();
  assert.equal((await pending).error, "port_closed");
  assert.equal(getXConnection().connected, true);
  const next = requestFollow({ authorHandle: "bob", tweetUrl: null });
  const command = replacement.messages.at(-1)!;
  replacement.emit({ type: "x_follow_result", requestId: command.requestId, ok: true });
  assert.equal((await next).ok, true);
});

test("timeout cancels only its own content command and waits for lock release", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const port = connect(t, 71); selectXTab(71);
  const pending = requestFollow({ authorHandle: "alice", tweetUrl: null });
  const command = port.messages.at(-1)!;
  assert.equal(command.deadlineAt, 26000);
  let done = false; void pending.then(() => { done = true; });
  t.mock.timers.tick(25000);
  assert.deepEqual(port.messages.at(-1), { type: "x_cancel", targetRequestId: command.requestId });
  port.emit({ type: "x_command_released", requestId: "other-command" });
  await Promise.resolve(); assert.equal(done, false);
  port.emit({ type: "x_command_released", requestId: command.requestId });
  assert.equal((await pending).error, "timeout");
  assert.equal(port.listeners.size, 1);
});

test("a successful result during cancellation grace is preserved", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const port = connect(t, 72); selectXTab(72);
  const pending = requestFollow({ authorHandle: "alice", tweetUrl: null });
  const command = port.messages.at(-1)!;
  t.mock.timers.tick(25000);
  port.emit({ type: "x_follow_result", requestId: command.requestId, ok: true, detail: "follow_confirmed" });
  assert.equal((await pending).ok, true);
});

test("an unresponsive content command is recovered with a rate limited reload", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const reloaded: number[] = [];
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { tabs: { reload: async (id: number) => { reloaded.push(id); } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const port = connect(t, 73); selectXTab(73);
  for (let i = 0; i < 2; i++) {
    const pending = requestFollow({ authorHandle: "alice", tweetUrl: null });
    t.mock.timers.tick(25000); t.mock.timers.tick(2000);
    assert.equal((await pending).error, "timeout");
    assert.equal(port.listeners.size, 1);
  }
  assert.deepEqual(reloaded, [73]);
});
