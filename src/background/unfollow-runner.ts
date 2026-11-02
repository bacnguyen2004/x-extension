import { acquireXTurn, startExclusiveX, getXWorker } from "./x-coordinator.ts";
/**
 * Orchestrator Tab Unfollow: own Following / list + protect filters.
 */

import { normalizeFollowHandle, parseHandleList } from "../domain/follow-settings.ts";
import {
  evaluateUnfollowCandidate,
  prioritizeUnfollowCandidates,
  type UnfollowCandidate,
  type UnfollowSettings,
} from "../domain/unfollow-settings.ts";
import { fetchSorsaScoresBatch } from "./sorsa-store.ts";
import {
  canUnfollowNow,
  loadUnfollowRuntime,
  loadUnfollowSettings,
  noteUnfollowSuccess,
  pushUnfollowLog,
  randomUnfollowDelayMs,
  saveUnfollowRuntime,
  saveUnfollowSettings,
  toUnfollowPublic,
  type UnfollowRuntime,
} from "./unfollow-store.ts";
import {
  getXConnection,
  navigateXTab,
  requestFollowScanCells,
  requestFollowScrollList,
  requestUnfollowInCell,
  sleepMs,
  waitForXConnection,
  stopAllXBrowse,
} from "./x-bridge.ts";
import { loadAgentSettings } from "./agent-store.ts";
import { xPageRetryDelay } from "./x-page-health.ts";

const ALARM = "x-unfollow-tick";
const LOG = "[x-content-creator/unfollow]";

let tickInFlight = false;
let runGeneration = 0;

function notifyUi(): void {
  void (async () => {
    const settings = await loadUnfollowSettings();
    const rt = await loadUnfollowRuntime();
    try {
      await chrome.runtime.sendMessage({
        type: "unfollow_state",
        unfollow: toUnfollowPublic(rt, settings),
        settings,
      });
    } catch {
      /* no listeners */
    }
  })();
}

async function persist(rt: UnfollowRuntime, generation = runGeneration): Promise<UnfollowRuntime> {
  if (generation !== runGeneration) return rt;
  await saveUnfollowRuntime(rt);
  notifyUi();
  return rt;
}

function scheduleNext(ms: number): void {
  void chrome.alarms.clear(ALARM);
  // Cho phép delay 0 — sàn 50ms để SW kịp yield.
  void chrome.alarms.create(ALARM, { when: Date.now() + Math.max(50, ms) });
}

/** Delay đầy đủ chỉ sau unfollow thật; skip/protect/error → next rất nhanh. */
function delayAfterOutcome(settings: UnfollowSettings, rt: UnfollowRuntime): number {
  return Math.max(8000, randomUnfollowDelayMs(settings));
}

function needsSorsaCheck(settings: UnfollowSettings): boolean {
  return (
    settings.protect.sorsaMin != null ||
    settings.protect.protectMissingSorsa ||
    settings.targets.sorsaMax != null
  );
}

/** Áp dụng giới hạn ngay sau kết quả, không chờ tick kế tiếp mới hiển thị nghỉ. */
async function finishUnfollowTick(rt: UnfollowRuntime, cancelled: () => boolean): Promise<void> {
  const settings = await loadUnfollowSettings();
  if (cancelled()) return;
  const gate = canUnfollowNow(rt, settings);
  if (!gate.ok && gate.reason === "daily_limit") {
    rt = pushUnfollowLog({ ...rt, running: false, currentHandle: null, nextAt: null,
      detail: "Đạt mục tiêu / ngày" }, { handle: "", action: "info", message: "Đạt mục tiêu / ngày" });
    await persist(rt);
    if (!cancelled()) await chrome.alarms.clear(ALARM);
    return;
  }
  const delay = gate.ok ? delayAfterOutcome(settings, rt) : gate.waitMs ?? 60_000;
  rt = { ...rt, currentHandle: null,
    detail: gate.ok ? `Chờ ${Math.round(delay / 1000)}s…`
      : `Đạt giới hạn ${settings.pace.maxPer30Min}/30 phút · Chờ ${Math.ceil(delay / 1000)}s`,
    nextAt: Date.now() + delay };
  await persist(rt);
  if (!cancelled() && rt.running) scheduleNext(delay);
}

export async function getUnfollowPublicState() {
  const settings = await loadUnfollowSettings();
  const rt = await loadUnfollowRuntime();
  return { unfollow: toUnfollowPublic(rt, settings), settings };
}

