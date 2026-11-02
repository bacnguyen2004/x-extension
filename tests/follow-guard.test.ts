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

async function setup(t: TestContext, reply: { ok: boolean; error?: string; detail?: string }, source: "pogo" | "browse" | "manual" = "pogo", kind: "post_reply" | "follow" = "post_reply") {
  let clock = 1900000000000, recorded = false, cancelled = false; let gateMode = "";
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
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>();
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  const port = {
    sender: { id: "verification-test", url: "https://x.com/home", tab: { id: 97 }, frameId: 0 },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    postMessage(m: { type: string; requestId?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", loggedIn: true, onHome: true, handle: "me" }); return; }
      commands.push(m.type);
      if(m.type === "x_follow_profile_meta") {
        if(gateMode === "cancel") cancelled = true;
        emit({type:"x_follow_profile_meta_result",requestId:m.requestId,...(gateMode === "meta_error" ? {ok:false,error:"busy"} : {ok:true,meta:{verified:gateMode === "verified",alreadyFollowing:false,onProfile:true,hasFollowButton:gateMode !== "loading"}})});
        return;
      }
      if (m.type === "x_scroll_burst") { emit({ type: "x_scroll_result", requestId: m.requestId, ok: true, scrolledPx: 500 }); return; }
      if (m.type === "x_reply" && reply.error === "stopped") cancelled = true;
      emit({ type: `${m.type}_result`, requestId: m.requestId, ...(["x_reply", "x_follow"].includes(m.type) ? reply : { ok: true }) });
    }, disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "verification-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    requests.push(String(input));
    assert.equal(String(input), "https://pogo.social/api/feed");
    return Response.json({ campaigns: [{ ...raw, my_interactions: recorded ? ["reply"] : [], earned_points: recorded ? { reply: 30 } : {} }] });
  });
  const settings = createDefaultAgentSettings(); settings.modules.homeScroll = false; settings.priority = "pogo_only";
  if (source !== "pogo") { settings.modules.pogoTasks = false; settings.modules.homeScroll = source === "browse"; settings.modules.linkList = source === "manual"; settings.priority = "browse_only"; }
  settings.actions = { like: false, retweet: false, follow: false, reply: true, quote: false };
  if (kind === "follow") settings.actions.follow = true;
  let queue: AgentQueueState = { jobs: [makeJob({ kind, tweetId: campaign.tweet_id, authorHandle: "author", tweetUrl: campaign.tweet_url, tweetText: campaign.text, draftText: "A ready reply", source, ...(kind === "follow" ? { error: "navigating_profile" } : {}) })] };
  let runtime = createInitialRuntime(), stats = createEmptyDailyStats();
  return { commands, requests, logs,
    gate(mode: string) { gateMode = mode; settings.modules.following = true;
      disk["xContentCreator.follow.v1"] = {filters:{verified:"exclude",allowMissingSorsa:true}};
      disk["xContentCreator.sorsaCache.v1"] = {author:{score:500,at:Date.now()}};
    }, state: () => disk["pogoTaskReader.state"] as PersistedState,
    goals(afterReached: "pause" | "browse") { settings.dailyTargets = { enabled: true, afterReached, ranges: {
      reply: { min: 1, max: 1 }, like: { min: 0, max: 0 }, follow: { min: 0, max: 0 }, retweet: { min: 0, max: 0 }, quote: { min: 0, max: 0 } } }; },
    clearQueue() { queue = { jobs: [] }; }, record() { recorded = true; }, advance(ms = 11000) { clock += ms; },
    restart() { cancelled = false; queue = sanitizeQueue(JSON.parse(JSON.stringify(queue))); runtime = createInitialRuntime(); },
    async tick() { const result = await runAgentTick({ settings, queue, runtime, stats, extensionId: "verification-test", isCancelled: () => cancelled,
      appendActivity: async (_level, message) => { logs.push(message); }, waitForDelay: async (ms) => { clock += ms; }, persistQueue: async () => {}, persistStats: async () => {} });
      ({ queue, runtime, stats } = result); return result; }
  };
}

for (const mode of ["cancel", "meta_error", "loading", "verified"]) test(`Follow guard: ${mode} must prevent Follow`, async t => {
 const env = await setup(t, {ok:true,detail:"follow_confirmed"}, "browse", "follow");
 env.gate(mode); const result = await env.tick();
 assert.equal(env.commands.includes("x_follow"),false,JSON.stringify(env.commands));
 if (mode === "cancel") assert.equal(result.queue.jobs[0].status, "pending");
});

test("Follow guard permits a loaded profile matching the filters", async t => {
 const env = await setup(t, {ok:true,detail:"follow_confirmed"}, "browse", "follow");
 env.gate("valid"); const result = await env.tick();
 assert.equal(env.commands.includes("x_follow"),true);
 assert.equal(result.stats.follow,1);
});
