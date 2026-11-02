import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { createInitialState, type PersistedState } from "../src/domain/types.ts";
import { makeJob, sanitizeQueue, type AgentQueueState } from "../src/domain/agent-queue.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { setApiSessionToken } from "../src/background/api-session.ts";
import { buildExportPayload } from "../src/domain/export.ts";
import { actionHandled } from "../src/domain/action-progress.ts";
import { observePogoSettlementClock } from "../src/background/pogo-settlement-store.ts";

async function setup(t: TestContext, reply: { ok: boolean; error?: string; detail?: string }, source: "pogo" | "browse" | "manual" = "pogo", kind: "post_reply" | "follow" = "post_reply", prepareDetail?: string) {
  let clock = 1900000000000, recorded = false, retweetRecorded = false, cancelled = false;
  const raw = { tweet_id: "2112825901511761984", author_handle: "author", text: "A post", follows_author: true, locked_points: 0 };
  const campaign = normalizeApiCampaign(raw)!;
  const disk: Record<string, unknown> = { "pogoTaskReader.state": { ...createInitialState(), campaigns: { [campaign.tweet_id]: campaign } } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: {
    local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); } },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  await setApiSessionToken("fake"); t.after(async () => { await setApiSessionToken(null); });
  t.mock.method(Date, "now", () => clock);
  const commands: string[] = [], logs: string[] = [], requests: string[] = [];
  const replyAccounts: Array<string | undefined> = [];
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>();
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  const port = {
    sender: { id: "verification-test", url: "https://x.com/home", tab: { id: 97 }, frameId: 0 },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    postMessage(m: { type: string; requestId?: string; ownHandle?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", loggedIn: true, onHome: true, handle: "me" }); return; }
      commands.push(m.type);
      if (m.type === "x_reply") replyAccounts.push(m.ownHandle);
      if (m.type === "x_scroll_burst") { emit({ type: "x_scroll_result", requestId: m.requestId, ok: true, scrolledPx: 500 }); return; }
      if (m.type === "x_reply" && reply.error === "stopped") cancelled = true;
      emit({ type: `${m.type}_result`, requestId: m.requestId, ...(["x_reply", "x_follow"].includes(m.type) ? reply : { ok: true, ...(m.type === "x_prepare_tweet" ? { detail: prepareDetail } : {}) }) });
    }, disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "verification-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    requests.push(String(input));
    assert.equal(String(input), "https://pogo.social/api/feed");
    return Response.json({ campaigns: [{ ...raw, my_interactions: [...(recorded ? ["reply"] : []), ...(retweetRecorded ? ["retweet"] : [])], earned_points: { ...(recorded ? { reply: 30 } : {}), ...(retweetRecorded ? { retweet: 10 } : {}) } }] });
  });
  const settings = createDefaultAgentSettings(); settings.modules.homeScroll = false; settings.priority = "pogo_only";
  if (source !== "pogo") { settings.modules.pogoTasks = false; settings.modules.homeScroll = source === "browse"; settings.modules.linkList = source === "manual"; settings.priority = "browse_only"; }
  settings.actions = { like: false, retweet: false, follow: false, reply: true, quote: false };
  if (kind === "follow") settings.actions.follow = true;
  let queue: AgentQueueState = { jobs: [makeJob({ kind, tweetId: campaign.tweet_id, authorHandle: "author", tweetUrl: campaign.tweet_url, tweetText: campaign.text, draftText: "A ready reply", source, ...(kind === "follow" ? { error: "navigating_profile" } : {}) })] };
  let runtime = createInitialRuntime(), stats = createEmptyDailyStats();
  return { commands, requests, logs, replyAccounts, state: () => disk["pogoTaskReader.state"] as PersistedState,
    retweet(recordedOnServer = false, verified = false) {
      settings.actions.retweet = true;
      settings.actions.reply = false;
      queue = { jobs: [makeJob({ kind: "retweet", source: "pogo", tweetId: campaign.tweet_id, authorHandle: "author", tweetUrl: campaign.tweet_url, tweetText: campaign.text, error: "navigating",
        ...(verified ? { verification: "pogo_recorded" as const } : {}) })] };
      if (recordedOnServer) campaign.actions.retweet.status = "recorded";
      campaign.actions.reply.status = "recorded";
    },
    goals(afterReached: "pause" | "browse") { settings.dailyTargets = { enabled: true, afterReached, ranges: {
      reply: { min: 1, max: 1 }, like: { min: 0, max: 0 }, follow: { min: 0, max: 0 }, retweet: { min: 0, max: 0 }, quote: { min: 0, max: 0 } } }; },
    clearQueue() { queue = { jobs: [] }; }, record() { recorded = true; }, recordRetweet() { retweetRecorded = true; }, advance(ms = 11000) { clock += ms; },
    ownHandle(handle: string) { settings.ownHandle = handle; },
    legacyIdentityFailure() {
      campaign.actions.reply.local = { state: "uncertain", at: clock, error: "reply_identity_missing" };
      queue.jobs[0] = { ...queue.jobs[0], status: "skipped", error: "reply_identity_missing", verification: "uncertain", pogoVerify: { attempts: 0, submittedAt: clock, nextCheckAt: clock + 1000 } };
    },
    async scanIn(ms: number) { await observePogoSettlementClock("me", clock + ms); },
    addAwaitingRetweet() { queue.jobs.push(makeJob({ kind: "retweet", source: "pogo", status: "done", verification: "submitted", tweetId: campaign.tweet_id,
      tweetUrl: campaign.tweet_url, tweetText: campaign.text, authorHandle: "author", pogoVerify: { attempts: 0, submittedAt: clock, nextCheckAt: clock + 620000 } })); },
    restart() { cancelled = false; queue = sanitizeQueue(JSON.parse(JSON.stringify(queue))); runtime = createInitialRuntime(); },
    async tick() { const result = await runAgentTick({ settings, queue, runtime, stats, extensionId: "verification-test", isCancelled: () => cancelled,
      appendActivity: async (_level, message) => { logs.push(message); }, waitForDelay: async (ms) => { clock += ms; }, persistQueue: async () => {}, persistStats: async () => {} });
      ({ queue, runtime, stats } = result); return result; }
  };
}

