import { acquireXTurn, startExclusiveX, getXWorker } from "./x-coordinator.ts";
import { guardedFollow } from "./follow-budget.ts";
import { loadFollowHistory, rememberFollow } from "./follow-history.ts";
import { xPageRetryDelay } from "./x-page-health.ts";
import { inspectFollowProfile } from "./x-bridge.ts";
/**
 * Orchestrator Tab Follow: list / kol_followers + filters + pace.
 */

import {
  evaluateFollowCandidate,
  normalizeFollowHandle,
  parseHandleList,
  type FollowCandidate,
  type FollowSettings,
} from "../domain/follow-settings.ts";
import { fetchSorsaScore } from "./sorsa-store.ts";
import { interactWithFollowedPost, cancelFollowPostInteraction } from "./agent-store.ts";
import { sanitizeTimelineTweets } from "../x/timeline.ts";
import {
  canFollowNow,
  loadFollowRuntime,
  loadFollowSettings,
  noteFollowSuccess,
  pushFollowLog,
  randomDelayMs,
  saveFollowRuntime,
  toFollowPublic,
  type FollowRuntime,
} from "./follow-store.ts";
import {
  getXConnection,
  navigateXTab,
  requestFollow,
  requestFollowInCell,
  requestFollowProfileMeta,
  requestLatestProfilePost,
  requestFollowScanCells,
  requestFollowScrollList,
  sleepMs,
  waitForXConnection,
  type XActionResult,
  stopAllXBrowse,
} from "./x-bridge.ts";

/** Nếu chưa có port X, mở/focus tab rồi đợi content script. */
async function ensureXTabReady(cancelled: () => boolean): Promise<{ ok: boolean; error?: string }> {
  if (cancelled()) return { ok: false, error: "stopped" };
  if (getXConnection().connected) return { ok: true };
  const nav = await navigateXTab("https://x.com/home", cancelled);
  if (!nav.ok) return { ok: false, error: nav.error || "navigate_failed" };
  const ready = await waitForXConnection(15_000, nav.tabId);
  if (!ready.ok) return { ok: false, error: "no_x_tab" };
  return { ok: true };
}

const ALARM = "x-follow-tick";
const LOG = "[x-content-creator/follow]";

let tickInFlight = false;
let runGeneration = 0;
class FollowBudgetWait extends Error {}

async function budgetedFollow(cancelled: () => boolean, action: () => Promise<XActionResult>, candidate: FollowCandidate): Promise<XActionResult> {
  const result = await guardedFollow({ account: () => getXConnection().handle || "", cancelled, origin: "follow", action: async () => {
    const current = await loadFollowSettings();
    if (cancelled()) return { ok: false, error: "stopped" };
    const decision = evaluateFollowCandidate(candidate, current.filters);
    if (!decision.ok) return { ok: false, error: decision.reason };
    return action();
  } });
  if (!result.ok && ["daily_target_reached", "follow_rate_30m"].includes(result.error ?? "")) throw new FollowBudgetWait(result.error);
  return result;
}

function notifyUi(): void {
  void (async () => {
    const settings = await loadFollowSettings();
    const rt = await loadFollowRuntime();
    try {
      await chrome.runtime.sendMessage({
        type: "follow_state",
        follow: toFollowPublic(rt, settings),
        settings,
      });
    } catch {
      /* no listeners */
    }
  })();
}

async function persist(rt: FollowRuntime, generation = runGeneration): Promise<FollowRuntime> {
  await saveFollowRuntime(rt, () => generation !== runGeneration);
  notifyUi();
  return rt;
}

function scheduleNext(ms: number): void {
  // Cho phép delay 0 — sàn 50ms để SW kịp yield.
  const when = Date.now() + Math.max(50, ms);
  void chrome.alarms.clear(ALARM);
  void chrome.alarms.create(ALARM, { when });
}

/** Delay đầy đủ chỉ sau follow thật; skip/already_following → next rất nhanh. */
function delayAfterOutcome(settings: FollowSettings, rt: FollowRuntime): number {
  return Math.max(8000, randomDelayMs(settings));
}

