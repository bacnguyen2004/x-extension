/**
 * Persist Unfollow tab settings + runtime.
 */

import {
  createDefaultUnfollowSettings,
  sanitizeUnfollowSettings,
  type UnfollowLogEntry,
  type UnfollowRuntimePublic,
  type UnfollowSettings,
  type UnfollowSourceMode,
} from "../domain/unfollow-settings.ts";

const SETTINGS_KEY = "xContentCreator.unfollow.v1";
const RUNTIME_KEY = "xContentCreator.unfollowRuntime.v1";
const MAX_LOGS = 80;
const WINDOW_MS = 30 * 60 * 1000;

export interface UnfollowRuntime {
  account: string;
  running: boolean;
  sourceMode: UnfollowSourceMode;
  detail: string;
  startedAt: number | null;
  day: string;
  unfollowedToday: number;
  unfollowTimestamps: number[];
  processed: number;
  protectedCount: number;
  skipped: number;
  currentHandle: string | null;
  nextAt: number | null;
  seen: string[];
  queue: string[];
  emptyScrolls: number;
  logs: UnfollowLogEntry[];
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function createInitialUnfollowRuntime(): UnfollowRuntime {
  return {
    account: "",
    running: false,
    sourceMode: "own_following",
    detail: "Sẵn sàng",
    startedAt: null,
    day: todayKey(),
    unfollowedToday: 0,
    unfollowTimestamps: [],
    processed: 0,
    protectedCount: 0,
    skipped: 0,
    currentHandle: null,
    nextAt: null,
    seen: [],
    queue: [],
    emptyScrolls: 0,
    logs: [],
  };
}

function rollDay(rt: UnfollowRuntime): UnfollowRuntime {
  const day = todayKey();
  if (rt.day === day) return rt;
  // Hạn mức 30 phút chạy xuyên ngày, không được xóa lúc 00:00.
  return { ...rt, day, unfollowedToday: 0 };
}

export async function loadUnfollowSettings(): Promise<UnfollowSettings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeUnfollowSettings(raw[SETTINGS_KEY]);
}

export async function saveUnfollowSettings(settings: UnfollowSettings): Promise<UnfollowSettings> {
  const clean = sanitizeUnfollowSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  return clean;
}

export async function loadUnfollowRuntime(): Promise<UnfollowRuntime> {
  const raw = await chrome.storage.local.get(RUNTIME_KEY);
  const blob = raw[RUNTIME_KEY];
  if (!blob || typeof blob !== "object") return createInitialUnfollowRuntime();
  const o = blob as Partial<UnfollowRuntime>;
  const base = createInitialUnfollowRuntime();
  return rollDay({
    ...base,
    ...o,
    unfollowTimestamps: Array.isArray(o.unfollowTimestamps)
      ? o.unfollowTimestamps.filter((t) => typeof t === "number" && Number.isFinite(t))
      : [],
    seen: Array.isArray(o.seen) ? o.seen.map(String) : [],
    queue: Array.isArray(o.queue) ? o.queue.map(String) : [],
    logs: Array.isArray(o.logs) ? (o.logs as UnfollowLogEntry[]) : [],
    running: o.running === true,
  });
}

export async function saveUnfollowRuntime(rt: UnfollowRuntime): Promise<void> {
  await chrome.storage.local.set({ [RUNTIME_KEY]: rollDay(rt) });
}

export function countInWindow(timestamps: number[], now = Date.now()): number {
  const cut = now - WINDOW_MS;
  return timestamps.filter((t) => Number.isFinite(t) && t > cut && t <= now).length;
}

export function toUnfollowPublic(
  rt: UnfollowRuntime,
  settings: UnfollowSettings,
): UnfollowRuntimePublic {
  const rolled = rollDay(rt);
  return {
    running: rolled.running,
    sourceMode: rolled.sourceMode,
    detail: rolled.detail,
    startedAt: rolled.startedAt,
    unfollowedToday: rolled.unfollowedToday,
    dailyTarget: settings.pace.dailyTarget,
    unfollowedInWindow: countInWindow(rolled.unfollowTimestamps),
    maxPer30Min: settings.pace.maxPer30Min,
    processed: rolled.processed,
    protectedCount: rolled.protectedCount,
    skipped: rolled.skipped,
    currentHandle: rolled.currentHandle,
    nextAt: rolled.nextAt,
    seenCount: rolled.seen.length,
    emptyScrolls: rolled.emptyScrolls,
    recentLogs: rolled.logs.slice(0, 40),
  };
}

export function pushUnfollowLog(
  rt: UnfollowRuntime,
  entry: Omit<UnfollowLogEntry, "id" | "at"> & { at?: number },
): UnfollowRuntime {
  const log: UnfollowLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: entry.at ?? Date.now(),
    handle: entry.handle,
    action: entry.action,
    reason: entry.reason,
    message: entry.message,
  };
  return { ...rt, logs: [log, ...rt.logs].slice(0, MAX_LOGS) };
}

export function noteUnfollowSuccess(rt: UnfollowRuntime): UnfollowRuntime {
  const now = Date.now();
  const rolled = rollDay(rt);
  const stamps = [...rolled.unfollowTimestamps.filter((t) => Number.isFinite(t) && t <= now && now - t < WINDOW_MS), now];
  return {
    ...rolled,
    unfollowedToday: rolled.unfollowedToday + 1,
    unfollowTimestamps: stamps,
    processed: rolled.processed + 1,
  };
}

export function canUnfollowNow(
  rt: UnfollowRuntime,
  settings: UnfollowSettings,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string; waitMs?: number } {
  const rolled = rollDay(rt);
  if (rolled.unfollowedToday >= settings.pace.dailyTarget) {
    return { ok: false, reason: "daily_limit" };
  }
  const inWin = countInWindow(rolled.unfollowTimestamps, now);
  if (inWin >= settings.pace.maxPer30Min) {
    const active = rolled.unfollowTimestamps
      .filter((t) => Number.isFinite(t) && t <= now && now - t < WINDOW_MS)
      .sort((a, b) => a - b);
    // Khi giảm giới hạn giữa phiên, đợi đủ số lượt cũ hết hạn.
    const releaseAt = active[active.length - settings.pace.maxPer30Min];
    const waitMs = Math.max(1000, WINDOW_MS - (now - releaseAt) + 500);
    return { ok: false, reason: "rate_30m", waitMs };
  }
  return { ok: true };
}

export function randomUnfollowDelayMs(settings: UnfollowSettings): number {
  const min = settings.pace.delaySecMin * 1000;
  const max = settings.pace.delaySecMax * 1000;
  return min + Math.floor(Math.random() * (max - min + 1));
}