async function resolveOwnHandle(settings: UnfollowSettings): Promise<string | null> {
  const fromSettings = normalizeFollowHandle(settings.ownHandle || "");
  if (fromSettings) return fromSettings;

  const fromX = normalizeFollowHandle(getXConnection().handle || "");
  if (fromX) return fromX;

  try {
    const agent = await loadAgentSettings();
    const fromAgent = normalizeFollowHandle(agent.ownHandle || "");
    if (fromAgent) return fromAgent;
  } catch {
    /* ignore */
  }

  return null;
}

/** Mở trang Following của mình rồi đợi content sẵn sàng. */
async function openOwnFollowing(handle: string, cancelled: () => boolean = () => false): Promise<{ ok: boolean; error?: string }> {
  const url = `https://x.com/${handle}/following`;
  const nav = await navigateXTab(url, cancelled);
  if (cancelled()) return { ok: false, error: "stopped" };
  if (!nav.ok) return { ok: false, error: nav.error || "navigate_failed" };
  const ready = await waitForXConnection(15_000);
  if (cancelled()) return { ok: false, error: "stopped" };
  if (!ready.ok) return { ok: false, error: ready.error || "no_x_tab" };
  await sleepMs(1200);
  if (cancelled()) return { ok: false, error: "stopped" };
  return { ok: true };
}

export async function startUnfollowRunner(): Promise<{ ok: boolean; error?: string }> {
  return startExclusiveX("unfollow", startUnfollowRunnerExclusive);
}

async function startUnfollowRunnerExclusive(): Promise<{ ok: boolean; error?: string }> {
  const generation = ++runGeneration;
  const release = await acquireXTurn("unfollow", () => generation !== runGeneration);
  if (!release) return { ok: false, error: "stopped" };
  try {
    const result = await startUnfollowRunnerOwned(generation);
    if (!result.ok && generation === runGeneration) await stopUnfollowRunner("Không thể bắt đầu Unfollow.");
    return result;
  } finally { release(); }
}

async function startUnfollowRunnerOwned(generation: number): Promise<{ ok: boolean; error?: string }> {
  const cancelled = () => generation !== runGeneration;
  let settings = await loadUnfollowSettings();
  if (cancelled()) return { ok: false, error: "stopped" };
  let rt = await loadUnfollowRuntime();
  if (cancelled()) return { ok: false, error: "stopped" };

  if (settings.sourceMode === "list" && parseHandleList(settings.usernameList).length === 0) {
    return { ok: false, error: "empty_list" };
  }
  {
    // Following của tôi — luôn mở /following khi Start.
    let own = await resolveOwnHandle(settings);
    if (cancelled()) return { ok: false, error: "stopped" };
    if (!own) {
      // Mở Home để content script nhận handle từ profile link.
      const home = await navigateXTab("https://x.com/home", cancelled);
      if (cancelled()) return { ok: false, error: "stopped" };
      if (!home.ok) return { ok: false, error: home.error || "navigate_failed" };
      await waitForXConnection(15_000);
      if (cancelled()) return { ok: false, error: "stopped" };
      await sleepMs(1500);
      if (cancelled()) return { ok: false, error: "stopped" };
      own = await resolveOwnHandle(settings);
      if (cancelled()) return { ok: false, error: "stopped" };
    }
    if (!own) return { ok: false, error: "no_own_handle" };

    // Nhớ handle để lần sau Start không hỏi lại.
    if (settings.ownHandle !== own) {
      settings = await saveUnfollowSettings({ ...settings, ownHandle: own });
      if (cancelled()) return { ok: false, error: "stopped" };
    }

    rt = {
      ...rt,
      running: true,
      account: normalizeFollowHandle(getXConnection().handle || "") || "",
      sourceMode: settings.sourceMode,
      startedAt: Date.now(),
      detail: `Opening Following @${own}…`,
      queue: settings.sourceMode === "list" ? parseHandleList(settings.usernameList) : [],
      seen: [],
      processed: 0,
      protectedCount: 0,
      skipped: 0,
      emptyScrolls: 0,
      currentHandle: null,
      nextAt: Date.now(),
    };
    rt = pushUnfollowLog(rt, {
      handle: own,
      action: "info",
      message: `Mở Following @${own}`,
    });
    await persist(rt, generation);
    if (cancelled()) return { ok: false, error: "stopped" };

    const opened = await openOwnFollowing(own, cancelled);
    if (cancelled()) return { ok: false, error: "stopped" };
    if (!opened.ok) return { ok: false, error: opened.error || "navigate_failed" };

    rt = {
      ...rt,
      detail: `Following @${own}`,
    };
    rt = pushUnfollowLog(rt, {
      handle: own,
      action: "info",
      message: `Start quét Following @${own}`,
    });
  }

  await persist(rt, generation);
  if (cancelled()) return { ok: false, error: "stopped" };
  scheduleNext(600);
  void runUnfollowTick();
  return { ok: true };
}