async function finishFollowTick(rt: FollowRuntime, generation: number): Promise<void> {
  const cancelled = () => generation !== runGeneration;
  const settings = await loadFollowSettings();
  const usage = await loadFollowRuntime();
  if (cancelled()) return;
  rt = { ...rt, day: usage.day, followedToday: usage.followedToday, followTimestamps: usage.followTimestamps };
  if (rt.postFollow) {
    await persist({ ...rt, nextAt: Date.now() + 3000 }, generation);
    if (!cancelled()) scheduleNext(3000);
    return;
  }
  const gate = canFollowNow(rt, settings);
  if (!gate.ok && gate.reason === "daily_limit") {
    rt = pushFollowLog({ ...rt, running: false, currentHandle: null, nextAt: null, detail: "Đạt mục tiêu / ngày" },
      { handle: "", action: "info", message: "Đạt mục tiêu / ngày" });
    await persist(rt, generation);
    if (!cancelled()) await chrome.alarms.clear(ALARM);
    return;
  }
  const delay = gate.ok ? delayAfterOutcome(settings, rt) : gate.waitMs ?? 60000;
  rt = { ...rt, currentHandle: null, nextAt: Date.now() + delay,
    detail: gate.ok ? `Chờ ${Math.round(delay / 1000)}s…`
      : `Đạt giới hạn ${settings.pace.maxPer30Min}/30 phút · Chờ ${Math.ceil(delay / 1000)}s` };
  await persist(rt, generation);
  if (!cancelled() && rt.running) scheduleNext(delay);
}

export async function getFollowPublicState() {
  const settings = await loadFollowSettings();
  const rt = await loadFollowRuntime();
  return { follow: toFollowPublic(rt, settings), settings };
}

export async function startFollowRunner(): Promise<{ ok: boolean; error?: string }> {
  return startExclusiveX("follow", startFollowRunnerExclusive);
}

async function startFollowRunnerExclusive(): Promise<{ ok: boolean; error?: string }> {
  const generation = ++runGeneration;
  const release = await acquireXTurn("follow", () => generation !== runGeneration);
  if (!release) return { ok: false, error: "stopped" };
  try {
    const result = await startFollowRunnerOwned(generation);
    if (!result.ok && generation === runGeneration) await stopFollowRunner("Không thể bắt đầu Follow.");
    return result;
  } finally { release(); }
}

async function startFollowRunnerOwned(generation: number): Promise<{ ok: boolean; error?: string }> {
  const cancelled = () => generation !== runGeneration;
  const settings = await loadFollowSettings();
  if (cancelled()) return { ok: false, error: "stopped" };
  let rt = await loadFollowRuntime();

  const ready = await ensureXTabReady(cancelled);
  if (generation !== runGeneration) return { ok: false, error: "stopped" };
  if (!ready.ok) return { ok: false, error: ready.error || "no_x_tab" };

  if (settings.sourceMode === "list") {
    const handles = parseHandleList(settings.usernameList);
    if (handles.length === 0) return { ok: false, error: "empty_list" };
    const followed = await loadFollowHistory(getXConnection().handle || "");
    if (cancelled()) return { ok: false, error: "stopped" };
    const queue = handles.filter(handle => !followed.has(handle.toLowerCase()));
    rt = {
      ...rt,
      running: true,
      account: normalizeFollowHandle(getXConnection().handle || "") || "",
      sourceMode: "list",
      startedAt: Date.now(),
      detail: `List · ${queue.length} handles`,
      queue: [...queue],
      seen: [],
      processed: 0,
      skipped: 0,
      emptyScrolls: 0,
      currentHandle: null,
      nextAt: Date.now(),
    };
    rt = pushFollowLog(rt, {
      handle: "",
      action: "info",
      message: `Start list · ${queue.length} handles`,
    });
  } else {
    const kol = normalizeFollowHandle(settings.kolHandle);
    if (!kol) return { ok: false, error: "bad_kol" };
    rt = {
      ...rt,
      running: true,
      account: normalizeFollowHandle(getXConnection().handle || "") || "",
      sourceMode: "kol_followers",
      startedAt: Date.now(),
      detail: `Followers @${kol}`,
      queue: [],
      seen: [],
      processed: 0,
      skipped: 0,
      emptyScrolls: 0,
      currentHandle: null,
      nextAt: Date.now(),
    };
    rt = pushFollowLog(rt, {
      handle: kol,
      action: "info",
      message: `Start quét followers @${kol}`,
    });
    await persist(rt, generation);
    if (cancelled()) return { ok: false, error: "stopped" };
    const nav = await navigateXTab(`https://x.com/${kol}/followers`, cancelled);
    if (!nav.ok) return { ok: false, error: nav.error || "navigate_failed" };
    await sleepMs(2500);
  }

  await persist(rt, generation);
  if (generation !== runGeneration) return { ok: false, error: "stopped" };
  scheduleNext(800);
  void runFollowTick();
  return { ok: true };
}

