import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime, sanitizeAgentSettings, applySpeedPreset } from "../src/domain/agent-settings.ts";
import { defaultBrowseRolls, planNextAction } from "../src/agent/planner.ts";
import { makeJob, sanitizeQueue } from "../src/domain/agent-queue.ts";
import { handleXCommand } from "../src/content/x-commands.ts";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";

const candidate = { tweetId: "2112057695247180169", authorHandle: "alice", tweetUrl: "https://x.com/alice/status/2112057695247180169", text: "A post on the Home feed.", alreadyLiked: false, promoted: false };
function settings() {
  const s = createDefaultAgentSettings();
  s.modules.pogoTasks = false; s.modules.homeScroll = true; s.modules.linkList = false; s.priority = "browse_only";
  s.humanize.likePct = 100; s.humanize.replyPct = 0;
  s.actions = { like: true, reply: false, retweet: false, follow: false, quote: false };
  return s;
}

test("Like uses one action chance and old open/feed-like settings are ignored", () => {
  const s = settings(); const rolls = defaultBrowseRolls(s, () => 0.5);
  assert.equal(rolls.like, true);
  assert.equal(sanitizeAgentSettings({ humanize: { likePct: 500 } }).humanize.likePct, 100);
  assert.equal(sanitizeAgentSettings({ humanize: { likePct: -1 } }).humanize.likePct, 0);
  const migrated = sanitizeAgentSettings({ humanize: { openTweetPct: 0, feedLikePct: 0, likePct: 70, replyPct: 50 } });
  assert.equal(migrated.humanize.likePct, 70); assert.equal(migrated.humanize.replyPct, 50);
  assert.ok(!("openTweetPct" in applySpeedPreset(migrated, "fast").humanize));
  assert.equal(defaultBrowseRolls(s, () => 0).feedLike, false);
});

test("feed-like decision produces exactly one Like despite Reply/RT/Follow rolls", () => {
  const s = settings();
  const p = planNextAction({ settings: s, queue: { jobs: [] }, campaigns: [], stats: createEmptyDailyStats(), executeActions: true, ownHandle: "me", hasApiKey: true,
    browseCandidates: [candidate], browseRolls: { feedLike: true, engage: true, like: true, reply: true, retweet: true, follow: true } });
  assert.equal(p.type, "job"); if (p.type !== "job") return;
  assert.equal(p.job.kind, "like"); assert.equal(p.job.likeOnFeed, true);
  assert.equal(sanitizeQueue(JSON.parse(JSON.stringify({ jobs: [p.job] }))).jobs[0].likeOnFeed, true);
  assert.equal(sanitizeQueue({ jobs: [{ ...p.job, kind: "post_reply" }] }).jobs[0].likeOnFeed, undefined);
});

test("Reply opens the post without an open-post gate and respects a zero Like chance", () => {
  const s = settings(); s.actions.reply = true;
  const planned = planNextAction({ settings: s, queue: { jobs: [] }, campaigns: [], stats: createEmptyDailyStats(), executeActions: true,
    ownHandle: "me", hasApiKey: true, browseCandidates: [candidate],
    browseRolls: { engage: false, feedLike: true, like: false, reply: true, retweet: false, follow: false } });
  assert.equal(planned.type, "bundle");
  if (planned.type !== "bundle") return;
  assert.deepEqual(planned.jobs.map(j => j.kind), ["draft_reply", "post_reply"]);
  assert.ok(planned.jobs.every(j => !j.likeOnFeed));
});

for (const replyPct of [0, 100]) test(`Reply ${replyPct}% decides directly after filtering, with Like at zero`, t => {
  const s = settings(); s.actions.reply = true; s.humanize.likePct = 0; s.humanize.replyPct = replyPct;
  t.mock.method(Math, "random", () => 0.99);
  const planned = planNextAction({ settings: s, queue: { jobs: [] }, campaigns: [], stats: createEmptyDailyStats(), executeActions: true,
    ownHandle: "me", hasApiKey: true, browseCandidates: [candidate] });
  if (replyPct === 0) {
    assert.equal(planned.type, "job");
    if (planned.type === "job") assert.equal(planned.job.kind, "scroll_home");
  } else {
    assert.equal(planned.type, "bundle");
    if (planned.type === "bundle") assert.deepEqual(planned.jobs.map(j => j.kind), ["draft_reply", "post_reply"]);
  }
});

