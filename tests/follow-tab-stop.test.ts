import assert from "node:assert/strict";
import test from "node:test";
import { attachXPort } from "../src/background/x-bridge.ts";
import { runFollowTick, stopFollowRunner } from "../src/background/follow-runner.ts";
import { createInitialFollowRuntime } from "../src/background/follow-store.ts";
import { acquireXTurn, getXWorker } from "../src/background/x-coordinator.ts";

test("stopping the Follow tab during profile inspection prevents Follow and cannot restart the runner", async t => {
  const disk: Record<string, unknown> = { "xContentCreator.followRuntime.v1": {
    ...createInitialFollowRuntime(), running: true, sourceMode: "list", queue: ["alice"],
  } };
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { sendMessage: async () => {} }, alarms: { clear: async () => {}, create: async () => {} },
    storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); } } },
  } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>(), commands: string[] = [];
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  let inspected!: () => void;
  const pending = new Promise<void>(resolve => { inspected = resolve; });
  let profileRequest: string | undefined;
  const port = { sender: { id: "follow-stop-test", url: "https://x.com/alice", tab: { id: 84 }, frameId: 0 },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    postMessage(m: { type: string; requestId?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", handle: "me", loggedIn: true }); return; }
      commands.push(m.type);
      if (m.type === "x_follow_profile_meta") { profileRequest = m.requestId; inspected(); }
    }, disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "follow-stop-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  const running = runFollowTick();
  await pending;
  await stopFollowRunner();
  emit({ type: "x_follow_profile_meta_result", requestId: profileRequest, ok: true,
    meta: { onProfile: true, verified: false, alreadyFollowing: false, ownProfile: false } });
  await running;
  assert.deepEqual(commands, ["x_follow_profile_meta", "x_stop"]);
  assert.equal((disk["xContentCreator.followRuntime.v1"] as { running: boolean }).running, false);
  const release = await acquireXTurn("smm");
  try {
    disk["xContentCreator.followRuntime.v1"] = { ...createInitialFollowRuntime(), running: true, sourceMode: "list", queue: ["alice"] };
    const queued = runFollowTick();
    await Promise.resolve();
    await stopFollowRunner();
    await queued;
    assert.deepEqual(commands, ["x_follow_profile_meta", "x_stop"], "a stopped waiter must not send a new command");
    assert.equal(getXWorker(), "smm");
  } finally { release?.(); }
});
