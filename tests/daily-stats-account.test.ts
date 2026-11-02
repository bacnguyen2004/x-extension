import assert from "node:assert/strict";
import test from "node:test";
import { getAgentPublicState, clearQueue, clearActivity } from "../src/background/agent-store.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createEmptyDailyStats } from "../src/domain/agent-settings.ts";
import { guardedFollow } from "../src/background/follow-budget.ts";
import { loadFollowRuntime } from "../src/background/follow-store.ts";

test("daily counters are isolated per X account and survive clearing queue/activity", async (t) => {
  const disk: Record<string, unknown> = { "xContentCreator.agentStats.v1": { ...createEmptyDailyStats(), reply: 30, follow: 5 } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "daily-stats-test", sendMessage: async () => {} },
    storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); } } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(message: unknown) => void>(), disconnects = new Set<() => void>();
  const hello = (handle: string) => { for (const fn of [...listeners]) fn({ type: "x_hello", handle, loggedIn: true, onHome: true, href: "https://x.com/home" }); };
  const port = { sender: { id: "daily-stats-test", url: "https://x.com/home", tab: { id: 99 }, frameId: 0 },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    postMessage() { hello("alice"); }, disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "daily-stats-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  hello("alice");
  let state = await getAgentPublicState();
  assert.equal(state.today.account, "alice"); assert.equal(state.today.reply, 30);
  hello("bob"); state = await getAgentPublicState();
  assert.equal(state.today.account, "bob"); assert.equal(state.today.reply, 0);
  hello("alice");
  await clearQueue(); await clearActivity(); state = await getAgentPublicState();
  assert.equal(state.today.reply, 30); assert.equal(state.today.follow, 5);
  assert.ok(disk["xContentCreator.agentStats.v1.alice"]);
  assert.ok(disk["xContentCreator.agentStats.v1.bob"]);
  await guardedFollow({ account: () => "alice", cancelled: () => false, origin: "follow", action: async () => ({ ok: true, detail: "follow_confirmed" }) });
  assert.equal((await getAgentPublicState()).today.follow, 6);
  assert.equal((await loadFollowRuntime()).followedToday, 6);
  hello("bob"); assert.equal((await loadFollowRuntime()).followedToday, 0);
});
