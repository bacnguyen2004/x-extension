import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";
import { createInitialState } from "../src/domain/types.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { readingDuration, readTweet } from "../src/x/reading.ts";
import { parseHTML } from "linkedom";
import { beginAction, stopActions, ActionStoppedError } from "../src/x/action-control.ts";
import { planNextAction } from "../src/agent/planner.ts";

async function runScenario(t: TestContext, cancelInGap: boolean, aiStatus = 200, preparedDetail?: string) {
  let clock = 1900000000000;
  let cancelled = false;
  const tweetId = "2112057695247180169";
  const campaign = normalizeApiCampaign({ tweet_id: tweetId, author_handle: "a", text: "We cut withdrawal fees from $5 to $1.", follows_author: true })!;
  const pogo = { ...createInitialState(), campaigns: { [tweetId]: campaign } };
  const storage: Record<string, unknown> = {
    "pogoTaskReader.state": pogo,
    "pogoTaskReader.aiSettings.v1": { ...createDefaultAiSettings(), apiKey: "fake" },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    storage: { local: {
      async get(key: string) { return { [key]: storage[key] }; },
      async set(values: object) { Object.assign(storage, values); },
    } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "fetch", async () => {
    clock += 1000;
    if (aiStatus !== 200) return Response.json({ error: { code: "unsupported_parameter", param: "temperature", message: "temperature is not supported" } }, { status: aiStatus });
    return Response.json({ choices: [{ message: { content: "Cutting withdrawals to $1 makes smaller transfers less costly. Is that a permanent fee change or a temporary subsidy?" } }] });
  });
  const commands: Array<{ type: string; at: number }> = [];
  const listeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const disconnect = () => { for (const fn of [...disconnectListeners]) fn(); };
  const emit = (message: object) => { for (const listener of [...listeners]) listener(message); };
  const port = {
    sender: { id: "pacing-ext", url: "https://x.com/home", tab: { id: 900 }, frameId: 0 },
    onMessage: { addListener(fn: (message: unknown) => void) { listeners.add(fn); }, removeListener(fn: (message: unknown) => void) { listeners.delete(fn); } },
    onDisconnect: { addListener(fn: () => void) { disconnectListeners.add(fn); }, removeListener(fn: () => void) { disconnectListeners.delete(fn); } },
    postMessage(message: { type: string; requestId?: string }) {
      if (message.type === "x_ping") { emit({ type: "x_hello", handle: "me", loggedIn: true, onHome: true }); return; }
      commands.push({ type: message.type, at: clock });
      assert.notEqual(message.type, "x_tweet_engage", "must use separate action commands");
      clock += message.type === "x_prepare_tweet" ? 12000 : 500;
      emit({ type: `${message.type}_result`, requestId: message.requestId, ok: true,
        ...(message.type === "x_prepare_tweet" && preparedDetail ? { detail: preparedDetail } : {}) });
    },
    disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "pacing-ext");
  t.after(() => disconnect());
  const settings = createDefaultAgentSettings();
  settings.actions.follow = false;
  settings.modules.homeScroll = false;
  settings.priority = "pogo_only";
  settings.activeHoursStart = settings.activeHoursEnd = "00:00";
  const completed: Array<{ kind: string; at: number }> = [];
  const result = await runAgentTick({
    settings, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: [] },
    extensionId: "pacing-ext", appendActivity: async () => {},
    persistQueue: async (queue) => {
      for (const job of queue.jobs) {
        if (job.status === "done" && !completed.some((j) => j.kind === job.kind)) completed.push({ kind: job.kind, at: job.updatedAt });
      }
    },
    persistStats: async () => {},
    isCancelled: () => cancelled,
    waitForDelay: async (ms) => { clock += ms; if (cancelInGap) cancelled = true; },
  });
  return { commands, completed, result, settings, campaign };
}