export async function stopFollowRunner(reason = "Đã dừng"): Promise<void> {
  runGeneration++;
  if (getXWorker() === "follow") stopAllXBrowse();
  
  let rt = await loadFollowRuntime();
  rt = {
    ...rt,
    running: false,
    detail: reason,
    currentHandle: null,
    nextAt: null,
  };
  rt = pushFollowLog(rt, { handle: "", action: "info", message: reason });
  await persist(rt);
  await chrome.alarms.clear(ALARM);
}

export async function onFollowAlarm(name: string): Promise<void> {
  if (name !== ALARM) return;
  await runFollowTick();
}

async function waitNavigating(res: XActionResult, handle: string): Promise<void> {
  if (
    res.error === "navigating_profile" ||
    res.error === "need_navigate_profile" ||
    res.error === "navigating_tweet"
  ) {
    const url = res.detail || `https://x.com/${handle}`;
    if (res.error === "need_navigate_profile") await navigateXTab(url);
    await sleepMs(2800);
  }
}

async function enrichSorsa(c: FollowCandidate): Promise<FollowCandidate> {
  const scoreRes = await fetchSorsaScore(c.handle);
  const sorsa =
    scoreRes.ok && typeof scoreRes.score === "number" ? scoreRes.score : null;
  return { ...c, sorsa };
}

function needsSorsaCheck(settings: FollowSettings): boolean {
  return settings.filters.sorsaMin != null || settings.filters.sorsaMax != null;
}