test("selecting Like and Reply keeps both in one post bundle", () => {
  const s = settings(); s.actions.reply = true;
  const planned = planNextAction({ settings: s, queue: { jobs: [] }, campaigns: [], stats: createEmptyDailyStats(), executeActions: true,
    ownHandle: "me", hasApiKey: true, browseCandidates: [candidate],
    browseRolls: { engage: false, feedLike: true, like: true, reply: true, retweet: false, follow: false } });
  assert.equal(planned.type, "bundle");
  if (planned.type !== "bundle") return;
  assert.deepEqual(planned.jobs.map(j => j.kind), ["draft_reply", "post_reply", "like"]);
  assert.ok(planned.jobs.every(j => !j.likeOnFeed));
});

test("feed likes respect disabled Like, own/ad/already-liked posts and completion history", () => {
  const s = settings();
  const input = { settings: s, queue: { jobs: [] }, campaigns: [], stats: createEmptyDailyStats(), executeActions: true, ownHandle: "me", hasApiKey: false,
    browseRolls: { feedLike: true, engage: false, like: true, reply: true, retweet: true, follow: true } };
  for (const c of [{ ...candidate, promoted: true }, { ...candidate, alreadyLiked: true }, { ...candidate, authorHandle: "me" }]) {
    const p = planNextAction({ ...input, browseCandidates: [c] }); assert.equal(p.type === "job" && p.job.kind, "scroll_home");
  }
  s.actions.like = false;
  const off = planNextAction({ ...input, browseCandidates: [candidate] }); assert.equal(off.type === "job" && off.job.kind, "scroll_home");
  s.actions.like = true;
  const done = makeJob({ kind: "like", status: "done", source: "browse", tweetId: candidate.tweetId, authorHandle: "alice", tweetUrl: candidate.tweetUrl, tweetText: candidate.text });
  const p = planNextAction({ ...input, queue: { jobs: [done] }, browseCandidates: [candidate] }); assert.equal(p.type === "job" && p.job.kind, "scroll_home");
});

async function runScenario(t: TestContext, missing: boolean) {
  const { document, window } = parseHTML(`<html><body><main role="main"><div role="tab" aria-selected="true">For you</div><article data-testid="tweet"><div data-testid="User-Name"><a role="link" href="/alice">Alice</a></div><a role="link" href="${candidate.tweetUrl}"><time>Now</time></a><div data-testid="tweetText">${candidate.text}</div><button data-testid="like"></button></article></main></body></html>`);
  let navigations = 0, clicks = 0;
  const globals = { document, window, HTMLElement: window.HTMLElement,
    location: { href: "https://x.com/home", pathname: "/home", origin: "https://x.com", assign() { navigations++; } },
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } } };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  document.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => navigations++));
  const button = document.querySelector('[data-testid="like"]')!;
  button.addEventListener("click", () => { clicks++; button.setAttribute("data-testid", "unlike"); });
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>();
  const commands: Array<{ type: string; onFeed?: boolean }> = [];
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  const port = { sender: { id: "feed-like-test", url: "https://x.com/home", tab: { id: 98 }, frameId: 0 },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    postMessage(m: { type: string; onFeed?: boolean }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", loggedIn: true, onHome: true }); return; }
      commands.push(m);
      assert.ok(m.type === "x_timeline_scan" || m.type === "x_like", "inline Like must not prepare, reply, retweet, follow or scroll");
      if (missing && m.type === "x_like") document.querySelector("article")!.remove();
      void handleXCommand({ postMessage: emit }, m);
    }, disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "feed-like-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Feed likes need no AI or Pogo API"); });
  const result = await runAgentTick({ settings: settings(), runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: [] }, extensionId: "feed-like-test",
    appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {} });
  return { result, commands, clicks, navigations };
}

test("runner and real content command like directly on the feed without preparing/opening/replying", async (t) => {
  const { result, commands, clicks, navigations } = await runScenario(t, false);
  assert.deepEqual(commands.map((m) => m.type), ["x_timeline_scan", "x_like"]);
  assert.equal(commands[1].onFeed, true); assert.equal(clicks, 1); assert.equal(navigations, 0);
  assert.equal(result.stats.like, 1); assert.equal(result.stats.reply, 0);
  assert.ok(result.nextDelayMs >= 2000 && result.nextDelayMs <= 4000);
});

test("a post leaving the feed between scan and click is skipped without navigating", async (t) => {
  const { result, clicks, navigations } = await runScenario(t, true);
  assert.equal(clicks, 0); assert.equal(navigations, 0); assert.equal(result.stats.like, 0);
  assert.equal(result.queue.jobs[0].error, "feed_tweet_missing");
});
