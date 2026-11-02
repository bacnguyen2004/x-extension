import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { readCampaignLock, isCampaignLocked } from "../src/domain/campaign-lock.ts";
import { applyScan, filterCampaigns } from "../src/domain/merge.ts";
import { buildExportPayload } from "../src/domain/export.ts";
import { createInitialState, type Campaign } from "../src/domain/types.ts";
import { buildCampaignJobs, planNextAction } from "../src/agent/planner.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";
import { createEmptyQueue, makeJob, pruneLockedPogoJobs, type AgentJob, type AgentJobKind } from "../src/domain/agent-queue.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { runAgentTick } from "../src/background/agent-runner.ts";

const lockedId = "2112825901511761984";
const openId = "2112820001455435949";
function campaign(locked = true): Campaign {
  return normalizeApiCampaign({
    tweet_id: locked ? lockedId : openId, author_handle: locked ? "Lifeofnopanic" : "PromptFi_AI",
    tweet_url: `https://x.com/${locked ? "Lifeofnopanic" : "PromptFi_AI"}/status/${locked ? lockedId : openId}`,
    text: "A campaign from the Pogo feed.", follows_author: !locked, locked_points: locked ? 30 : 0,
    my_interactions: [], earned_points: {},
  })!;
}
function job(kind: AgentJobKind, status: AgentJob["status"] = "pending", source: AgentJob["source"] = "pogo") {
  const c = campaign();
  return makeJob({ kind, status, source, tweetId: c.tweet_id, authorHandle: c.author_handle,
    tweetUrl: c.tweet_url, tweetText: c.text, draftText: kind === "post_reply" || kind === "draft_reply" ? "An existing draft" : null,
    error: status === "pending" ? "navigating_tweet" : null });
}
function plan(campaigns: Campaign[], jobs: AgentJob[] = []) {
  const settings = createDefaultAgentSettings();
  settings.actions.follow = false;
  settings.modules.homeScroll = false;
  settings.priority = "pogo_only";
  return planNextAction({ settings, campaigns, queue: { jobs }, stats: createEmptyDailyStats(), executeActions: true, ownHandle: null, hasApiKey: true });
}

test("Pogo locked_points and legacy follow gates preserve earning eligibility", () => {
  assert.equal(campaign().locked_points, 30);
  assert.equal(isCampaignLocked(campaign()), true);
  assert.equal(isCampaignLocked(campaign(false)), false);
  assert.equal(readCampaignLock({ follows_author: true, locked_points: 30 }).locked, true);
  assert.equal(readCampaignLock({ follows_author: false, locked_points: 0 }).locked, false);
  assert.equal(readCampaignLock({ follows_author: false }).locked, true, "legacy cache must not resume work without checking the gate");
  assert.equal(readCampaignLock({ locked_points: "30" }).locked, true);
  assert.equal(readCampaignLock({ locked: true, locked_points: 0 }).locked, true);
});


test("fresh Pogo lock overrides locally recorded follow; unlock refresh changes eligibility", () => {
  const previous = { ...campaign(), follows_author: true, locked: false, locked_points: 0 };
  const state = { ...createInitialState(), campaigns: { [lockedId]: previous } };
  const snapshot = { campaigns: [campaign()], scanned_at: 2, frame_url: "https://pogo.social/api/feed", feed_present: true, login_required: false, linked_account: null };
  const locked = applyScan(state, snapshot);
  assert.equal(locked.campaigns[lockedId].follows_author, true, "keep local progress");
  assert.equal(isCampaignLocked(locked.campaigns[lockedId]), true, "but keep the server gate too");
  assert.equal(locked.last_data_change_at, 2);
  assert.equal(filterCampaigns(Object.values(locked.campaigns), "todo", "").length, 0);
  assert.equal(filterCampaigns(Object.values(locked.campaigns), "all", "").length, 1);
  assert.equal(buildExportPayload(locked).campaigns[0].locked_points, 30);
  const open = applyScan(locked, { ...snapshot, scanned_at: 3, campaigns: [{ ...campaign(), follows_author: true, locked: false, locked_points: 0 }] });
  assert.equal(isCampaignLocked(open.campaigns[lockedId]), false);
  assert.equal(open.last_data_change_at, 3);
  assert.equal(filterCampaigns(Object.values(open.campaigns), "todo", "").length, 1);
});

test("planner skips new Locked campaigns and selects an unlocked campaign instead", () => {
  const settings = createDefaultAgentSettings(); settings.actions.follow = false;
  assert.deepEqual(buildCampaignJobs({ campaign: campaign(), settings, queue: createEmptyQueue(), executeActions: true, hasApiKey: true }), []);
  const planned = plan([campaign(), campaign(false)]);
  assert.notEqual(planned.type, "idle");
  const jobs = planned.type === "bundle" ? planned.jobs : planned.type === "job" ? [planned.job] : [];
  assert.ok(jobs.length);
  assert.ok(jobs.every((j) => j.tweetId === openId));
});

