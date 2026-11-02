import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { smmPlaceOrder, smmRetryFailedOrders, smmStartPostScan, smmStopPostScan } from "../src/background/smm-runner.ts";
import { getSmmScanSnapshot, resetSmmScanCancel, setCachedSmmServices, setSmmScanSnapshot } from "../src/background/smm-store.ts";
import { createDefaultSmmSettings, createEmptyScanSnapshot } from "../src/domain/smm-settings.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { acquireXTurn, getXWorker } from "../src/background/x-coordinator.ts";

const post = { id: "123", username: "alice", url: "https://x.com/alice/status/123", views: 0, likes: 0, reposts: 0, replies: 0, below: ["views", "likes"] };

test("SMM scan is rejected while Agent owns X without navigating or starting", async t => {
  setup(t);
  const release = await acquireXTurn("agent");
  t.after(() => release?.());
  let navigations = 0;
  t.mock.method(chrome.tabs, "update", async () => { navigations++; return {} as chrome.tabs.Tab; });
  const result = await smmStartPostScan();
  assert.equal(result.ok,false);assert.match(result.error || "", /Agent/);
  assert.equal(navigations, 0);assert.equal(getSmmScanSnapshot().scanning,false);
  assert.equal(getXWorker(), "agent");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(t: TestContext, bothMetrics = false) {
  const settings = { ...createDefaultSmmSettings(), apiKey: "fake-key", autoOrder: true, scanUsername: "alice", scanLimit: 1, minLikes: bothMetrics ? 50 : 0, viewServiceId: "1", likeServiceId: "2" };
  const storage: Record<string, unknown> = { "xContentCreator.smm.v1": settings };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "smm-test", sendMessage: async () => {} },
    storage: { local: {
      get: async (key: string) => ({ [key]: structuredClone(storage[key]) }),
      set: async (patch: object) => { Object.assign(storage, structuredClone(patch)); },
    } },
    tabs: {
      query: async () => [{ id: 91 }],
      update: async () => {},
      get: (_id: number, callback: (tab: { status: string }) => void) => callback({ status: "complete" }),
      onUpdated: { addListener() {}, removeListener() {} },
    },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  resetSmmScanCancel();
  setCachedSmmServices([1, 2].map((service) => ({ service, type: "Default", min: 1, max: 100000 })));
  setSmmScanSnapshot({ ...createEmptyScanSnapshot(), scannedCount: 1, belowThreshold: [post] });
  return storage;
}

test("concurrent retries and scan starts cannot submit duplicate orders", async (t) => {
  setup(t);
  const started = deferred<void>();
  const response = deferred<Response>();
  let adds = 0;
  t.mock.method(globalThis, "fetch", async () => { adds++; started.resolve(); return response.promise; });
  const first = smmRetryFailedOrders();
  await started.promise;
  assert.equal(getSmmScanSnapshot().scanning, true);
  assert.equal((await smmRetryFailedOrders()).ok, false);
  assert.equal((await smmStartPostScan()).ok, false);
  response.resolve(Response.json({ order: 1 }));
  assert.equal((await first).ok, true);
  assert.equal((await smmRetryFailedOrders()).ok, true);
  assert.equal(adds, 1, "a completed post/metric must not be ordered again");
  assert.equal(getSmmScanSnapshot().scanning, false);
});

test("direct concurrent orders for the same post share one request", async (t) => {
  setup(t);
  let adds = 0;
  t.mock.method(globalThis, "fetch", async () => { adds++; return Response.json({ order: 10 }); });
  const opts = { link: post.url, metric: "views" as const, postId: post.id };
  const first = smmPlaceOrder(opts);
  const second = smmPlaceOrder(opts);
  assert.equal(first, second);
  assert.equal((await first).ok, true);
  assert.equal((await second).order, "10");
  assert.equal((await smmPlaceOrder(opts)).order, "10");
  assert.equal(adds, 1);
});

test("a rejected order releases its lock so it can be retried", async (t) => {
  setup(t);
  let adds = 0;
  t.mock.method(globalThis, "fetch", async () => {
    adds++;
    return adds === 1 ? Response.json({ error: "service unavailable" }, { status: 503 }) : Response.json({ order: 11 });
  });
  const opts = { link: post.url, metric: "views" as const, postId: post.id };
  assert.equal((await smmPlaceOrder(opts)).ok, false);
  assert.equal((await smmPlaceOrder(opts)).ok, true);
  assert.equal(adds, 2);
});

test("independent concurrent orders retain both history entries", async (t) => {
  const storage = setup(t);
  let nextOrder = 20;
  t.mock.method(globalThis, "fetch", async () => Response.json({ order: nextOrder++ }));
  const results = await Promise.all(["123", "456"].map((id) => smmPlaceOrder({
    link: `https://x.com/alice/status/${id}`, metric: "views", postId: id,
  })));
  assert.ok(results.every((result) => result.ok));
  const history = storage["xContentCreator.smmOrders.v1"] as Array<{ postId: string }>;
  assert.deepEqual(history.map((entry) => entry.postId).sort(), ["123", "456"]);
});

test("stopping during scan still auto-orders posts already found", async (t) => {
  setup(t);
  const listeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const emit = (message: object) => { for (const fn of [...listeners]) fn(message); };
  const collectStarted = deferred<void>();
  const port = {
    sender: { id: "smm-test", url: "https://x.com/alice", tab: { id: 91 }, frameId: 0 },
    onMessage: { addListener: (fn: (message: unknown) => void) => listeners.add(fn), removeListener: (fn: (message: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.add(fn), removeListener: (fn: () => void) => disconnectListeners.delete(fn) },
    postMessage(message: { type: string; requestId?: string }) {
      if (message.type === "x_navigate_link") {
        emit({ type: "x_navigate_link_result", requestId: message.requestId, ok: true });
        return;
      }
      if (message.type === "x_post_scan_collect") {
        collectStarted.resolve();
        emit({ type: "x_post_scan_collect_result", requestId: message.requestId, ok: true, posts: [post] });
      }
    },
    disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "smm-test");
  t.after(() => { for (const fn of [...disconnectListeners]) fn(); });
  let adds = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json({ order: ++adds }));
  const scan = smmStartPostScan();
  await collectStarted.promise;
  await smmStopPostScan();
  assert.equal((await scan).ok, true);
  assert.equal(adds, 1, "stop during scan must still place orders for found below-threshold posts");
  assert.equal(getSmmScanSnapshot().orderedCount, 1);
  assert.match(getSmmScanSnapshot().status, /đặt 1 đơn/);
});

test("auto ordering stays stoppable and cancellation prevents the next metric; retry can resume", async (t) => {
  setup(t, true);
  const listeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const emit = (message: object) => { for (const fn of [...listeners]) fn(message); };
  const port = {
    sender: { id: "smm-test", url: "https://x.com/alice", tab: { id: 91 }, frameId: 0 },
    onMessage: { addListener: (fn: (message: unknown) => void) => listeners.add(fn), removeListener: (fn: (message: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.add(fn), removeListener: (fn: () => void) => disconnectListeners.delete(fn) },
    postMessage(message: { type: string; requestId?: string }) {
      if (message.type === "x_navigate_link") {
        emit({ type: "x_navigate_link_result", requestId: message.requestId, ok: true });
        return;
      }
      if (message.type === "x_post_scan_collect") emit({ type: "x_post_scan_collect_result", requestId: message.requestId, ok: true, posts: [post] });
    },
    disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "smm-test");
  t.after(() => { for (const fn of [...disconnectListeners]) fn(); });
  const started = deferred<void>();
  const response = deferred<Response>();
  let adds = 0;
  t.mock.method(globalThis, "fetch", async () => {
    adds++;
    if (adds === 1) { started.resolve(); return response.promise; }
    return Response.json({ order: adds });
  });
  const scan = smmStartPostScan();
  await started.promise;
  assert.equal(getSmmScanSnapshot().scanning, true, "Stop must stay enabled during auto ordering");
  await smmStopPostScan();
  response.resolve(Response.json({ order: 1 }));
  assert.equal((await scan).ok, true);
  assert.equal(adds, 1, "Stop prevents the likes order after the in-flight views order");
  assert.equal(getSmmScanSnapshot().scanning, false);
  assert.equal(getSmmScanSnapshot().cancelled, true);
  assert.match(getSmmScanSnapshot().status, /Đã dừng/);
  assert.equal((await smmRetryFailedOrders()).ok, true);
  assert.equal(adds, 2, "retry clears old cancellation and orders only the remaining metric");
  assert.equal(getSmmScanSnapshot().cancelled, false);
});
