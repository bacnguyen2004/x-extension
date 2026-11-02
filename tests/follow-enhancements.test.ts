import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { latestProfilePost } from "../src/x/latest-profile-post.ts";
import { buildBrowseJobs, buildCampaignJobs } from "../src/agent/planner.ts";
import { makeJob, sanitizeQueue } from "../src/domain/agent-queue.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { attachXPort, selectXTab } from "../src/background/x-bridge.ts";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { createDefaultFollowSettings } from "../src/domain/follow-settings.ts";
import { interactWithFollowedPost } from "../src/background/agent-store.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";

const tweetId = "2112057695247180190";
const candidate = { tweetId, authorHandle: "writer", tweetUrl: `https://x.com/writer/status/${tweetId}`, text: "The new release notes explain the fee changes.", alreadyLiked: false, promoted: false };
const rolls = { engage: true, like: true, reply: false, retweet: false, follow: true };

test("random author Follow accompanies an interaction and survives queue restoration", () => {
  const settings = createDefaultAgentSettings(); settings.randomAuthorFollow = true; settings.actions.follow = true;
  const jobs = buildBrowseJobs({ candidate, settings, queue: { jobs: [] }, executeActions: true, hasApiKey: true, rolls, preferFollowList: true });
  assert.deepEqual(jobs.map(j => j.kind), ["like", "follow"]);
  assert.equal(jobs[1].authorFollow, true);
  assert.equal(sanitizeQueue({ jobs }).jobs[1].authorFollow, true);
  assert.equal(jobs[0].likeOnFeed, true, "Like plus optional author Follow stays on the feed");
  const none = buildBrowseJobs({ candidate, settings, queue: { jobs: [] }, executeActions: true, hasApiKey: true,
    rolls: { ...rolls, like: false, reply: false } });
  assert.deepEqual(none, [], "do not open profiles just because the Follow roll succeeded");
  const campaign = normalizeApiCampaign({ tweet_id: tweetId, author_handle: "writer", follows_author: true, locked_points: 0 })!;
  assert.ok(buildCampaignJobs({ campaign, settings, queue: { jobs: [] }, executeActions: true, hasApiKey: true }).every(j => !j.authorFollow));
});

function article(author: string, id: string, extra = "", body = "New release notes") {
  return `<article data-testid="tweet">${extra}<div data-testid="User-Name"><a href="/${author}">@${author}</a></div><a href="/${author}/status/${id}"><time></time></a><div data-testid="tweetText">${body}</div><button data-testid="like"></button></article>`;
}

test("latest post ignores old pinned order, reposts, other authors, replies and hidden content", () => {
  const { document } = parseHTML(`<main>${article("writer", "2112057695247180100", '<div data-testid="socialContext">Pinned</div>')}
    ${article("writer", "2112057695247180190")}${article("other", "2112057695247180999")}
    ${article("writer", "2112057695247180998", '<div data-testid="socialContext">You reposted</div>')}
    ${article("writer", "2112057695247180997", '<span data-testid="replyingTo">Replying to @other</span>')}
    <div hidden>${article("writer", "2112057695247180996")}</div></main>`);
  assert.equal(latestProfilePost(document, "writer")?.tweetId, tweetId);
  assert.equal(latestProfilePost(document, "missing"), null);
});

function connect(t: TestContext, handle: string) {
  const disk: Record<string, unknown> = {};
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: { id: "author-test", sendMessage: async () => {} },
    storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => Object.assign(disk, structuredClone(patch)), remove: async () => {} } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>(), commands: string[] = [];
  const emit = (message: object) => { for (const fn of [...listeners]) fn(message); };
  const port = { sender: { id: "author-test", url: `https://x.com/${handle}`, frameId: 0, tab: { id: 434 } },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) }, disconnect() {},
    postMessage(m: { type: string; requestId?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", handle: "owner", onHome: false }); return; }
      commands.push(m.type);
      if (m.type === "x_timeline_scan") emit({ type: "x_timeline_scan_result", requestId: m.requestId, ok: true, tweets: [candidate] });
      else if (m.type === "x_follow_profile_meta") emit({ type: "x_follow_profile_meta_result", requestId: m.requestId, ok: true, meta: { onProfile: true, verified: false, hasFollowButton: true, alreadyFollowing: false } });
      else emit({ type: `${m.type}_result`, requestId: m.requestId, ok: true, detail: m.type === "x_follow" ? "follow_confirmed" : "ok" });
    } };
  attachXPort(port as unknown as chrome.runtime.Port, "author-test"); selectXTab(434);
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  return { commands, disk };
}

