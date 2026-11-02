import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createInitialRuntime, createEmptyDailyStats } from "../src/domain/agent-settings.ts";
import { readAdaptiveRest } from "../src/domain/adaptive-rest.ts";
import { createInitialState } from "../src/domain/types.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { makeJob } from "../src/domain/agent-queue.ts";

test("loaded work triggers rest, restart preserves the queue/deadline, and manual stop never auto-resumes", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const campaign = normalizeApiCampaign({ tweet_id: "2112057695247180169", author_handle: "author", follows_author: true })!;
  const disk: Record<string, unknown> = { "pogoTaskReader.state": { ...createInitialState(), campaigns: { [campaign.tweet_id]: campaign } } };
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (p: object) => Object.assign(disk, p) } },
  } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners: Array<(m: unknown) => void> = [], disconnects: Array<() => void> = [], commands: string[] = [];
  attachXPort({ sender: { id: "rest-test", url: "https://x.com/home", frameId: 0, tab: { id: 93 } },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.push(fn), removeListener: () => {} },
    onDisconnect: { addListener: (fn: () => void) => disconnects.push(fn), removeListener: () => {} },
    postMessage: (m: { type: string; requestId?: string }) => {
      if (m.type === "x_ping") listeners.forEach(fn => fn({ type: "x_hello", loggedIn: true, handle: "viewer", onHome: true }));
      else commands.push(m.type);
    }, disconnect: () => {},
  } as unknown as chrome.runtime.Port, "rest-test");
  t.after(() => disconnects.forEach(fn => fn()));
  const settings = createDefaultAgentSettings();
  settings.modules.homeScroll = false;
  settings.actions = { reply: false, retweet: true, like: false, follow: false, quote: false };
  const runtime = { ...createInitialRuntime(), status: "waiting" as const, adaptiveRest: { ...readAdaptiveRest(undefined, now), activeMs: 1800000, workCount: 30 } };
  const queue = { jobs: [makeJob({ source: "pogo", kind: "retweet", authorHandle: "author", tweetId: campaign.tweet_id, tweetUrl: campaign.tweet_url, tweetText: "Post", error: "navigating" })] };
  const deps = { settings, runtime, queue, stats: createEmptyDailyStats(), extensionId: "rest-test", appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {} };
  const first = await runAgentTick(deps);
  assert.equal(first.runtime.adaptiveRest?.reason, "high_load");
  assert.equal(first.nextDelayMs, 1200000);
  assert.deepEqual(commands, []);
  assert.deepEqual(first.queue, queue);
  const saved = JSON.parse(JSON.stringify(first.runtime));
  now += 600000;
  let pulls = 0;
  const woke = await runAgentTick({ ...deps, runtime: saved, pullPogo: async () => { pulls++; return { kind: "updated" }; } });
  assert.equal(woke.runtime.adaptiveRest?.resumeAt, first.runtime.adaptiveRest?.resumeAt);
  assert.equal(woke.nextDelayMs, 600000);
  assert.equal(pulls, 0);
  assert.deepEqual(commands, []);
  now += 1200000;
  const stopped = await runAgentTick({ ...deps, runtime: { ...saved, status: "paused" } });
  assert.equal(stopped.runtime.status, "paused");
  assert.equal(stopped.nextDelayMs, 0);
  assert.deepEqual(commands, []);
});
