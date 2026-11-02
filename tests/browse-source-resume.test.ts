import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { parseHTML } from "linkedom";
import { handleXCommand, setStopped } from "../src/content/x-commands.ts";
import { planNextAction } from "../src/agent/planner.ts";
import { beginNavigateToSource, browseScheduleOf, confirmSourceReady, createFeedRotationState } from "../src/domain/feed-rotation.ts";

test("Lists still respects disabled action selections while bypassing Home's opening chance", () => {
  const settings = createDefaultAgentSettings();
  settings.priority = "browse_only";
  settings.modules = { ...settings.modules, pogoTasks: false, homeScroll: false, lists: true };
  settings.listUrlOrName = "https://x.com/i/lists/1234567890";
  settings.actions = { like: true, reply: true, follow: false, quote: false, retweet: false };
  const input = { settings, stats: createEmptyDailyStats(), queue: { jobs: [] }, campaigns: [], executeActions: true, hasApiKey: true, ownHandle: "owner", browseSurface: "lists" as const,
    browseCandidates: [{ tweetId: "2112057695247180194", tweetUrl: "https://x.com/alice/status/2112057695247180194", authorHandle: "alice", text: "A candidate post on Lists", promoted: false, alreadyLiked: false }],
    browseRolls: { engage: false, like: false, reply: false, follow: false, retweet: false, feedLike: false } };
  const skipped = planNextAction(input);
  assert.equal(skipped.type === "job" ? skipped.job.kind : skipped.type, "scroll_home");
  const selected = planNextAction({ ...input, browseRolls: { ...input.browseRolls, like: true } });
  assert.equal(selected.type === "job" ? selected.job.kind : selected.type, "like");
  settings.actions.like = false;
  const disabled = planNextAction({ ...input, browseRolls: { ...input.browseRolls, like: true } });
  assert.equal(disabled.type === "job" ? disabled.job.kind : disabled.type, "scroll_home");
});