async function followViaProfile(
  handle: string,
  settings: FollowSettings,
  rt: FollowRuntime,
  cancelled: () => boolean,
): Promise<FollowRuntime> {
  const metaRes = await inspectFollowProfile(handle, cancelled);
  if (cancelled()) return rt;
  if (metaRes.error === "x_page_cooling_down") return { ...rt, queue: [handle, ...rt.queue], currentHandle: null };
  const observed = metaRes.meta as { onProfile?: boolean; verified?: boolean; hasFollowButton?: boolean; alreadyFollowing?: boolean; ownProfile?: boolean } | undefined;
  if (!metaRes.ok || !observed || observed.onProfile !== true || typeof observed.verified !== "boolean" ||
      !(observed.hasFollowButton || observed.alreadyFollowing || observed.ownProfile)) {
    return pushFollowLog({ ...rt, processed: rt.processed + 1, skipped: rt.skipped + 1, seen: [...rt.seen, handle], currentHandle: null },
      { handle, action: "skip", reason: "follow_profile_unverified", message: `Skip @${handle}: profile data unavailable` });
  }
  const meta = (metaRes.meta || {}) as Partial<FollowCandidate> & {
    hasFollowButton?: boolean;
    onProfile?: boolean;
  };
  let candidate: FollowCandidate = {
    handle,
    verified: !!meta.verified,
    followers: typeof meta.followers === "number" ? meta.followers : null,
    sorsa: null,
    alreadyFollowing: !!meta.alreadyFollowing,
    ownProfile: !!meta.ownProfile,
  };
  if (candidate.alreadyFollowing) {
    return pushFollowLog({ ...rt, skipped: rt.skipped + 1, processed: rt.processed + 1,
      seen: [...rt.seen, handle], currentHandle: null },
      { handle, action: "skip", reason: "already_following", message: `Đã Following @${handle} — bỏ qua` });
  }
  if (needsSorsaCheck(settings)) candidate = await enrichSorsa(candidate);
  if (cancelled()) return rt;
  const latestSettings = await loadFollowSettings();
  if (cancelled()) return rt;
  const ev = evaluateFollowCandidate(candidate, latestSettings.filters);
  if (!ev.ok) {
    rt = {
      ...rt,
      skipped: rt.skipped + 1,
      processed: rt.processed + 1,
      seen: [...rt.seen, handle],
      currentHandle: null,
    };
    return pushFollowLog(rt, {
      handle,
      action: "skip",
      reason: ev.reason,
      message: `skip @${handle} · ${ev.reason}`,
    });
  }

  let followRes = await budgetedFollow(cancelled, () => requestFollow({ authorHandle: handle, tweetUrl: null }), candidate);
  if (cancelled()) return rt;
  await waitNavigating(followRes, handle);
  if (
    followRes.error === "navigating_profile" ||
    followRes.error === "timeout" ||
    followRes.error === "busy"
  ) {
    await sleepMs(2000);
    followRes = await budgetedFollow(cancelled, () => requestFollow({ authorHandle: handle, tweetUrl: null }), candidate);
  }

  if (followRes.ok) {
    if (["already_following", "own_profile"].includes(followRes.detail || "")) {
      rt = {
        ...rt,
        skipped: rt.skipped + 1,
        processed: rt.processed + 1,
        seen: [...rt.seen, handle],
        currentHandle: null,
      };
      return pushFollowLog(rt, {
        handle,
        action: "skip",
        reason: followRes.detail,
        message: `skip @${handle} · ${followRes.detail}`,
      });
    }
    rt = noteFollowSuccess({
      ...rt,
      seen: [...rt.seen, handle],
      currentHandle: null,
    });
    rt = pushFollowLog(rt, {
      handle,
      action: "follow",
      message: `follow @${handle}${candidate.sorsa != null ? ` · Sorsa ${candidate.sorsa}` : ""}`,
    });
    if (latestSettings.engageLatestPost && followRes.detail !== "follow_requested") {
      rt.postFollow = { handle, account: normalizeFollowHandle(getXConnection().handle || "") || "", attempts: 0, expiresAt: Date.now() + 5 * 60000 };
      await saveFollowRuntime(rt, cancelled);
      if (!cancelled()) rt = await finishPostFollow(rt, cancelled);
    }
    return rt;
  }

  const unavailable =
    followRes.error === "profile_suspended" ||
    followRes.error === "profile_restricted" ||
    followRes.error === "profile_missing" ||
    followRes.error === "profile_unavailable";

  rt = {
    ...rt,
    skipped: rt.skipped + 1,
    processed: rt.processed + 1,
    seen: [...rt.seen, handle],
    currentHandle: null,
  };
  return pushFollowLog(rt, {
    handle,
    action: unavailable ? "skip" : "error",
    reason: followRes.error || "follow_failed",
    message: unavailable
      ? `skip @${handle} · ${followRes.error} → next`
      : `error @${handle} · ${followRes.error || followRes.detail || "fail"}`,
  });
}

