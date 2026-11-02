import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createInitialRuntime, createEmptyDailyStats, todayKey } from "../src/domain/agent-settings.ts";

test("continuous agent waits for Vietnam midnight at the daily cap, while finite agent pauses", async t => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    storage: { local: { get: async () => ({}), set: async () => {} } },
  } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners: Array<(m: unknown) => void> = [];
  const disconnects: Array<() => void> = [];
  attachXPort({ sender: { id: "daily-test", url: "https://x.com/home", frameId: 0, tab: { id: 90 } },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.push(fn), removeListener: () => {} },
    onDisconnect: { addListener: (fn: () => void) => disconnects.push(fn), removeListener: () => {} },
    postMessage: (m: { type: string }) => { if (m.type === "x_ping") listeners.forEach(fn => fn({ type: "x_hello", handle: "viewer", loggedIn: true, onHome: true })); },
    disconnect: () => {},
  } as unknown as chrome.runtime.Port, "daily-test");
  t.after(() => disconnects.forEach(fn => fn()));
  const settings = createDefaultAgentSettings();
  settings.actions = { reply: true, quote: false, follow: false, retweet: false, like: false };
  settings.dailyTargets!.ranges.reply = { min: 1, max: 1 };
  settings.dailyTargets!.afterReached = "pause";
  settings.modules.homeScroll = false;
  const deps = { settings, runtime: createInitialRuntime(), stats: { ...createEmptyDailyStats(), reply: 1 }, queue: { jobs: [] }, extensionId: "daily-test",
    appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {} };
  const before = Date.now();
  const result = await runAgentTick(deps);
  const midnight = Date.parse(`${todayKey()}T00:00:00+07:00`) + 86400000;
  assert.equal(result.runtime.status, "waiting");
  assert.ok(Math.abs(before + result.nextDelayMs - midnight) < 2000);
  assert.equal(result.stats.reply, 1, "waiting must not reset daily usage early");
  settings.continuousRun = false;
  const finite = await runAgentTick({ ...deps, runtime: createInitialRuntime() });
  assert.equal(finite.runtime.status, "paused");
  assert.equal(finite.nextDelayMs, 0);
});
