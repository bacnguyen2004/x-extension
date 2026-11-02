import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { createInitialState, type PersistedState } from "../src/domain/types.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";

for (const detail of ["already_following", "follow_requested", "follow_confirmed", "own_profile"]) {
  test(`follow outcome ${detail} updates queue, counter and Pogo cache accurately`, async (t) => {
    const campaign = normalizeApiCampaign({ tweet_id: "2104963988278947893", author_handle: "jabosiswanto94", follows_author: false, locked_points: 0, text: "Post" })!;
    const storage: Record<string, unknown> = { "pogoTaskReader.state": { ...createInitialState(), campaigns: { [campaign.tweet_id]: campaign } } };
    const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
      storage: { local: {
        async get(key: string) { return { [key]: storage[key] }; },
        async set(values: object) { Object.assign(storage, values); },
      } },
    } });
    t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
    const listeners = new Set<(message: unknown) => void>();
    const disconnectListeners = new Set<() => void>();
  const disconnect = () => { for (const fn of [...disconnectListeners]) fn(); };
    const emit = (message: object) => { for (const listener of [...listeners]) listener(message); };
    const port = {
      sender: { id: "follow-test", url: "https://x.com/jabosiswanto94", tab: { id: 2 }, frameId: 0 },
      onMessage: { addListener(fn: (message: unknown) => void) { listeners.add(fn); }, removeListener(fn: (message: unknown) => void) { listeners.delete(fn); } },
      onDisconnect: { addListener(fn: () => void) { disconnectListeners.add(fn); }, removeListener(fn: () => void) { disconnectListeners.delete(fn); } },
      postMessage(message: { type: string; requestId?: string }) {
        if (message.type === "x_ping") emit({ type: "x_hello", handle: "me", loggedIn: true });
        if (message.type === "x_follow") emit({ type: "x_follow_result", requestId: message.requestId, ok: true, detail });
      },
      disconnect() {},
    };
    attachXPort(port as unknown as chrome.runtime.Port, "follow-test");
    t.after(() => disconnect());
    const settings = createDefaultAgentSettings();
    settings.actions = { like: false, retweet: false, reply: false, quote: false, follow: true };
    settings.modules.homeScroll = false;
    const result = await runAgentTick({ settings, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: [] }, appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {}, extensionId: "follow-test" });
    const realFollow = detail === "follow_confirmed";
    assert.equal(result.stats.follow, realFollow ? 1 : 0);
    assert.equal(result.queue.jobs[0].status, realFollow ? "done" : "skipped");
    assert.equal((storage["pogoTaskReader.state"] as PersistedState).campaigns[campaign.tweet_id].follows_author, realFollow || detail === "already_following");
    assert.equal(result.runtime.consecutiveErrors, 0);
    assert.ok(result.nextDelayMs >= 8000);
  });
}
