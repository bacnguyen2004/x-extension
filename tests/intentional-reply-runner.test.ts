import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";
import { makeJob } from "../src/domain/agent-queue.ts";

for (const rejected of [false, true]) test(`manual link draft and post fallback ${rejected ? "reject invalid output without another call" : "each generate a valid reply in one call"}`, async t => {
  const disk: Record<string, unknown> = { "pogoTaskReader.aiSettings.v1": { ...createDefaultAiSettings(), apiKey: "fake-key" } };
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: { id: "intent-test", sendMessage: async () => {} }, storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, structuredClone(patch)); } } } } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(m: any) => void>(), disconnects = new Set<() => void>();
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  const commands: any[] = [];
  const port = { sender: { id: "intent-test", url: "https://x.com/home", frameId: 0, tab: { id: 143 } }, onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) }, onDisconnect: { addListener: (fn: any) => disconnects.add(fn), removeListener: (fn: any) => disconnects.delete(fn) }, disconnect() {}, postMessage(m: any) {
    commands.push(m);
    if (m.type === "x_ping") emit({ type: "x_hello", handle: "owner", onHome: true });
    if (m.type === "x_prepare_tweet") emit({ type: "x_prepare_tweet_result", requestId: m.requestId, ok: true });
    if (m.type === "x_reply") emit({ type: "x_reply_result", requestId: m.requestId, ok: true, detail: "reply_confirmed" });
  } };
  attachXPort(port as any, "intent-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  const settings = createDefaultAgentSettings();
  settings.ownHandle = "owner"; settings.executeActions = true; settings.adaptiveRest = false;
  settings.modules = { ...settings.modules, pogoTasks: false, linkList: true, homeScroll: false, followingFeed: false, lists: false, notifications: false };
  settings.actions = { reply: true, like: false, quote: false, follow: false, retweet: false };
  const good = "Reducing withdrawal fees to $1 makes small transfers cheaper. Is that permanent or a temporary subsidy?";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.match(body.messages[0].content, /EXPLICIT REPLY REQUEST/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: (calls++, rejected ? "SKIP_REPLY" : good) } }] });
  });
  for (const kind of ["draft_reply", "post_reply"] as const) {
    const tweetId = kind === "draft_reply" ? "2112057695247180169" : "2112057695247180170";
    const job = makeJob({ kind, source: "manual", tweetId, tweetUrl: `https://x.com/alice/status/${tweetId}`, tweetText: "Withdrawal fees are now $1 instead of $5.", authorHandle: "alice", error: "navigating_tweet", draftText: kind === "post_reply" ? "SKIP_REPLY" : null });
    const paired = rejected && kind === "draft_reply" ? makeJob({ kind: "post_reply", source: "manual", tweetId, tweetUrl: job.tweetUrl, tweetText: job.tweetText, authorHandle: "alice" }) : null;
    const result = await runAgentTick({ settings, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: paired ? [job, paired] : [job] }, extensionId: "intent-test", appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {}, waitForDelay: async () => {} });
    const finished = result.queue.jobs.find(j => j.id === job.id)!;
    assert.equal(finished.status, rejected ? "skipped" : "done", JSON.stringify({ kind, job: finished, runtime: result.runtime.detail, commands: commands.map(m => m.type) }));
    if (!rejected) assert.equal(finished.draftText, good);
    assert.notEqual(finished.error, "skip_reply");
    assert.notEqual(result.runtime.status, "paused");
    if (paired) assert.equal(result.queue.jobs.find(j => j.id === paired.id)?.status, "skipped", "paired post cannot regenerate a rejected draft");
  }
  assert.equal(calls, 2);
  assert.equal(commands.filter(m => m.type === "x_reply").length, rejected ? 0 : 1);
  if (!rejected) assert.equal(commands.find(m => m.type === "x_reply").text, good);
});