export async function stopUnfollowRunner(reason = "Đã dừng"): Promise<void> {
  runGeneration++;
  if (getXWorker() === "unfollow") stopAllXBrowse();
  
  let rt = await loadUnfollowRuntime();
  rt = {
    ...rt,
    running: false,
    detail: reason,
    currentHandle: null,
    nextAt: null,
  };
  rt = pushUnfollowLog(rt, { handle: "", action: "info", message: reason });
  await persist(rt);
  await chrome.alarms.clear(ALARM);
}

export async function onUnfollowAlarm(name: string): Promise<void> {
  if (name !== ALARM) return;
  await runUnfollowTick();
}

function applySorsaScore(
  c: UnfollowCandidate,
  scores: Record<string, { score: number | null } | { error: string }>,
): UnfollowCandidate {
  const hit = scores[c.handle];
  if (!hit) return { ...c, sorsa: null };
  if ("score" in hit) return { ...c, sorsa: hit.score };
  return { ...c, sorsa: null };
}

/**
 * Check + xử lý nhiều UserCell trong 1 tick.
 * Protect/skip chạy liên tục; dừng khi gặp unfollow thật.
 */
async function processFollowingBatch(
  raws: Record<string, unknown>[],
  settings: UnfollowSettings,
  rt: UnfollowRuntime,
  cancelled: () => boolean,
): Promise<{ rt: UnfollowRuntime; didUnfollow: boolean }> {
  const prepared: { raw: Record<string, unknown>; handle: string; c: UnfollowCandidate }[] = [];
  for (const raw of raws) {
    const handle = normalizeFollowHandle(String(raw.handle || ""));
    if (!handle || rt.seen.includes(handle) || prepared.some((p) => p.handle === handle)) {
      continue;
    }
    prepared.push({
      raw,
      handle,
      c: {
        handle,
        verified: !!raw.verified,
        followers: typeof raw.followers === "number" ? raw.followers : null,
        sorsa: null,
        following: raw.alreadyFollowing === true,
        followsYou:
          raw.followsYou === true ? true : raw.followsYou === false ? false : null,
      },
    });
  }
  if (prepared.length === 0) return { rt, didUnfollow: false };

  const needScore = needsSorsaCheck(settings)
    ? prepared
        .filter((p) => {
          if (!p.c.following) return false;
          if (settings.protect.whitelist.includes(p.handle)) return false;
          if (settings.protect.protectVerified && p.c.verified) return false;
          return true;
        })
        .map((p) => p.handle)
    : [];

  const batchScores =
    needScore.length > 0
      ? (await fetchSorsaScoresBatch(needScore)).scores
      : ({} as Record<string, { score: number | null } | { error: string }>);

  let didUnfollow = false;
  for (const item of prepared) {
    if (cancelled()) return { rt, didUnfollow };
    if (didUnfollow) break;
    if (rt.seen.includes(item.handle)) continue;

    rt = {
      ...rt,
      currentHandle: item.handle,
      detail: `Check @${item.handle}`,
    };
    await persist(rt);
    if (cancelled()) return { rt, didUnfollow };

    // Early paths không cần Sorsa
    if (!item.c.following) {
      rt = {
        ...rt,
        skipped: rt.skipped + 1,
        processed: rt.processed + 1,
        seen: [...rt.seen, item.handle],
        currentHandle: null,
      };
      rt = pushUnfollowLog(rt, {
        handle: item.handle,
        action: "skip",
        reason: "not_following",
        message: `skip @${item.handle} · not_following`,
      });
      continue;
    }
    if (settings.protect.whitelist.includes(item.handle)) {
      rt = {
        ...rt,
        protectedCount: rt.protectedCount + 1,
        processed: rt.processed + 1,
        seen: [...rt.seen, item.handle],
        currentHandle: null,
      };
      rt = pushUnfollowLog(rt, {
        handle: item.handle,
        action: "protect",
        reason: "whitelist",
        message: `protect @${item.handle} · whitelist`,
      });
      continue;
    }
    if (settings.protect.protectVerified && item.c.verified) {
      rt = {
        ...rt,
        protectedCount: rt.protectedCount + 1,
        processed: rt.processed + 1,
        seen: [...rt.seen, item.handle],
        currentHandle: null,
      };
      rt = pushUnfollowLog(rt, {
        handle: item.handle,
        action: "protect",
        reason: "verified",
        message: `protect @${item.handle} · verified`,
      });
      continue;
    }

    const candidate = needsSorsaCheck(settings)
      ? applySorsaScore(item.c, batchScores)
      : item.c;
    const latestSettings = await loadUnfollowSettings();
    if (cancelled()) return { rt, didUnfollow };
    const decision = evaluateUnfollowCandidate(candidate, latestSettings);

    if (decision.action === "protect") {
      rt = {
        ...rt,
        protectedCount: rt.protectedCount + 1,
        processed: rt.processed + 1,
        seen: [...rt.seen, item.handle],
        currentHandle: null,
      };
      rt = pushUnfollowLog(rt, {
        handle: item.handle,
        action: "protect",
        reason: decision.reason,
        message: `protect @${item.handle} · ${decision.reason}`,
      });
      continue;
    }
    if (decision.action === "skip") {
      rt = {
        ...rt,
        skipped: rt.skipped + 1,
        processed: rt.processed + 1,
        seen: [...rt.seen, item.handle],
        currentHandle: null,
      };
      rt = pushUnfollowLog(rt, {
        handle: item.handle,
        action: "skip",
        reason: decision.reason,
        message: `skip @${item.handle} · ${decision.reason}`,
      });
      continue;
    }

    // Unfollow thật — 1 cái rồi dừng batch (giữ pace)
    if (!canUnfollowNow(rt, latestSettings).ok) return { rt, didUnfollow };
    const res = await requestUnfollowInCell(item.handle);
    if (res.ok && res.detail === "already_not_following") {
      rt = pushUnfollowLog({ ...rt, processed: rt.processed + 1, skipped: rt.skipped + 1,
        seen: [...rt.seen, item.handle], currentHandle: null },
        { handle: item.handle, action: "skip", reason: "not_following", message: `skip @${item.handle} · not_following` });
      continue;
    }
    if (res.ok) {
      rt = noteUnfollowSuccess({
        ...rt,
        seen: [...rt.seen, item.handle],
        currentHandle: null,
      });
      rt = pushUnfollowLog(rt, {
        handle: item.handle,
        action: "unfollow",
        message: `unfollow @${item.handle}${
          candidate.sorsa != null ? ` · Sorsa ${candidate.sorsa}` : ""
        }`,
      });
      didUnfollow = true;
      break;
    }
    rt = {
      ...rt,
      skipped: rt.skipped + 1,
      processed: rt.processed + 1,
      seen: [...rt.seen, item.handle],
      currentHandle: null,
    };
    rt = pushUnfollowLog(rt, {
      handle: item.handle,
      action: "error",
      reason: res.error || "fail",
      message: `error @${item.handle} · ${res.error || "fail"}`,
    });
  }

  return { rt, didUnfollow };
}

