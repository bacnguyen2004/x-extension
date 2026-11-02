import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { runAgentTick, type RunnerTickResult } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createInitialRuntime, createEmptyDailyStats } from "../src/domain/agent-settings.ts";
import { makeJob, sanitizeQueue, type AgentJob } from "../src/domain/agent-queue.ts";

function scenario(t: TestContext, initialPath = "/home") {
  const storage: Record<string, unknown> = {};
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    storage: { local: {
      get: async (key: string) => ({ [key]: storage[key] }),
      set: async (values: object) => { Object.assign(storage, values); },
    } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  t.mock.method(Math, "random", () => 0);
  const listeners = new Set<(message: unknown) => void>();
  const disconnects = new Set<() => void>();
  const commands: string[] = [];
  const scrollReadMs: number[] = [];
  const activity: string[] = [];
  let path = initialPath;
  let confirmed = 0;
  let cancelled = false;
  let cancelDuringScan = false;
  let cancelDuringPrepare = false;
  let scrollDistance = 500;
  const emit = (message: object) => {
    for (const fn of [...listeners]) fn({ ...message, href: `https://x.com${path}`, onHome: path === "/home" });
  };
  const port = {
    sender: { id: "resume-test", url: `https://x.com${path}`, tab: { id: 93 }, frameId: 0 },
    onMessage: { addListener: (fn: (message: unknown) => void) => listeners.add(fn), removeListener: (fn: (message: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    disconnect() {},
    postMessage(message: { type: string; requestId?: string; readMs?: number }) {
      if (message.type === "x_ping") { emit({ type: "x_hello", handle: "me" }); return; }
      commands.push(`${message.type} on ${path}`);
      if (message.type === "x_back_to_browse") {
        path = "/home";
        emit({ type: "x_back_to_browse_result", requestId: message.requestId, ok: true, detail: "browse_back_done" });
        return;
      }
      if (message.type === "x_timeline_scan") {
        if (cancelDuringScan) cancelled = true;
        if (path !== "/home") {
          emit({ type: "x_timeline_scan_result", requestId: message.requestId, ok: false, error: "navigating_home" });
          path = "/home";
          emit({ type: "x_hello", handle: "me" });
        } else {
          emit({ type: "x_timeline_scan_result", requestId: message.requestId, ok: true, tweets: [{
            tweetId: "2112057695247180169", authorHandle: "alice", tweetUrl: "https://x.com/alice/status/2112057695247180169",
            text: "A normal post on the timeline.", alreadyLiked: false, promoted: false,
          }] });
        }
        return;
      }
      if (message.type === "x_follow") {
        if (path !== "/alice") {
          emit({ type: "x_follow_result", requestId: message.requestId, ok: false, error: "navigating_profile", detail: "https://x.com/alice" });
          path = "/alice";
          emit({ type: "x_hello", handle: "me" });
        } else {
          confirmed++;
          emit({ type: "x_follow_result", requestId: message.requestId, ok: true, detail: "follow_confirmed" });
        }
        return;
      }
      if (message.type === "x_scroll_burst") {
        scrollReadMs.push(message.readMs ?? -1);
        emit({ type: "x_scroll_result", requestId: message.requestId, ok: true, scrolledPx: scrollDistance });
        return;
      }
      if (["x_prepare_tweet", "x_like", "x_retweet"].includes(message.type)) {
        if (message.type === "x_prepare_tweet" && cancelDuringPrepare) cancelled = true;
        emit({ type: `${message.type}_result`, requestId: message.requestId, ok: !cancelled, error: cancelled ? "stopped" : undefined });
        return;
      }
      throw new Error(`Unexpected command: ${message.type}`);
    },
  };
  attachXPort(port as unknown as chrome.runtime.Port, "resume-test");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  const settings = createDefaultAgentSettings();
  settings.humanize.followPct = 100;
  settings.modules = { ...settings.modules, pogoTasks: false, linkList: false, homeScroll: true };
  settings.priority = "browse_only";
  settings.actions = { like: false, reply: false, retweet: false, follow: true, quote: false };
  let state: RunnerTickResult = { runtime: createInitialRuntime(), stats: createEmptyDailyStats(), queue: { jobs: [] }, nextDelayMs: 0 };
  return {
    settings, commands, scrollReadMs, activity, confirmed: () => confirmed,
    cancelOnScan() { cancelDuringScan = true; },
    cancelOnPrepare() { cancelDuringPrepare = true; },
    resume() { cancelled = false; cancelDuringPrepare = false; state.queue = sanitizeQueue(JSON.parse(JSON.stringify(state.queue))); },
    setScrollDistance(distance: number) { scrollDistance = distance; },
    // Math.random is fixed above; distinguish stored jobs from newly created IDs
    // even when both are created within the same millisecond.
    seed(job: AgentJob) { state.queue.jobs.push({ ...job, id: `stored-${job.id}` }); },
    async tick() {
      state = await runAgentTick({ ...state, settings, extensionId: "resume-test", isCancelled: () => cancelled, waitForDelay: async () => {}, appendActivity: async (_level, message) => { activity.push(message); }, persistQueue: async () => {}, persistStats: async () => {} });
      return state;
    },
  };
}

test("a paused Home bundle retains every action and resumes without another timeline scan", async (t) => {
  const run = scenario(t);
  run.settings.actions = { like: true, retweet: false, reply: false, follow: true, quote: false };
  run.settings.humanize.likePct = run.settings.humanize.followPct = 100;
  run.cancelOnPrepare();
  const interrupted = await run.tick();
  assert.deepEqual(interrupted.queue.jobs.map((j) => j.kind), ["like", "follow"]);
  assert.ok(interrupted.queue.jobs.every((j) => j.status === "pending"));
  assert.equal(new Set(interrupted.queue.jobs.map((j) => j.id)).size, 2);
  run.resume();
  await run.tick();
  await run.tick(); // Follow may first navigate from the post to the profile.
  const finished = await run.tick();
  assert.equal(finished.stats.like, 1);
  assert.equal(finished.stats.follow, 1);
  assert.equal(run.commands.filter((c) => c.startsWith("x_timeline_scan")).length, 1);
});

test("navigation scroll jobs are reused and old pending scrolls do not accumulate", async (t) => {
  const run = scenario(t);
  run.settings.humanize.followPct = 0;
  for (let i = 0; i < 2; i++) run.seed(makeJob({ kind: "scroll_home", source: "browse", tweetId: null, tweetUrl: null, tweetText: null, authorHandle: null, error: "navigating_home" }));
  const result = await run.tick();
  assert.equal(result.queue.jobs.filter((j) => j.status === "pending" || j.status === "running").length, 0);
  assert.equal(result.queue.jobs.filter((j) => j.error === "scroll_superseded").length, 1);
  assert.equal(result.stats.scrollSessions, 1);
});

test("a stalled timeline is not reported or counted as a successful scroll", async (t) => {
  const run = scenario(t); run.settings.humanize.followPct = 0; run.setScrollDistance(0);
  const result = await run.tick();
  assert.equal(result.stats.scrollSessions, 0);
  assert.equal(result.queue.jobs[0].error, "scroll_no_progress");
  assert.deepEqual(run.commands, ["x_timeline_scan on /home", "x_scroll_burst on /home"]);
});

test("Home scroll logs round pixel values and explains the action decision after scanning", async (t) => {
  const run = scenario(t); run.settings.humanize.followPct = 0; run.setScrollDistance(812.4453125);
  await run.tick();
  const log = run.activity.find((message) => message.startsWith("[Home]") && message.includes("px"))!;
  assert.match(log, /812px/); assert.match(log, /không chọn hành động theo tỷ lệ/);
  assert.doesNotMatch(log, /@\?|#—|812\.445|\(scrolled\)/);
});

test("turning Follow off prunes the pending job and allows browsing to continue", async (t) => {
  const run = scenario(t, "/alice");
  run.settings.actions.follow = false;
  run.seed(makeJob({ kind: "follow", source: "browse", tweetId: "2112057695247180169", authorHandle: "alice",
    tweetUrl: "https://x.com/alice/status/2112057695247180169", tweetText: "Post", error: "navigating_profile" }));
  const result = await run.tick();
  assert.equal(result.queue.jobs[0].status, "skipped");
  assert.equal(result.queue.jobs[0].error, "action_disabled");
  assert.deepEqual(run.commands, ["x_timeline_scan on /alice"]);
});

test("zero action chances still scan posts before scrolling without starting an interaction", async (t) => {
  const run = scenario(t);
  run.settings.humanize.followPct = 0;
  run.settings.humanize.readMsMin = run.settings.humanize.readMsMax = 1;
  run.settings.delaySecMin = run.settings.delaySecMax = 90;
  const result = await run.tick();
  assert.deepEqual(run.commands, ["x_timeline_scan on /home", "x_scroll_burst on /home"]);
  assert.equal(result.stats.scrollSessions, 1);
  assert.equal(run.confirmed(), 0);
  assert.deepEqual(run.scrollReadMs, [0], "searching for a post must not add a reading pause");
  assert.ok(result.nextDelayMs >= 2000 && result.nextDelayMs <= 4000, "only wait briefly for feed content, not the 90-second post-action delay");
  assert.ok(run.activity.some((message) => message.includes("không chọn hành động theo tỷ lệ")));
  const restored = sanitizeQueue(JSON.parse(JSON.stringify(result.queue)));
  assert.match(restored.jobs[0].reason ?? "", /không chọn hành động theo tỷ lệ/);
});

test("pause while a scan is in flight prevents starting the selected follow", async (t) => {
  const run = scenario(t);
  run.cancelOnScan();
  const result = await run.tick();
  assert.deepEqual(run.commands, ["x_timeline_scan on /home"]);
  assert.equal(result.queue.jobs.length, 0);
  assert.equal(result.nextDelayMs, 0);
});

test("browse-only execution mode leaves pending interactions alone and keeps scrolling", async (t) => {
  const run = scenario(t);
  run.settings.executeActions = false;
  run.seed(makeJob({ kind: "follow", source: "browse", tweetId: "2112057695247180169", authorHandle: "alice",
    tweetUrl: "https://x.com/alice/status/2112057695247180169", tweetText: "Post", error: "navigating_profile" }));
  const result = await run.tick();
  assert.deepEqual(run.commands, ["x_scroll_burst on /home"]);
  assert.equal(run.confirmed(), 0);
  assert.equal(result.queue.jobs.find((job) => job.kind === "follow")?.status, "pending");
  assert.match(result.queue.jobs[0].reason ?? "", /không thực hiện tương tác/);
});

test("Home follow resumes on the profile before returning to scan Home", async (t) => {
  const run = scenario(t);
  run.settings.delaySecMin = run.settings.delaySecMax = 90;
  const first = await run.tick();
  assert.equal(first.queue.jobs[0].error, "navigating_profile");
  const second = await run.tick();
  assert.equal(run.confirmed(), 1);
  assert.equal(second.queue.jobs[0].status, "done");
  assert.equal(second.stats.follow, 1);
  assert.equal(second.nextDelayMs, 90_000, "a real interaction still uses the configured post-action rest");
  assert.deepEqual(run.commands, ["x_timeline_scan on /home", "x_follow on /home", "x_follow on /alice", "x_back_to_browse on /alice"]);
  await run.tick();
  assert.deepEqual(run.commands.slice(4), ["x_timeline_scan on /home", "x_scroll_burst on /home"], "scan and scroll the feed reached by Back after completing the task");
});

for (const source of ["pogo", "manual"] as const) {
  test(`pending ${source} follow is not interrupted by Home scanning`, async (t) => {
    const run = scenario(t, "/alice");
    run.settings.priority = "pogo_then_browse";
    run.settings.modules.pogoTasks = source === "pogo";
    run.settings.modules.linkList = source === "manual";
    run.seed(makeJob({ kind: "follow", source, tweetId: "2112057695247180169", authorHandle: "alice",
      tweetUrl: "https://x.com/alice/status/2112057695247180169", tweetText: "Post", error: "navigating_profile" }));
    const result = await run.tick();
    assert.equal(result.queue.jobs[0].status, "done");
    assert.equal(run.confirmed(), 1);
    assert.deepEqual(run.commands, ["x_follow on /alice"]);
  });
}
