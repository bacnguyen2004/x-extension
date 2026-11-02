import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { createInitialState } from "../src/domain/types.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { planNextAction } from "../src/agent/planner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { setApiSessionToken } from "../src/background/api-session.ts";
import { createEmptyQueue, pruneLockedPogoJobs, makeJob, sanitizeQueue } from "../src/domain/agent-queue.ts";

const id = "2112825901511761984";
const raw = { tweet_id: id, author_handle: "author", text: "A locked campaign", follows_author: false, locked_points: 30, my_interactions: [], earned_points: {} };
const locked = normalizeApiCampaign(raw)!;
function settings() {
  const s = createDefaultAgentSettings(); s.modules.homeScroll = false; s.priority = "pogo_only";
  s.actions = { follow: true, retweet: true, reply: false, like: false, quote: false };
  s.executeActions = true;
  return s;
}

test("Follow toggle permits only the unlock follow for a Locked task, including already-followed cache", () => {
  const s = settings();
  const input = { settings: s, campaigns: [{ ...locked, follows_author: true }], queue: createEmptyQueue(), stats: createEmptyDailyStats(), executeActions: true, ownHandle: null, hasApiKey: false };
  const p = planNextAction(input);
  assert.equal(p.type, "job");
  if (p.type !== "job") return;
  assert.equal(p.job.kind, "follow");
  assert.equal(pruneLockedPogoJobs({ jobs: [p.job] }, [id], true).skipped, 0);
  s.actions.follow = false;
  assert.equal(planNextAction(input).type, "idle");
  s.actions.follow = true;
  const after = planNextAction({ ...input, queue: { jobs: [{ ...p.job, status: "done" as const }] } });
  assert.equal(after.type, "idle", "still locked must not follow/check forever");
});

async function setup(t: TestContext, options: { already?: boolean; token?: boolean; checkFails?: boolean; feedFails?: boolean; unlocked?: boolean; unlockedAfter?: number; missing?: boolean; followFails?: boolean; requested?: boolean; cancel?: boolean } = {}) {
  const disk: Record<string, unknown> = { "pogoTaskReader.state": { ...createInitialState(), campaigns: { [id]: locked }, campaign_order: [id] } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: {
    local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); } },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  await setApiSessionToken(options.token === false ? null : "test-token");
  t.after(async () => { await setApiSessionToken(null); });
  const listeners = new Set<(message: unknown) => void>(), disconnects = new Set<() => void>();
  const commands: string[] = [], requests: string[] = [];
  const emit = (message: object) => { for (const fn of [...listeners]) fn(message); };
  let cancelled = false;
  const port = {
    sender: { id: "unlock-test", url: "https://x.com/home", tab: { id: 96 }, frameId: 0 },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    postMessage(m: { type: string; requestId?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", handle: "me", loggedIn: true, onHome: true }); return; }
      commands.push(m.type);
      if (m.type === "x_follow") emit({ type: "x_follow_result", requestId: m.requestId, ok: !options.followFails, error: options.followFails ? "follow_not_confirmed" : undefined, detail: options.requested ? "follow_requested" : options.already ? "already_following" : "followed" });
      else if (m.type === "x_prepare_tweet") emit({ type: "x_prepare_tweet_result", requestId: m.requestId, ok: true });
      else if (m.type === "x_retweet") emit({ type: "x_retweet_result", requestId: m.requestId, ok: true });
      else throw new Error(`Unexpected X action ${m.type}`);
    }, disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "unlock-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input); requests.push(url);
    if (url.endsWith("/follow-check")) {
      if (options.cancel) cancelled = true;
      return options.checkFails ? new Response("", { status: 401 }) : Response.json({ checked: true, target_followed: true, unlocked_count: 4 });
    }
    if (url.endsWith("/feed")) return options.feedFails ? new Response("", { status: 500 }) : Response.json({ campaigns: options.missing ? [] : [{ ...raw, follows_author: true, locked_points: options.unlocked || (options.unlockedAfter && requests.filter((r) => r.endsWith("/feed")).length >= options.unlockedAfter) ? 0 : 30 }] });
    throw new Error("Unexpected network request");
  });
  const s = settings();
  let queue = createEmptyQueue();
  // Old actions must stay blocked until feed refresh confirms unlock.
  queue.jobs.push(makeJob({ kind: "retweet", source: "pogo", tweetId: id, authorHandle: "author", tweetUrl: locked.tweet_url, tweetText: "post" }));
  let runtime = createInitialRuntime(), stats = createEmptyDailyStats();
  let persisted = queue;
  return { commands, requests, disk, restart() { options.cancel = false; cancelled = false; queue = sanitizeQueue(JSON.parse(JSON.stringify(persisted))); runtime = createInitialRuntime(); }, async tick() {
    const result = await runAgentTick({ settings: s, runtime, stats, queue, extensionId: "unlock-test", isCancelled: () => cancelled,
      waitForDelay: async () => {}, appendActivity: async () => {}, persistQueue: async (q) => { persisted = JSON.parse(JSON.stringify(q)); }, persistStats: async () => {} });
    ({ queue, runtime, stats } = result); return result;
  } };
}

test("unlock waits for delayed Pogo confirmation without repeating Follow", async (t) => {
  const env = await setup(t, { unlockedAfter: 2 });
  const result = await env.tick();
  assert.deepEqual(env.commands, ["x_follow"]);
  assert.equal(env.requests.length, 4);
  assert.equal(result.queue.jobs.find((j) => j.kind === "follow")?.pogoUnlock?.state, "unlocked");
  assert.equal(result.queue.jobs.find((j) => j.kind === "follow")?.pogoUnlock?.attempts, 2);
});

test("pause and serialized restart continue the remaining unlock budget without following again", async (t) => {
  const env = await setup(t, { cancel: true, unlocked: true });
  const interrupted = await env.tick();
  assert.equal(interrupted.nextDelayMs, 0);
  assert.equal(interrupted.queue.jobs.find((j) => j.kind === "follow")?.pogoUnlock?.attempts, 1);
  env.restart();
  const resumed = await env.tick();
  assert.deepEqual(env.commands, ["x_follow"]);
  assert.equal(resumed.queue.jobs.find((j) => j.kind === "follow")?.pogoUnlock?.state, "unlocked");
  assert.equal(resumed.queue.jobs.find((j) => j.kind === "follow")?.pogoUnlock?.attempts, 2);
  await env.tick();
  assert.ok(env.commands.includes("x_retweet"));
});

for (const already of [false, true]) test(`follow then Check then refresh unlock allows task; already-following=${already}`, async (t) => {
  const env = await setup(t, { unlocked: true, already });
  await env.tick();
  assert.deepEqual(env.commands, ["x_follow"]);
  assert.deepEqual(env.requests, ["https://pogo.social/api/me/follow-check", "https://pogo.social/api/feed"]);
  await env.tick();
  assert.ok(env.commands.includes("x_retweet"));
});

for (const options of [{}, { token: false }, { checkFails: true }, { feedFails: true }, { missing: true }, { followFails: true }, { requested: true }, { cancel: true }]) {
  test(`unconfirmed unlock never interacts or loops: ${JSON.stringify(options)}`, async (t) => {
    const env = await setup(t, options);
    await env.tick();
    const result = await env.tick();
    assert.deepEqual(env.commands, ["x_follow"]);
    assert.equal(result.stats.retweet, 0);
    assert.ok(env.requests.length <= 6);
    assert.ok(env.requests.filter((url) => url.endsWith("/follow-check")).length <= 3);
    if ("followFails" in options || "requested" in options || "token" in options) assert.deepEqual(env.requests, []);
  });
}