test("an existing reply does not leave the current retweet pending on every tick", async (t) => {
  const env = await setup(t, { ok: true }, "pogo", "post_reply", "already_replied");
  env.retweet();
  const result = await env.tick();
  assert.ok(env.commands.includes("x_retweet"), JSON.stringify({ commands: env.commands, logs: env.logs, jobs: result.queue.jobs }));
  assert.notEqual(result.queue.jobs.find(job => job.kind === "retweet")?.status, "pending");
});

for (const verified of [false, true]) test(`server-recorded retweet clears pending work (previously verified: ${verified})`, async (t) => {
  const env = await setup(t, { ok: true });
  env.retweet(true, verified);
  const result = await env.tick();
  const retweet = result.queue.jobs.find(job => job.kind === "retweet")!;
  assert.equal(retweet.status, "skipped");
  assert.equal(retweet.verification, "pogo_recorded");
  assert.deepEqual(env.commands, []);
  await env.tick();
  assert.deepEqual(env.commands, []);
});

test("reaching the daily Reply target waits for the next day before another action or network request", async (t) => {
  const env = await setup(t, { ok: true, detail: "reply_confirmed" }, "browse");
  env.goals("pause");
  const first = await env.tick(); assert.equal(first.stats.reply, 1);
  const commandCount = env.commands.length;
  const stopped = await env.tick();
  assert.equal(stopped.runtime.status, "waiting"); assert.ok(stopped.nextDelayMs > 0);
  assert.equal(env.commands.length, commandCount); assert.deepEqual(env.requests, []);
});

