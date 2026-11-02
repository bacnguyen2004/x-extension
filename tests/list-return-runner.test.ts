import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";

for (const [surface, stopAfterReply, withFollow] of [["lists", false, false], ["lists", true, false], ["lists", false, true], ["home", false, false], ["following", false, false]] as const) test(`${surface} bundle ${stopAfterReply ? "does not Back after Stop" : withFollow ? "passes its completed Follow profile to the return command" : "returns once after both Like and Reply"}`, async t => {
  const ai = createDefaultAiSettings(); ai.apiKey = "test-key";
  const disk: Record<string, unknown> = { "pogoTaskReader.aiSettings.v1": ai };
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => Object.assign(disk, structuredClone(patch)) } } } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>();
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  const commands: string[] = [];
  let stopped = false;
  const tweetId = "2112057695247180198", text = "Withdrawal fees have fallen from $5 to $1.";
  const listUrl = "https://x.com/i/lists/1234567890";
  const port = { sender: { id: "list-return-runner", url: "https://x.com/home", frameId: 0, tab: { id: 202 } },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) }, disconnect() {},
    postMessage(m: { type: string; requestId?: string; listUrl?: string; followedProfile?: string; browseSurface?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", handle: "owner", onHome: true }); return; }
      commands.push(m.type);
      if (m.type === "x_prepare_tweet" && surface === "lists") assert.equal(m.listUrl, listUrl, "preparation must identify the originating list");
      if (m.type === "x_back_to_browse") { assert.equal(m.followedProfile, withFollow ? "alice" : undefined); assert.equal(m.browseSurface, surface); }
      if (m.type === "x_reply" && stopAfterReply) stopped = true;
      emit({ type: `${m.type}_result`, requestId: m.requestId, ok: true, tweetText: text,
        ...(m.type === "x_back_to_browse" ? { detail: "browse_back_done" } : {}),
        ...(m.type === "x_timeline_scan" ? { tweets: [{ tweetId, tweetUrl: `https://x.com/alice/status/${tweetId}`, authorHandle: "alice", text, alreadyLiked: false, promoted: false }] } : {}) });
    } };
  attachXPort(port as unknown as chrome.runtime.Port, "list-return-runner");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(Math, "random", () => 0);
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "A $1 withdrawal fee makes small transfers cheaper. Is that rate permanent?" } }] }));
  const settings = createDefaultAgentSettings();
  settings.priority = "browse_only"; settings.adaptiveRest = false;
  settings.modules = { ...settings.modules, pogoTasks: false, homeScroll: surface === "home", followingFeed: surface === "following", lists: surface === "lists", notifications: false };
  settings.listUrlOrName = listUrl;
  settings.actions = { like: true, reply: true, follow: withFollow, quote: false, retweet: false };
  settings.humanize.followPct = withFollow ? 100 : 0;
  settings.humanize.likePct = 100; settings.humanize.replyPct = 100; const result = await runAgentTick({ settings, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: [] }, extensionId: "list-return-runner", isCancelled: () => stopped,
    appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {}, waitForDelay: async () => {} });
  assert.equal(result.stats.like, 1); assert.equal(result.stats.reply, 1);
  assert.equal(result.runtime.browseRotation?.currentSource ?? result.runtime.browseRotation?.targetSource, surface);
  assert.ok((result.runtime.browseRotation?.remainingScanTimeMs ?? 0) > 0, "processing a post does not burn the scan clock");
  assert.ok(commands.indexOf("x_reply") > commands.indexOf("x_like"));
  assert.equal(commands.filter(command => command === "x_back_to_browse").length, stopAfterReply ? 0 : 1);
  if (!stopAfterReply) assert.ok(commands.indexOf("x_back_to_browse") > commands.indexOf("x_reply"));
  if (withFollow) {
    assert.equal(result.stats.follow, 1);
    assert.ok(commands.indexOf("x_back_to_browse") > commands.indexOf("x_follow"));
  }
});