async function finishPostFollow(rt: FollowRuntime, cancelled: () => boolean): Promise<FollowRuntime> {
  const pending = rt.postFollow;
  if (!pending || cancelled()) return rt;
  const settings = await loadFollowSettings();
  const account = normalizeFollowHandle(getXConnection().handle || "") || "";
  if (settings.sourceMode !== "list" || !settings.engageLatestPost || pending.account !== account ||
      pending.expiresAt <= Date.now() || pending.attempts >= 3) {
    await cancelFollowPostInteraction(pending.account, pending.handle);
    return pushFollowLog({ ...rt, postFollow: undefined }, { handle: pending.handle, action: "info", message: "Bỏ lượt tương tác sau Follow: đã dừng, hết thời gian hoặc đổi cấu hình/tài khoản." });
  }
  rt = { ...rt, postFollow: { ...pending, attempts: pending.attempts + 1 }, detail: `Đang tương tác bài mới nhất @${pending.handle}` };
  await saveFollowRuntime(rt, cancelled);
  if (cancelled()) return rt;
  let tweet = pending.tweet;
  if (!tweet) {
    const profile = await inspectFollowProfile(pending.handle, cancelled);
    if (cancelled()) return rt;
    if (!profile.ok) return pushFollowLog(rt, { handle: pending.handle, action: "error", reason: profile.error, message: `Chưa đọc được profile sau Follow · ${profile.error}` });
    const scan = await requestLatestProfilePost(pending.handle);
    if (cancelled()) return rt;
    tweet = sanitizeTimelineTweets(scan.tweets).find(post => post.authorHandle.toLowerCase() === pending.handle.toLowerCase() && !post.promoted);
    if (!tweet) {
      const retry = !scan.ok && scan.error !== "profile_has_no_posts";
      return pushFollowLog({ ...rt, postFollow: retry ? rt.postFollow : undefined },
        { handle: pending.handle, action: retry ? "error" : "info", reason: scan.error, message: `Bài mới nhất: ${scan.error || "không có bài phù hợp"}` });
    }
    rt.postFollow = { ...rt.postFollow!, tweet };
    await saveFollowRuntime(rt, cancelled);
  }
  if (cancelled()) return rt;
  const result = await interactWithFollowedPost(tweet, cancelled);
  if (cancelled()) return rt;
  return pushFollowLog({ ...rt, postFollow: result.complete ? undefined : rt.postFollow },
    { handle: pending.handle, action: "info", message: `Sau Follow · ${result.detail}` });
}

async function processCellCandidate(
  raw: Record<string, unknown>,
  settings: FollowSettings,
  rt: FollowRuntime,
  cancelled: () => boolean,
): Promise<FollowRuntime> {
  const handle = normalizeFollowHandle(String(raw.handle || ""));
  if (!handle || rt.seen.includes(handle)) return rt;

  let candidate: FollowCandidate = {
    handle,
    verified: !!raw.verified,
    followers: typeof raw.followers === "number" ? raw.followers : null,
    sorsa: null,
    alreadyFollowing: !!raw.alreadyFollowing,
  };

  // Acc đã follow / filter cứng — skip ngay, không chờ Sorsa.
  if (candidate.alreadyFollowing) {
    await rememberFollow(getXConnection().handle || "", handle);
    rt = {
      ...rt,
      skipped: rt.skipped + 1,
      processed: rt.processed + 1,
      seen: [...rt.seen, handle],
      currentHandle: null,
    };
    return pushFollowLog(rt, {
      handle,
      action: "skip",
      reason: "already_following",
      message: `skip @${handle} · already_following`,
    });
  }
  if (settings.filters.blacklist.includes(handle)) {
    rt = {
      ...rt,
      skipped: rt.skipped + 1,
      processed: rt.processed + 1,
      seen: [...rt.seen, handle],
      currentHandle: null,
    };
    return pushFollowLog(rt, {
      handle,
      action: "skip",
      reason: "blacklist",
      message: `skip @${handle} · blacklist`,
    });
  }
  if (settings.filters.verified === "require" && !candidate.verified) {
    rt = {
      ...rt,
      skipped: rt.skipped + 1,
      processed: rt.processed + 1,
      seen: [...rt.seen, handle],
      currentHandle: null,
    };
    return pushFollowLog(rt, {
      handle,
      action: "skip",
      reason: "verified_required",
      message: `skip @${handle} · verified_required`,
    });
  }
  if (settings.filters.verified === "exclude" && candidate.verified) {
    rt = {
      ...rt,
      skipped: rt.skipped + 1,
      processed: rt.processed + 1,
      seen: [...rt.seen, handle],
      currentHandle: null,
    };
    return pushFollowLog(rt, {
      handle,
      action: "skip",
      reason: "verified_excluded",
      message: `skip @${handle} · verified_excluded`,
    });
  }

  if (candidate.followers == null &&
    (settings.filters.followersMin != null || settings.filters.followersMax != null)) {
    return followViaProfile(handle, settings, rt, cancelled);
  }

  if (needsSorsaCheck(settings)) candidate = await enrichSorsa(candidate);
  if (cancelled()) return rt;
  const latestSettings = await loadFollowSettings();
  if (cancelled()) return rt;
  const ev = evaluateFollowCandidate(candidate, latestSettings.filters);
  if (!ev.ok) {
    rt = {
      ...rt,
      skipped: rt.skipped + 1,
      processed: rt.processed + 1,
      seen: [...rt.seen, handle],
      currentHandle: null,
    };
    return pushFollowLog(rt, {
      handle,
      action: "skip",
      reason: ev.reason,
      message: `skip @${handle} · ${ev.reason}`,
    });
  }

  // Prefer in-cell follow; fallback profile.
  let res = await budgetedFollow(cancelled, () => requestFollowInCell(handle), candidate);
  if (!res.ok && (res.error === "cell_not_found" || res.error === "follow_btn_missing")) {
    return followViaProfile(handle, settings, rt, cancelled);
  }

  if (res.ok && res.detail === "already_following") {
    rt = {
      ...rt,
      skipped: rt.skipped + 1,
      processed: rt.processed + 1,
      seen: [...rt.seen, handle],
      currentHandle: null,
    };
    return pushFollowLog(rt, {
      handle,
      action: "skip",
      reason: "already_following",
      message: `skip @${handle} · already_following`,
    });
  }

  if (res.ok) {
    rt = noteFollowSuccess({
      ...rt,
      seen: [...rt.seen, handle],
      currentHandle: null,
    });
    return pushFollowLog(rt, {
      handle,
      action: "follow",
      message: `follow @${handle}${candidate.sorsa != null ? ` · Sorsa ${candidate.sorsa}` : ""}`,
    });
  }

  rt = {
    ...rt,
    skipped: rt.skipped + 1,
    processed: rt.processed + 1,
    seen: [...rt.seen, handle],
    currentHandle: null,
  };
  return pushFollowLog(rt, {
    handle,
    action: "error",
    reason: res.error || "follow_failed",
    message: `error @${handle} · ${res.error || "fail"}`,
  });
}