test("browse after reaching all daily goals scrolls without another interaction", async (t) => {
  const env = await setup(t, { ok: true, detail: "reply_confirmed" }, "browse");
  env.goals("browse");
  await env.tick();
  const before = env.commands.length;
  const result = await env.tick();
  assert.equal(result.stats.reply, 1);
  assert.deepEqual(env.commands.slice(before), ["x_scroll_burst"]);
  assert.deepEqual(env.requests, []);
});

for (const source of ["browse", "manual"] as const) test(`${source} reply reports only X results and never mutates or verifies Pogo`, async (t) => {
  const env = await setup(t, { ok: true, detail: "reply_confirmed" }, source);
  const before = JSON.stringify(env.state());
  const result = await env.tick();
  assert.match(result.runtime.detail, /Đã gửi reply trên X/);
  assert.doesNotMatch(result.runtime.detail, /Pogo/);
  assert.ok(env.logs.every((line) => !line.includes("chờ Pogo")));
  assert.equal(result.queue.jobs[0].verification, "x_confirmed");
  assert.equal(result.queue.jobs[0].pogoVerify, undefined);
  assert.deepEqual(env.requests, []);
  assert.equal(JSON.stringify(env.state()), before);
});

test("a Pogo receipt for the same tweet cannot relabel or suppress a pending Home reply", async (t) => {
  const env = await setup(t, { ok: true, detail: "reply_confirmed" }, "browse");
  Object.values(env.state().campaigns)[0].actions.reply = { status: "recorded", recordedBy: "pogo", displayedPoints: 30 };
  const result = await env.tick();
  assert.ok(env.commands.includes("x_reply"));
  assert.equal(result.queue.jobs[0].verification, "x_confirmed");
  assert.doesNotMatch(result.runtime.detail, /Pogo/);
});

for (const detail of ["follow_confirmed", "already_following"]) test(`Home ${detail} never calls Pogo Check now`, async (t) => {
  const env = await setup(t, { ok: true, detail }, "browse", "follow");
  const result = await env.tick();
  assert.ok(env.commands.includes("x_follow"));
  assert.deepEqual(env.requests, []);
  assert.equal(result.queue.jobs[0].pogoUnlock, undefined);
});

test("reply does not schedule verification; a separate feed refresh can still report Pogo points", async (t) => {
  const env = await setup(t, { ok: true, detail: "reply_confirmed" });
  const sent = await env.tick();
  const action = Object.values(env.state().campaigns)[0].actions.reply;
  assert.equal(action.status, "not_recorded"); assert.equal(action.local?.state, "confirmed"); assert.equal(actionHandled(action), true);
  assert.deepEqual(buildExportPayload(env.state()).campaigns[0].my_interactions, []);
  assert.deepEqual(buildExportPayload(env.state()).campaigns[0].earned_points, {});
  assert.equal(sent.queue.jobs[0].verification, "x_confirmed");
  assert.equal(sent.queue.jobs[0].pogoVerify, undefined);
  env.addAwaitingRetweet();
  env.record(); env.advance(621000);
  await env.tick();
  const verified = await env.tick();
  assert.equal(verified.queue.jobs[0].pogoVerify, undefined);
  assert.equal(buildExportPayload(env.state()).campaigns[0].earned_points.reply, 30);
  assert.equal(env.commands.filter((c) => c === "x_reply").length, 1);
  assert.equal(verified.queue.jobs[0].status, "done");
});

test("blocked reply never becomes recorded, remains blocked after clearing queue", async (t) => {
  const env = await setup(t, { ok: false, error: "reply_restricted" });
  const result = await env.tick();
  const action = Object.values(env.state().campaigns)[0].actions.reply;
  assert.equal(action.status, "not_recorded"); assert.equal(action.local?.state, "blocked"); assert.equal(result.stats.reply, 0);
  assert.deepEqual(buildExportPayload(env.state()).campaigns[0].earned_points, {});
  env.clearQueue(); await env.tick();
  assert.equal(env.commands.filter((c) => c === "x_reply").length, 1);
});

