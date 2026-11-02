import assert from "node:assert/strict";
import test from "node:test";
import { attachXPort, getXConnection } from "../src/background/x-bridge.ts";
import { startMockAgent, tickMockAgent, pauseMockAgent, setKillSwitch, getAgentPublicState } from "../src/background/agent-store.ts";
import { createDefaultAgentSettings } from "../src/domain/agent-settings.ts";
import { makeJob } from "../src/domain/agent-queue.ts";

test("pause and kill switch remain stopped when an in-flight X request returns", async (t) => {
  const settings = { ...createDefaultAgentSettings(), executeActions: true, activeHoursStart: "00:00", activeHoursEnd: "00:00" };
  const draft = makeJob({ kind: "draft_reply", status: "done", tweetId: "111", authorHandle: "a", tweetUrl: "https://x.com/a/status/111", tweetText: "text", draftText: "hello", source: "pogo" });
  const storage: Record<string, unknown> = { "xContentCreator.agentSettings.v1": settings, "xContentCreator.agentQueue.v1": { jobs: [draft] } };
  const alarms: unknown[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "ext", async sendMessage() {} },
    storage: { local: { async get(key: string) { return { [key]: storage[key] }; }, async set(values: object) { Object.assign(storage, values); } } },
    alarms: { async create(...args: unknown[]) { alarms.push(args); } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const disconnect = () => { for (const fn of [...disconnectListeners]) fn(); };
  let actionStarted = () => {};
  let replyRequestId: string | undefined;
  const emit = (message: object) => { for (const listener of [...listeners]) listener(message); };
  const port = {
    sender: { id: "ext", url: "https://x.com/home", tab: { id: 1 }, frameId: 0 },
    onMessage: { addListener(fn: (message: unknown) => void) { listeners.add(fn); }, removeListener(fn: (message: unknown) => void) { listeners.delete(fn); } },
    onDisconnect: { addListener(fn: () => void) { disconnectListeners.add(fn); }, removeListener(fn: () => void) { disconnectListeners.delete(fn); } },
    postMessage(message: { type: string; requestId?: string }) {
      if (message.type === "x_ping") emit({ type: "x_hello", loggedIn: true, onHome: true, handle: "me" });
      if (message.type === "x_prepare_tweet") emit({ type: "x_prepare_tweet_result", requestId: message.requestId, ok: true });
      if (message.type === "x_reply") { replyRequestId = message.requestId; actionStarted(); }
    },
    disconnect() {},
  };
  assert.equal(attachXPort(port as unknown as chrome.runtime.Port, "ext"), true);
  t.after(() => disconnect());
  assert.equal(getXConnection().tabCount, 1);

  for (const stop of [() => pauseMockAgent(), () => setKillSwitch(true)]) {
    const agent = await startMockAgent();
    agent.runtime.nextActionAt = 0;
    const started = new Promise<void>((resolve) => { actionStarted = resolve; });
    const tick = tickMockAgent();
    await started;
    await stop();
    const alarmCount = alarms.length;
    emit({ type: "x_reply_result", requestId: replyRequestId, ok: false, error: "stopped" });
    await tick;
    const state = await getAgentPublicState();
    assert.equal(state.runtime.status, "paused");
    assert.equal(state.runtime.nextActionAt, null);
    assert.equal(alarms.length, alarmCount);
  }
});
