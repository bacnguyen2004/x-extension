import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";
import { sanitizeQueue, type AgentQueueState } from "../src/domain/agent-queue.ts";
import { observeNotificationBatch } from "../src/domain/notification-batch.ts";

for (const disableBeforeSend of [false, true]) test(`Notifications ${disableBeforeSend ? "honors disabling execution before sending" : "posts its selected reply before returning Home"}`, async t => {
  const ai = createDefaultAiSettings(); ai.apiKey = "test-key";
  const disk: Record<string, unknown> = { "pogoTaskReader.aiSettings.v1": ai };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => Object.assign(disk, structuredClone(patch)) } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>();
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  const tweetId = "2112057695247180192", text = "What changed in the latest release, @owner?";
  let badge = 3;
  const commands: Array<{ type: string; browseSurface?: string; text?: string }> = [];
  const port = { sender: { id: "notification-auto", url: "https://x.com/home", frameId: 0, tab: { id: 201 } },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) }, disconnect() {},
    postMessage(m: { type: string; requestId?: string; browseSurface?: string; text?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", handle: "owner", onHome: true, notificationCount: badge }); return; }
      commands.push(m);
      if (m.type === "x_timeline_scan") {
        badge = 0;
        emit({ type: "x_timeline_scan_result", requestId: m.requestId, ok: true, notificationCount: badge, tweets: [{ tweetId, tweetUrl: `https://x.com/alice/status/${tweetId}`, authorHandle: "alice", text, directedToOwn: true, notificationKind: "direct", alreadyLiked: false, promoted: false }] });
      } else emit({ type: m.type === "x_scroll_burst" ? "x_scroll_result" : `${m.type}_result`, requestId: m.requestId, ok: true, tweetText: text, notificationKind: "direct" });
    } };
  attachXPort(port as unknown as chrome.runtime.Port, "notification-auto");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: "Which part of the release would you like more detail on?" }, finish_reason: "stop" }] }));
  const settings = createDefaultAgentSettings();
  settings.priority = "browse_only"; settings.ownHandle = "owner"; settings.adaptiveRest = false;
  settings.humanize.replyPct = 0;
  settings.browseWeights = { home: 100, following: 0, lists: 0, mentions: 0 };
  settings.modules = { ...settings.modules, pogoTasks: false, homeScroll: true, followingFeed: false, lists: false, notifications: true };
  settings.actions = { reply: true, like: false, follow: false, retweet: false, quote: false };
  let runtime = createInitialRuntime(), stats = createEmptyDailyStats(), queue: AgentQueueState = { jobs: [] };
  runtime.notificationBatch = observeNotificationBatch(undefined, "owner", 1, Date.now() - 60 * 60000);
  const tick = async () => {
    const result = await runAgentTick({ settings, runtime, stats, queue, extensionId: "notification-auto", appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {}, waitForDelay: async () => {} });
    runtime = result.runtime; stats = result.stats; queue = result.queue;
  };
  for (let i = 0; i < 5 && !queue.jobs.some(j => j.kind === "post_reply"); i++) await tick();
  const post = queue.jobs.find(job => job.kind === "post_reply")!;
  assert.equal(post.autoPost, true);
  assert.ok(!commands.some(command => command.type === "x_scroll_burst"));
  queue = sanitizeQueue(JSON.parse(JSON.stringify(queue)));
  assert.equal(queue.jobs.find(job => job.kind === "post_reply")?.autoPost, true);
  if (disableBeforeSend) settings.executeActions = false;
  await tick();
  assert.equal(commands.filter(command => command.type === "x_reply").length, disableBeforeSend ? 0 : 1);
  assert.equal(stats.reply, disableBeforeSend ? 0 : 1);
  if (!disableBeforeSend) {
    assert.ok(!commands.some(command => command.type === "x_scroll_burst"), "finish the reply before leaving Notifications");
    await tick();
    assert.ok(commands.some(command => command.type === "x_scroll_burst" && command.browseSurface === "home"));
  }
});