test("manual reply detected during a fresh Pogo bundle persists skipped jobs and advances even with stale feed", async t => {
  const {result,commands,settings,campaign}=await runScenario(t,false,200,"already_replied");
  for(const kind of ["draft_reply","post_reply"]){
    const saved=result.queue.jobs.find(j=>j.kind===kind&&j.tweetId===campaign.tweet_id);
    assert.equal(saved?.status,"skipped");
    assert.equal(saved?.verification,"x_confirmed");
  }
  assert.ok(!commands.some(c=>c.type==="x_reply"));
  assert.equal(result.stats.reply,0,"an existing manual reply must not count as a new tool reply");
  const nextCampaign=normalizeApiCampaign({tweet_id:"2112057695247180170",author_handle:"b",text:"Next post",follows_author:true})!;
  const next=planNextAction({settings,stats:result.stats,queue:result.queue,campaigns:[campaign,nextCampaign],executeActions:true,hasApiKey:true,ownHandle:"me"});
  const selected=next.type==="bundle"?next.tweetId:next.type==="job"?next.job.tweetId:null;
  assert.equal(selected,nextCampaign.tweet_id);
});

test("bundle reads first, then like/reply/retweet separately with gaps and distinct completion times", async (t) => {
  const { commands, completed, result } = await runScenario(t, false);
  assert.deepEqual(commands.map((c) => c.type), ["x_prepare_tweet", "x_like", "x_reply", "x_retweet"]);
  assert.ok(commands[1].at - commands[0].at >= 12000);
  assert.ok(commands[2].at - commands[1].at >= 6000);
  assert.ok(commands[3].at - commands[2].at >= 6000);
  const physical = completed.filter((c) => ["like", "post_reply", "retweet"].includes(c.kind));
  assert.deepEqual(physical.map((c) => c.kind), ["like", "post_reply", "retweet"]);
  assert.ok(physical[0].at < physical[1].at && physical[1].at < physical[2].at);
  assert.equal(result.stats.like, 1);
  assert.equal(result.stats.reply, 1);
  assert.equal(result.stats.retweet, 1);
});

test("pause during the inter-action delay prevents reply and retweet and preserves the completed like", async (t) => {
  const { commands, completed, result } = await runScenario(t, true);
  assert.deepEqual(commands.map((c) => c.type), ["x_prepare_tweet", "x_like"]);
  assert.equal(result.nextDelayMs, 0);
  assert.ok(completed.some((c) => c.kind === "like"));
  assert.equal(result.stats.reply, 0);
  assert.equal(result.stats.retweet, 0);
});

test("reading time scales with post length and respects minimum and maximum", () => {
  assert.equal(readingDuration("short", 100, 500), 8000);
  assert.equal(readingDuration("word ".repeat(50), 8000, 18000), 12500);
  assert.equal(readingDuration("word ".repeat(1000), 8000, 18000), 18000);
});

test("AI configuration failure pauses the bundle immediately with the root cause", async (t) => {
  const { commands, result } = await runScenario(t, false, 400);
  // Like/check chạy trước draft — AI fail sau khi đã prepare (+ like).
  assert.deepEqual(commands.map((c) => c.type), ["x_prepare_tweet", "x_like"]);
  assert.equal(result.runtime.status, "paused");
  assert.equal(result.nextDelayMs, 0);
  assert.equal(result.runtime.consecutiveErrors, 1);
  const draft = result.queue.jobs.find((j) => j.kind === "draft_reply");
  assert.equal(draft?.status, "failed");
  assert.ok(draft?.error?.includes("http_400"));
  assert.ok(draft?.error?.includes("temperature"));
  assert.equal(result.stats.reply, 0);
});

test("stop during reading prevents scrolling to the action controls", async (t) => {
  const { document } = parseHTML('<html><body><article data-testid="tweet"><a href="/a/status/111"></a><div data-testid="tweetText">Post</div><button data-testid="reply"></button></article></body></html>');
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => original ? Object.defineProperty(globalThis, "document", original) : Reflect.deleteProperty(globalThis, "document"));
  let actionScrolls = 0;
  document.querySelector("button")!.scrollIntoView = () => { actionScrolls++; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  beginAction();
  const read = readTweet("111", 8000, 18000);
  stopActions();
  t.mock.timers.tick(800);
  await assert.rejects(read, ActionStoppedError);
  assert.equal(actionScrolls, 0);
});
