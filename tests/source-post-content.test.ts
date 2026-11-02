import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { saveLinkListFromText } from "../src/background/link-list-store.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";
import { makeJob } from "../src/domain/agent-queue.ts";
import { parseHTML } from "linkedom";
import { handleXCommand, setStopped } from "../src/content/x-commands.ts";

test("preparing a regular status returns its text without requiring Mentions mode", async t => {
  const tweetId = "2112057695247180183";
  const text = "Withdrawal fees are now $1 instead of $5.";
  const { document, window } = parseHTML(`<article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a></div><a href="/alice/status/${tweetId}"><time></time></a><div data-testid="tweetText">${text}</div></article>`);
  for (const [key, value] of Object.entries({ document, window, location: { href: `https://x.com/alice/status/${tweetId}`, pathname: `/alice/status/${tweetId}` } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms = 0) => { if (ms <= 8000) queueMicrotask(fn); return 1 as unknown as NodeJS.Timeout; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.after(() => setStopped(true));
  const results: Record<string, unknown>[] = [];
  await handleXCommand({ postMessage: result => results.push(result as Record<string, unknown>) }, { type: "x_prepare_tweet", requestId: "read-test", tweetId, tweetUrl: `https://x.com/alice/status/${tweetId}` });
  const result = results.find(result => result.type === "x_prepare_tweet_result")!;
  assert.equal(result.ok, true);
  assert.equal(result.tweetText, text);
  assert.equal(result.requestId, "read-test");
});

for (const mode of ["single", "bundle"] as const) test(`list link ${mode} sends the text read on X to AI`, async t => {
  const disk: Record<string, unknown> = { "pogoTaskReader.aiSettings.v1": { ...createDefaultAiSettings(), apiKey: "test-key" } };
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: { id: "source-text-test", sendMessage: async () => {} }, storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, structuredClone(patch)); } } } } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const tweetId = mode === "single" ? "2112057695247180180" : "2112057695247180181";
  const tweetUrl = `https://x.com/alice/status/${tweetId}`;
  await saveLinkListFromText(tweetUrl);
  const listeners = new Set<(message: unknown) => void>(), disconnects = new Set<() => void>();
  const emit = (message: object) => { for (const listener of [...listeners]) listener(message); };
  const text = "Withdrawal fees are now $1 instead of $5.";
  const port = { sender: { id: "source-text-test", url: "https://x.com/home", frameId: 0, tab: { id: 198 } },
    onMessage: { addListener: (fn: (message: unknown) => void) => listeners.add(fn), removeListener: (fn: (message: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) }, disconnect() {},
    postMessage(m: { type: string; requestId?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", handle: "owner", onHome: true }); return; }
      emit({ type: `${m.type}_result`, requestId: m.requestId, ok: true, ...(m.type === "x_prepare_tweet" ? { tweetText: text } : {}) });
    } };
  attachXPort(port as unknown as chrome.runtime.Port, "source-text-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  let prompts = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.ok(body.messages.some((message: { content: string }) => message.content.includes(text)), "AI must receive the actual post text");
    prompts++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "A $1 withdrawal fee makes small transfers cheaper. Will that rate remain permanent?" } }] });
  });
  const settings = createDefaultAgentSettings();
  settings.ownHandle = "owner"; settings.adaptiveRest = false;
  settings.modules = { ...settings.modules, pogoTasks: false, linkList: true, homeScroll: false, followingFeed: false, lists: false, notifications: false };
  settings.actions = { like: false, reply: true, quote: false, follow: false, retweet: false };
  const jobs = mode === "single" ? [makeJob({ kind: "draft_reply", source: "manual", tweetId, tweetUrl, tweetText: null, authorHandle: "alice", error: "navigating_tweet" })] : [];
  const result = await runAgentTick({ settings, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs }, extensionId: "source-text-test", appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {}, waitForDelay: async () => {} });
  assert.ok(prompts > 0, JSON.stringify(result.runtime));
  assert.ok(result.queue.jobs.some(job => job.kind === "draft_reply" && job.status === "done" && job.tweetText === text));
});
