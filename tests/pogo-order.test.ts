import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { applyScan, campaignList, clearCampaignCache, prioritizeBoosted } from "../src/domain/merge.ts";
import { createInitialState, type Campaign, type ScanSnapshot } from "../src/domain/types.ts";
import { createDefaultAgentSettings, createEmptyDailyStats } from "../src/domain/agent-settings.ts";
import { makeJob, type AgentJob } from "../src/domain/agent-queue.ts";
import { planNextAction } from "../src/agent/planner.ts";
import { loadPogoCampaigns } from "../src/background/pogo-state-access.ts";

const campaign = (id: string) => normalizeApiCampaign({ tweet_id: id, author_handle: "author", text: "A post", follows_author: true, locked_points: 0, my_interactions: [], earned_points: {} })!;
const scan = (campaigns: Campaign[], at: number): ScanSnapshot => ({ campaigns, scanned_at: at, frame_url: "https://pogo.test", feed_present: true, login_required: false, linked_account: null });
const job = (c: Campaign, kind: AgentJob["kind"], status: AgentJob["status"]) => makeJob({ kind, status, source: "pogo", tweetId: c.tweet_id, authorHandle: c.author_handle, tweetUrl: c.tweet_url, tweetText: c.text, draftText: "A ready reply" });
function plan(campaigns: Campaign[], jobs: AgentJob[] = []) {
  const settings = createDefaultAgentSettings();
  settings.actions.follow = false;
  settings.modules.homeScroll = false;
  settings.priority = "pogo_only";
  return planNextAction({ settings, campaigns, queue: { jobs }, stats: createEmptyDailyStats(), executeActions: true, ownHandle: null, hasApiKey: true });
}
function selected(result: ReturnType<typeof plan>) {
  return result.type === "bundle" ? result.tweetId : result.type === "job" ? result.job.tweetId : null;
}

test("latest feed order survives cache updates and reload, including numeric object keys", async (t) => {
  const a = campaign("12345678"), b = campaign("54321678"), c = campaign("33333678");
  let state = applyScan(createInitialState(), scan([a, b, c], 1));
  state = applyScan(state, scan([b, a], 2));
  assert.deepEqual(campaignList(state).map((c) => c.tweet_id), [b.tweet_id, a.tweet_id, c.tweet_id]);
  assert.equal(state.campaigns[c.tweet_id].stale, true);
  const saved = JSON.parse(JSON.stringify(state));
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get: async (key: string) => ({ [key]: saved }) } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  assert.deepEqual((await loadPogoCampaigns()).map((c) => c.tweet_id), [b.tweet_id, a.tweet_id, c.tweet_id]);
  assert.equal(selected(plan(await loadPogoCampaigns())), b.tweet_id);
  assert.deepEqual(clearCampaignCache(state).campaign_order, []);
});

test("Pogo picks the first eligible task before lower ready drafts or previously touched tasks", () => {
  const top = campaign("12345678"), lower = campaign("54321678");
  assert.equal(selected(plan([top, lower], [job(lower, "draft_reply", "done")])), top.tweet_id);
  assert.equal(selected(plan([top, lower], [job(lower, "post_reply", "pending")])), top.tweet_id);
  assert.equal(selected(plan([top, lower], [job(lower, "like", "done")])), top.tweet_id);
  assert.equal(selected(plan([{ ...top, locked: true, locked_points: 30 }, lower])), lower.tweet_id);
  assert.equal(selected(plan([{ ...top, stale: true }, lower])), lower.tweet_id);
});

test("the top task uses its own draft even when a lower draft is newer in the queue", () => {
  const top = campaign("12345678"), lower = campaign("54321678");
  const result = plan([top, lower], [job(lower, "draft_reply", "done"), job(top, "draft_reply", "done")]);
  assert.equal(selected(result), top.tweet_id);
});

test("Boosted leads the displayed list and planning while preserving feed order within groups", () => {
  const a = campaign("12345678"), b = { ...campaign("54321678"), boosted: true };
  const c = campaign("33333678"), d = { ...campaign("44444678"), boosted: true };
  const feed = [a, b, c, d];
  const state = applyScan(createInitialState(), scan(feed, 1));
  assert.deepEqual(campaignList(state).map((c) => c.tweet_id), [b.tweet_id, d.tweet_id, a.tweet_id, c.tweet_id]);
  assert.deepEqual(feed.map((c) => c.tweet_id), [a.tweet_id, b.tweet_id, c.tweet_id, d.tweet_id], "do not mutate raw feed order");
  assert.equal(selected(plan(feed)), b.tweet_id);
  assert.equal(selected(plan(feed, [job(a, "draft_reply", "done")])), b.tweet_id);
  assert.equal(selected(plan([a, { ...b, stale: true }, c, d])), d.tweet_id);
  assert.equal(selected(plan([a, { ...b, locked: true, locked_points: 30 }, c, d])), d.tweet_id);
  assert.equal(selected(plan(feed, [job(b, "retweet", "done"), job(b, "post_reply", "done")])), d.tweet_id);
  assert.deepEqual(prioritizeBoosted(feed).map((c) => c.tweet_id), campaignList(state).map((c) => c.tweet_id));
});