for (const error of ["port_closed", "reply_submission_uncertain", "stopped"]) test(`uncertain ${error} never resends or schedules reply verification`, async (t) => {
  const env = await setup(t, { ok: false, error });
  const result = await env.tick();
  assert.equal(result.queue.jobs[0].verification, "uncertain"); assert.equal(result.stats.reply, 0);
  env.restart();
  for (let i = 0; i < 5; i++) { env.advance(); await env.tick(); }
  assert.equal(env.requests.length, 0, "do not verify seconds after submission");
  for (let cycle = 0; cycle < 4; cycle++) { env.advance(621000); await env.tick(); }
  assert.equal(env.requests.length, 0, "reply must not poll Pogo for verification");
  assert.equal(result.queue.jobs[0].pogoVerify, undefined);
  assert.equal(env.commands.filter((c) => c === "x_reply").length, 1);
  assert.equal(Object.values(env.state().campaigns)[0].actions.reply.status, "not_recorded");
});

test("API polling scan boundary plus grace controls verification, including when the countdown rolls forward", async t => {
 const env = await setup(t, { ok: true, detail: "reply_confirmed" });
 env.retweet();
 await env.scanIn(160000);
 const result = await env.tick();
 assert.equal(result.queue.jobs[0].pogoVerify!.nextCheckAt - result.queue.jobs[0].pogoVerify!.submittedAt!, 180000);
 env.advance(160000);
 await env.scanIn(600000); // API polling already shows the NEXT scan before this scan's grace expires.
 await env.tick();
 assert.equal(env.requests.length, 0);
 env.recordRetweet(); env.advance(20001);
 const checked = await env.tick();
 assert.equal(env.requests.length, 1);
 assert.equal(checked.queue.jobs[0].verification, "pogo_recorded");
 assert.equal(env.commands.filter(c => c === "x_retweet").length, 1);
});

test("one feed request reconciles all due jobs and leaves unrecorded actions for the next cycle", async t => {
 const env = await setup(t, { ok: true, detail: "reply_confirmed" });
 await env.scanIn(160000);
 await env.tick();
 env.addAwaitingRetweet(); env.record(); env.advance(180001);
 await env.tick();
 const checked = await env.tick();
 assert.equal(env.requests.length, 1);
 assert.equal(checked.queue.jobs.find(j => j.kind === "post_reply")!.pogoVerify, undefined);
 assert.equal(buildExportPayload(env.state()).campaigns[0].earned_points.reply, 30);
 const retweet = checked.queue.jobs.find(j => j.kind === "retweet")!;
 assert.equal(retweet.verification, "submitted");
 assert.equal(retweet.pogoVerify!.attempts, 1);
 assert.ok(retweet.pogoVerify!.nextCheckAt > retweet.updatedAt + 500000);
 env.advance(); await env.tick();
 assert.equal(env.requests.length, 1);
 assert.equal(env.commands.filter(c => c === "x_retweet").length, 0);
});

test("a legacy identity failure is retried instead of permanently suppressing the reply", async t => {
  const env = await setup(t, { ok: true, detail: "reply_submitted" });
  env.ownHandle("me");
  env.legacyIdentityFailure();
  const result = await env.tick();
  assert.equal(env.commands.filter(c => c === "x_reply").length, 1);
  assert.equal(result.queue.jobs[0].status, "done");
  assert.deepEqual(env.replyAccounts, ["me"]);
  assert.equal(result.queue.jobs[0].pogoVerify, undefined);
  assert.equal(Object.values(env.state().campaigns)[0].actions.reply.local?.state, "submitted");
});

test("identity failure before Post is a send error and does not record a completed attempt", async t => {
  const env = await setup(t, { ok: false, error: "reply_identity_missing" });
  const result = await env.tick();
  assert.equal(result.queue.jobs[0].status, "failed");
  assert.equal(result.queue.jobs[0].verification, undefined);
  assert.equal(result.queue.jobs[0].pogoVerify, undefined);
  assert.equal(Object.values(env.state().campaigns)[0].actions.reply.local, undefined);
  assert.equal(result.stats.reply, 0);
});