for (const threshold of [500, 1000]) for (const score of [null, threshold - 1, threshold, threshold + 1]) test(`author Follow requires Sorsa strictly above configured ${threshold}: ${score}`, async t => {
  const handle = score === null ? "missing_score" : `score_${score}`;
  const { commands, disk } = connect(t, handle);
  const filters = createDefaultFollowSettings(); filters.filters.allowMissingSorsa = true;
  disk["xContentCreator.follow.v1"] = filters;
  t.mock.method(globalThis, "fetch", async () => Response.json([{ screen_name: handle, score_value: score }]));
  const settings = createDefaultAgentSettings(); settings.randomAuthorFollow = true; settings.actions.follow = true;
  settings.randomAuthorFollowSorsaMin = threshold;
  settings.priority = "browse_only"; settings.adaptiveRest = false; settings.modules.pogoTasks = false; settings.modules.homeScroll = true;
  const base = { source: "browse" as const, browseSurface: "home" as const, tweetId, tweetUrl: `https://x.com/${handle}/status/${tweetId}`, authorHandle: handle, tweetText: candidate.text };
  const like = makeJob({ kind: "like", ...base, status: "done" });
  const follow = makeJob({ kind: "follow", ...base, authorFollow: true, error: "navigating_profile" });
  const result = await runAgentTick({ settings, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: [follow, like] }, extensionId: "author-test",
    waitForDelay: async () => {}, appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {} });
  assert.equal(commands.includes("x_follow"), score === threshold + 1);
  if (score !== threshold + 1) assert.equal(commands.includes("x_follow_profile_meta"), false, "low/missing score should not navigate to a profile");
  assert.ok(result.queue.jobs.some(j => j.id === follow.id && (j.status === "done" || j.status === "skipped")));
  if (score === threshold + 1) assert.equal(commands.includes("x_follow_profile_meta"), false, "default score-only filters allow inline Follow without a profile visit");
});

test("Like plus author Follow executes from a feed scan without opening the post or profile", async t => {
  const { commands } = connect(t, "writer");
  t.mock.method(globalThis, "fetch", async () => Response.json([{ screen_name: "writer", score_value: 1500 }]));
  const settings = createDefaultAgentSettings();
  settings.priority = "browse_only"; settings.adaptiveRest = false; settings.randomAuthorFollow = true;
  settings.modules.pogoTasks = false; settings.modules.homeScroll = true;
  settings.actions = { like: true, reply: false, follow: true, quote: false, retweet: false };
  settings.humanize.likePct = 100; settings.humanize.followPct = 100;
  const result = await runAgentTick({ settings, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: [] }, extensionId: "author-test",
    waitForDelay: async () => {}, appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {} });
  assert.equal(result.stats.like, 1); assert.equal(result.stats.follow, 1);
  assert.equal(commands.includes("x_prepare_tweet"), false);
  assert.equal(commands.includes("x_follow_profile_meta"), false);
  assert.ok(commands.indexOf("x_like") < commands.indexOf("x_follow"));
  assert.equal(commands.includes("x_back_to_browse"), true, "return handler verifies source, including after profile fallback");
});

test("Follow by link posts Like and Reply once even when ordinary Agent actions are disabled", async t => {
  const { disk, commands } = connect(t, "writer");
  const ai = createDefaultAiSettings(); ai.apiKey = "test-key";
  disk["pogoTaskReader.aiSettings.v1"] = ai;
  const settings = createDefaultAgentSettings();
  settings.actions = { like: false, reply: false, follow: false, retweet: false, quote: false };
  disk["xContentCreator.agentSettings.v1"] = settings;
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: "The release notes make the fee changes easier to verify." }, finish_reason: "stop" }] }));
  const first = await interactWithFollowedPost(candidate, () => false, async () => {});
  assert.equal(first.complete, true);
  assert.equal(commands.filter(c => c === "x_like").length, 1);
  assert.equal(commands.filter(c => c === "x_reply").length, 1);
  assert.equal(commands.includes("x_follow"), false, "post-Follow work must not Follow again");
  await interactWithFollowedPost(candidate, () => false, async () => {});
  assert.equal(commands.filter(c => c === "x_reply").length, 1, "resume cannot send a duplicate Reply");
  assert.equal(commands.filter(c => c === "x_like").length, 1);
});

test("real feed ticks scan first and alternate list Follow with author interaction when both are 100%", async t => {
  const { disk, commands } = connect(t, "writer");
  const followSettings = createDefaultFollowSettings(); followSettings.usernameList = "@list_one\n@list_two";
  disk["xContentCreator.follow.v1"] = followSettings;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const handle = new URL(String(url)).searchParams.get("query");
    return Response.json([{ screen_name: handle, score_value: 1500 }]);
  });
  const settings = createDefaultAgentSettings();
  settings.priority = "browse_only"; settings.adaptiveRest = false; settings.randomAuthorFollow = true;
  settings.modules.pogoTasks = false; settings.modules.homeScroll = true; settings.modules.following = true;
  settings.actions = { like: true, reply: false, follow: true, quote: false, retweet: false };
  settings.humanize.likePct = 100; settings.humanize.followPct = 100; settings.humanize.listFollowPct = 100;
  const deps = { settings, extensionId: "author-test", waitForDelay: async () => {}, appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {} };
  const first = await runAgentTick({ ...deps, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: [] } });
  assert.equal(first.queue.jobs.find(j => j.kind === "follow")?.authorHandle, "list_one");
  const second = await runAgentTick({ ...deps, ...first });
  assert.ok(second.queue.jobs.some(j => j.authorFollow && j.authorHandle === "writer" && j.status === "done"));
  assert.equal(second.stats.like, 1); assert.equal(second.stats.follow, 2);
  assert.equal(commands.filter(c => c === "x_timeline_scan").length, 2, "both ticks must scan instead of repeatedly consuming the username list before seeing posts");
});