export async function runUnfollowTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  const generation = runGeneration;
  let account = "";
  const accountChanged = () => !!(account && getXConnection().handle &&
    normalizeFollowHandle(getXConnection().handle || "") !== account);
  const cancelled = () => generation !== runGeneration || accountChanged();
  let release: (() => void) | null = null;
  try {
    release = await acquireXTurn("unfollow", () => generation !== runGeneration);
    if (!release) return;
    let rt = await loadUnfollowRuntime();
    if (!rt.running) return;
    account = normalizeFollowHandle(rt.account || getXConnection().handle || "") || "";
    if (accountChanged()) return;
    rt = { ...rt, account };
    const settings = await loadUnfollowSettings();
    if (cancelled()) return;
    const pageDelay = await xPageRetryDelay();
    if (cancelled()) return;
    if (pageDelay > 0) {
      if (cancelled()) return;
      await persist({ ...rt, detail: "X tải chậm — tạm nghỉ quét Following.", nextAt: Date.now() + pageDelay });
      if (!cancelled()) scheduleNext(pageDelay);
      return;
    }
    if (rt.nextAt != null && rt.nextAt > Date.now()) { scheduleNext(rt.nextAt - Date.now()); return; }

    if (!getXConnection().connected) {
      rt = { ...rt, detail: "Chờ tab X…" };
      await persist(rt);
      scheduleNext(3000);
      return;
    }

    const gate = canUnfollowNow(rt, settings);
    if (!gate.ok) {
      if (gate.reason === "daily_limit") {
        await stopUnfollowRunner("Đạt mục tiêu / ngày");
        return;
      }
      const wait = gate.waitMs ?? 60_000;
      rt = {
        ...rt,
        detail: `Chờ nhịp 30 phút (~${Math.ceil(wait / 1000)}s)`,
        nextAt: Date.now() + wait,
      };
      await persist(rt);
      scheduleNext(wait);
      return;
    }

    const selectedHandles = rt.sourceMode === "list" ? new Set(rt.queue) : null;
    if (selectedHandles && [...selectedHandles].every(handle => rt.seen.includes(handle))) {
      await stopUnfollowRunner("Đã xử lý hết danh sách đã chọn trong Following");
      return;
    }

    // own_following — đảm bảo đang ở /following
    const own = normalizeFollowHandle(settings.ownHandle || "") || (await resolveOwnHandle(settings));
    if (cancelled()) return;
    const href = getXConnection().url || "";
    const onFollowing = !!own && href.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com/i, "").split("?")[0].replace(/\/$/, "").toLowerCase() === `/${own.toLowerCase()}/following`;
    if (!own) {
      await stopUnfollowRunner("Chưa xác định được tài khoản để mở Following");
      return;
    }
    if (!onFollowing) {
      rt = {
        ...rt,
        detail: `Quay lại Following @${own}…`,
        currentHandle: null,
      };
      await persist(rt);
      const opened = await openOwnFollowing(own, cancelled);
      if (cancelled()) return;
      if (!opened.ok) {
        rt = { ...rt, detail: `Lỗi mở Following · ${opened.error || "?"}` };
        await persist(rt);
        scheduleNext(3000);
        return;
      }
    }

    const scan = await requestFollowScanCells(rt.seen);
    if (cancelled()) return;
    if (!scan.ok) {
      rt = {
        ...rt,
        detail: `Scan lỗi · ${scan.error}`,
        currentHandle: null,
      };
      rt = pushUnfollowLog(rt, {
        handle: "",
        action: "error",
        message: `scan · ${scan.error}`,
      });
      await persist(rt);
      scheduleNext(2500);
      return;
    }
    const candidates = Array.isArray(scan.candidates)
      ? (scan.candidates as Record<string, unknown>[])
      : [];
    const fresh = candidates.filter((c) => {
      const h = normalizeFollowHandle(String(c.handle || ""));
      return h && !rt.seen.includes(h) && (!selectedHandles || selectedHandles.has(h));
    });

    if (fresh.length === 0) {
      const nextEmpty = rt.emptyScrolls + 1;
      rt = {
        ...rt,
        emptyScrolls: nextEmpty,
        currentHandle: null,
        detail: `Cuộn Following… ${nextEmpty}/16 · đã xem ${rt.seen.length}`,
      };
      rt = pushUnfollowLog(rt, {
        handle: "",
        action: "info",
        message: `scroll ${nextEmpty} · visible ${candidates.length} · seen ${rt.seen.length}`,
      });
      await persist(rt);
      if (nextEmpty >= 16) {
        await stopUnfollowRunner(`Hết acc mới · đã xem ${rt.seen.length}`);
        return;
      }
      await requestFollowScrollList(6);
      if (cancelled()) return;
      await sleepMs(1100);
      if (cancelled()) return;
      scheduleNext(800);
      return;
    }

    rt = { ...rt, emptyScrolls: 0 };
    const batch = prioritizeUnfollowCandidates(fresh, (c) => String(c.handle || ""), settings).slice(0, 20);
    rt = {
      ...rt,
      detail: `Check ${batch.length} acc… · Keep ${rt.protectedCount} · Skip ${rt.skipped}`,
    };
    await persist(rt);

    const result = await processFollowingBatch(batch, settings, rt, cancelled);
    if (cancelled()) return;
    rt = result.rt;

    await finishUnfollowTick(rt, cancelled);
  } catch (e) {
    if (cancelled()) return;
    console.error(LOG, e);
    let rt = await loadUnfollowRuntime();
    rt = pushUnfollowLog(rt, {
      handle: "",
      action: "error",
      message: e instanceof Error ? e.message : String(e),
    });
    rt = { ...rt, detail: "Lỗi — thử lại" };
    await persist(rt);
    if (rt.running) scheduleNext(5000);
  } finally {
    try {
      if (generation === runGeneration && accountChanged()) {
        await stopUnfollowRunner("Tài khoản X đã thay đổi — bắt đầu phiên mới để tiếp tục.");
      }
    } finally {
      release?.();
      tickInFlight = false;
    }
  }
}