export async function runFollowTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  const generation = runGeneration;
  let account = "";
  const accountChanged = () => !!(account && getXConnection().handle &&
    normalizeFollowHandle(getXConnection().handle || "") !== account);
  const cancelled = () => generation !== runGeneration || accountChanged();
  let release: (() => void) | null = null;
  try {
    release = await acquireXTurn("follow", cancelled);
    if (!release) return;
    let rt = await loadFollowRuntime();
    if (!rt.running) return;
    account = normalizeFollowHandle(rt.account || getXConnection().handle || "") || "";
    if (accountChanged()) return;
    rt = { ...rt, account };
    const settings = await loadFollowSettings();
    if (cancelled()) return;
    const pageDelay = await xPageRetryDelay();
    if (pageDelay > 0) {
      await persist({ ...rt, detail: "X tải chậm — tạm nghỉ, không mở thêm profile.", nextAt: Date.now() + pageDelay }, generation);
      if (!cancelled()) scheduleNext(pageDelay);
      return;
    }
    if (rt.nextAt != null && rt.nextAt > Date.now()) { scheduleNext(rt.nextAt - Date.now()); return; }

    if (!getXConnection().connected) {
      rt = { ...rt, detail: "Chờ tab X…" };
      await persist(rt, generation);
      if (!cancelled()) scheduleNext(3000);
      return;
    }

    if (rt.postFollow) {
      rt = await finishPostFollow(rt, cancelled);
      if (cancelled()) return;
      await finishFollowTick(rt, generation);
      return;
    }

    const gate = canFollowNow(rt, settings);
    if (!gate.ok) {
      if (gate.reason === "daily_limit") {
        await stopFollowRunner("Đạt mục tiêu / ngày");
        return;
      }
      const wait = gate.waitMs ?? 60_000;
      rt = {
        ...rt,
        detail: `Chờ nhịp 30 phút (~${Math.ceil(wait / 1000)}s)`,
        nextAt: Date.now() + wait,
      };
      await persist(rt, generation);
      if (!cancelled()) scheduleNext(wait);
      return;
    }

    if (rt.sourceMode === "list") {
      const next = rt.queue.find((h) => !rt.seen.includes(h));
      if (!next) {
        await stopFollowRunner("Hết danh sách");
        return;
      }
      rt = {
        ...rt,
        queue: rt.queue.filter((h) => h !== next),
        currentHandle: next,
        detail: `Đang xử lý @${next}`,
      };
      await persist(rt, generation);
      rt = await followViaProfile(next, settings, rt, cancelled);
      if (cancelled()) return;
      await finishFollowTick(rt, generation);
      return;
    }

    // Another worker may have used the shared tab since our last tick.
    const kol = normalizeFollowHandle(settings.kolHandle);
    const target = kol ? `https://x.com/${kol}/followers` : "";
    if (!target) { await stopFollowRunner("Invalid KOL handle"); return; }
    if (getXConnection().url?.replace(/\?.*$/, "").replace(/\/$/, "") !== target) {
      const nav = await navigateXTab(target, cancelled);
      if (cancelled()) return;
      if (!nav.ok || !(await waitForXConnection(15000, nav.tabId)).ok) { scheduleNext(3000); return; }
    }
    const scan = await requestFollowScanCells(rt.seen);
    if (cancelled()) return;
    if (!scan.ok) {
      rt = pushFollowLog({ ...rt, detail: `Quét followers lỗi · ${scan.error || "unknown"}`, currentHandle: null },
        { handle: "", action: "error", reason: scan.error, message: `scan · ${scan.error || "unknown"}` });
      await persist(rt, generation);
      if (!cancelled()) scheduleNext(3000);
      return;
    }
    const candidates = Array.isArray(scan.candidates)
      ? (scan.candidates as Record<string, unknown>[])
      : [];
    const fresh = candidates.filter((c) => {
      const h = normalizeFollowHandle(String(c.handle || ""));
      return h && !rt.seen.includes(h);
    });

    if (fresh.length === 0) {
      rt = { ...rt, emptyScrolls: rt.emptyScrolls + 1, detail: "Cuộn thêm followers…" };
      await persist(rt, generation);
      if (rt.emptyScrolls >= 8) {
        await stopFollowRunner("Hết acc mới trên danh sách");
        return;
      }
      await requestFollowScrollList(5);
      await sleepMs(500);
      if (cancelled()) return;
      scheduleNext(600);
      return;
    }

    rt = { ...rt, emptyScrolls: 0 };
    const pick = fresh[0]!;
    const handle = normalizeFollowHandle(String(pick.handle || ""))!;
    rt = { ...rt, currentHandle: handle, detail: `Đang xử lý @${handle}` };
    await persist(rt, generation);
    rt = await processCellCandidate(pick, settings, rt, cancelled);
    if (cancelled()) return;

    await finishFollowTick(rt, generation);
  } catch (e) {
    if (cancelled()) return;
    if (e instanceof FollowBudgetWait) {
      let rt = await loadFollowRuntime();
      if (rt.sourceMode === "list" && rt.currentHandle && !rt.queue.includes(rt.currentHandle))
        rt = { ...rt, queue: [rt.currentHandle, ...rt.queue] };
      const daily = e.message === "daily_target_reached";
      rt = { ...rt, running: !daily, currentHandle: null, nextAt: daily ? null : Date.now() + 60000,
        detail: daily ? "Đã đủ mục tiêu Follow dùng chung hôm nay." : "Chờ giới hạn Follow trong 30 phút." };
      await persist(rt, generation);
      if (!daily && !cancelled()) scheduleNext(60000);
      return;
    }
    console.error(LOG, e);
    let rt = await loadFollowRuntime();
    rt = pushFollowLog(rt, {
      handle: "",
      action: "error",
      message: e instanceof Error ? e.message : String(e),
    });
    rt = { ...rt, detail: "Lỗi — thử lại" };
    await persist(rt, generation);
    if (!cancelled() && rt.running) scheduleNext(5000);
  } finally {
    try {
      if (generation === runGeneration && accountChanged()) {
        await stopFollowRunner("Tài khoản X đã thay đổi — bắt đầu phiên mới để tiếp tục.");
      }
    } finally {
      release?.();
      tickInFlight = false;
    }
  }
}