test("Locked campaigns cannot resume navigation or publish previously generated drafts", () => {
  const queued = [job("follow"), job("post_reply"), job("draft_reply", "done")];
  const planned = plan([campaign()], queued);
  assert.deepEqual(planned, { type: "idle", reason: "pogo_tasks_locked_wait_for_unlock" });
  const mixed = [...queued, job("retweet", "running"), job("like", "done"), job("follow", "pending", "manual")];
  const pruned = pruneLockedPogoJobs({ jobs: mixed }, [lockedId]);
  assert.equal(pruned.skipped, 3);
  assert.equal(pruned.queue.jobs.filter((j) => j.error === "campaign_locked").length, 3);
  assert.equal(pruned.queue.jobs.find((j) => j.kind === "like")!.status, "done");
  assert.equal(pruned.queue.jobs.find((j) => j.source === "manual")!.status, "pending");
});

test("a confirmed unlock permits work skipped only because it was Locked", () => {
  const pruned = pruneLockedPogoJobs({ jobs: [job("post_reply"), job("draft_reply", "done")] }, [lockedId]);
  const unlocked = { ...campaign(), follows_author: true, locked: false, locked_points: 0 };
  const planned = plan([unlocked], pruned.queue.jobs);
  assert.notEqual(planned.type, "idle");
  const jobs = planned.type === "bundle" ? planned.jobs : planned.type === "job" ? [planned.job] : [];
  assert.ok(jobs.some((j) => j.kind === "post_reply" && j.draftText === "An existing draft"));
});

function runtimeSetup(t: TestContext, initial: Campaign) {
  const state = { ...createInitialState(), campaigns: { [initial.tweet_id]: initial } };
  const disk: Record<string, unknown> = { "pogoTaskReader.state": state, "pogoTaskReader.aiSettings.v1": { ...createDefaultAiSettings(), apiKey: "fake-key" } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); },
  } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(message: unknown) => void>(), disconnects = new Set<() => void>();
  const commands: string[] = [];
  const emit = (message: object) => { for (const fn of [...listeners]) fn(message); };
  const port = {
    sender: { id: "locked-test", url: "https://x.com/home", tab: { id: 95 }, frameId: 0 },
    onMessage: { addListener: (fn: (message: unknown) => void) => listeners.add(fn), removeListener: (fn: (message: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    postMessage(message: { type: string; requestId?: string }) {
      if (message.type === "x_ping") { emit({ type: "x_hello", loggedIn: true, onHome: true }); return; }
      commands.push(message.type);
      if (message.type === "x_prepare_tweet") {
        // Pogo refreshes while the selected post is being opened/read.
        state.campaigns[initial.tweet_id] = { ...initial, locked: true, locked_points: 30 };
        emit({ type: "x_prepare_tweet_result", requestId: message.requestId, ok: true });
      } else throw new Error(`Locked campaign reached an action: ${message.type}`);
    }, disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "locked-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Locked task must not consume AI/API requests"); });
  const settings = createDefaultAgentSettings(); settings.modules.homeScroll = false; settings.priority = "pogo_only";
  settings.actions.follow = false;
  return { settings, commands, async run(jobs: AgentJob[]) {
    return runAgentTick({ settings, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs }, extensionId: "locked-test",
      appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {} });
  } };
}

test("runner removes old Locked work before any X or AI request", async (t) => {
  const env = runtimeSetup(t, campaign());
  const result = await env.run([job("post_reply"), job("retweet", "running"), job("draft_reply", "done")]);
  assert.deepEqual(env.commands, []);
  assert.ok(result.queue.jobs.filter((j) => j.status !== "done").every((j) => j.error === "campaign_locked"));
  assert.equal(result.stats.reply, 0);
});

test("runner rechecks eligibility after reading so a newly Locked task cannot be posted", async (t) => {
  const open = { ...campaign(), locked: false, locked_points: 0, follows_author: true };
  const env = runtimeSetup(t, open);
  env.settings.actions = { like: false, reply: true, retweet: false, follow: false, quote: false };
  const result = await env.run([job("post_reply"), job("draft_reply", "done")]);
  assert.deepEqual(env.commands, ["x_prepare_tweet"]);
  assert.equal(result.queue.jobs.find((j) => j.kind === "post_reply")!.error, "campaign_locked");
  assert.equal(result.stats.reply, 0);
});