test("Lists scanning waits for the timeline to render before reporting no candidates", async t => {
  const { document, window } = parseHTML('<main data-testid="primaryColumn"></main>');
  const location = { href: "https://x.com/i/lists/1234567890", pathname: "/i/lists/1234567890", origin: "https://x.com" };
  for (const [key, value] of Object.entries({ document, window, location })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  let clock = 1900000000000, inserted = false;
  const started = clock;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms = 0) => {
    if (ms > 8000) return 1 as unknown as NodeJS.Timeout;
    queueMicrotask(() => {
      clock += ms;
      if (!inserted && clock - started >= 500) {
        document.querySelector("main")!.insertAdjacentHTML("beforeend", '<article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a></div><a href="/alice/status/2112057695247180193"><time></time></a><div data-testid="tweetText">A post loaded after the list opened.</div></article>');
        inserted = true;
      }
      fn();
    });
    return 1 as unknown as NodeJS.Timeout;
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.after(() => setStopped(true));
  const responses: Record<string, unknown>[] = [];
  await handleXCommand({ postMessage: response => responses.push(response as Record<string, unknown>) }, { type: "x_timeline_scan", browseSurface: "lists", listUrl: location.href, requestId: "render-list" });
  assert.equal(responses[0].ok, true);
  assert.equal((responses[0].tweets as unknown[]).length, 1);
  assert.ok(clock - started >= 500);
});

test("a Lists session survives navigation, keeps remaining time, and rotates only after time/empty — not mid-session settings change", async t => {
  const disk: Record<string, unknown> = {};
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => Object.assign(disk, patch) } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  t.mock.method(Math, "random", () => 0);
  let now = Date.now();
  t.mock.method(Date, "now", () => now++);
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>();
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  const scans: string[] = [], commands: string[] = [], scrolls: string[] = [];
  const tweetId = "2112057695247180190";
  const port = { sender: { id: "lists-resume", url: "https://x.com/home", frameId: 0, tab: { id: 199 } },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) }, disconnect() {},
    postMessage(m: { type: string; requestId?: string; browseSurface?: string }) {
      if (m.type === "x_ping") { emit({ type: "x_hello", handle: "owner", onHome: true }); return; }
      commands.push(m.type);
      if (m.type === "x_scroll_burst") {
        scrolls.push(m.browseSurface!);
        emit({ type: "x_scroll_result", requestId: m.requestId, ok: true, scrolledPx: 500 });
        return;
      }
      if (m.type === "x_timeline_scan") {
        scans.push(m.browseSurface!);
        if (scans.length === 1) emit({ type: "x_timeline_scan_result", requestId: m.requestId, ok: false, error: "navigating_lists_link" });
        else emit({ type: "x_timeline_scan_result", requestId: m.requestId, ok: true, tweets: [{ tweetId, tweetUrl: `https://x.com/alice/status/${tweetId}`, authorHandle: "alice", text: "Actual post on the list", alreadyLiked: false, promoted: false }] });
        return;
      }
      emit({ type: `${m.type}_result`, requestId: m.requestId, ok: true, detail: m.type === "x_like" ? "liked" : "read_status" });
    } };
  attachXPort(port as unknown as chrome.runtime.Port, "lists-resume");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  const settings = createDefaultAgentSettings();
  settings.priority = "browse_only"; settings.adaptiveRest = false;
  settings.modules = { ...settings.modules, pogoTasks: false, homeScroll: true, followingFeed: false, lists: true, notifications: false };
  settings.listUrlOrName = "https://x.com/i/lists/1234567890";
  settings.actions = { like: true, reply: false, retweet: false, quote: false, follow: false };
  settings.humanize.likePct = 100; // Bắt đầu sẵn trên Lists (không phụ thuộc weight random cũ).
  const runtime = createInitialRuntime();
  runtime.browseRotation = confirmSourceReady(
    beginNavigateToSource(createFeedRotationState(), "lists", 1),
    browseScheduleOf(settings),
    Date.now(),
  );
  runtime.lastBrowseSurface = "lists";
  const deps = { settings, runtime, stats: createEmptyDailyStats(), queue: { jobs: [] }, extensionId: "lists-resume", appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {}, waitForDelay: async () => {} };
  const first = await runAgentTick(deps);
  assert.equal(first.runtime.browseRotation?.currentSource ?? first.runtime.browseRotation?.targetSource, "lists");
  const remainingAfterNav = first.runtime.browseRotation?.remainingScanTimeMs ?? 0;
  assert.ok(remainingAfterNav > 0, "navigation is not a completed time unit");

  // Đổi module ưu tiên Home giữa phiên — vẫn ở Lists.
  settings.modules.homeScroll = true;
  const second = await runAgentTick({ ...deps, runtime: JSON.parse(JSON.stringify(first.runtime)), stats: first.stats, queue: first.queue });
  assert.deepEqual(scans, ["lists", "lists"]);
  assert.equal(second.stats.like, 1);
  assert.equal(second.runtime.browseVisit, undefined);
  assert.ok(!commands.includes("x_scroll_burst"), "do not leave the list before its selected action");
  assert.equal(commands.filter(command => command === "x_back_to_browse").length, 1);
  assert.ok(commands.indexOf("x_back_to_browse") > commands.indexOf("x_like"));
  assert.equal(second.runtime.browseRotation?.currentSource, "lists");
  assert.ok((second.runtime.browseRotation?.remainingScanTimeMs ?? 0) > 0);

  const third = await runAgentTick({ ...deps, runtime: second.runtime, stats: second.stats, queue: second.queue });
  assert.deepEqual(scrolls, ["lists"], "stay on the source after Back despite settings change");
  assert.equal(third.runtime.browseRotation?.currentSource, "lists");

  // Hết thời gian → chuyển For You (home).
  third.runtime.browseRotation = {
    ...third.runtime.browseRotation!,
    remainingScanTimeMs: 0,
    pendingSwitch: true,
    phase: "switch_pending",
    clockRunning: false,
    clockStartedAt: null,
  };
  const fourth = await runAgentTick({ ...deps, runtime: third.runtime, stats: third.stats, queue: third.queue });
  assert.equal(fourth.runtime.browseRotation?.targetSource ?? fourth.runtime.browseRotation?.currentSource, "home");

  const fifth = await runAgentTick({ ...deps, runtime: fourth.runtime, stats: fourth.stats, queue: fourth.queue });
  assert.ok(scrolls.includes("home") || fifth.runtime.browseRotation?.currentSource === "home" || fifth.runtime.browseRotation?.targetSource === "home");

  settings.modules.homeScroll = false;
  const sixth = await runAgentTick({ ...deps, runtime: fifth.runtime, stats: fifth.stats, queue: fifth.queue });
  const active = sixth.runtime.browseRotation?.targetSource ?? sixth.runtime.browseRotation?.currentSource;
  assert.equal(active, "lists", "disabling Home returns rotation to Lists");
});
