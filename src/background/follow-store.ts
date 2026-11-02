import { getXConnection } from "./x-bridge.ts";
import { loadFollowUsage } from "./follow-budget.ts";
import { loadFollowHistory } from "./follow-history.ts";
import { parseHandleList } from "../domain/follow-settings.ts";
import { normalizeFollowHandle } from "../domain/follow-settings.ts";
import { sanitizeTimelineTweets, type TimelineTweet } from "../x/timeline.ts";
/**
 * Persist Follow tab settings + runtime (daily / 30m counters, logs).
 */

import {
  createDefaultFollowSettings,
  sanitizeFollowSettings,
  type FollowLogEntry,
  type FollowRuntimePublic,
  type FollowSettings,
  type FollowSourceMode,
} from "../domain/follow-settings.ts";

const SETTINGS_KEY = "xContentCreator.follow.v1";
const RUNTIME_KEY = "xContentCreator.followRuntime.v1";
const MAX_LOGS = 80;
const WINDOW_MS = 30 * 60 * 1000;

export interface FollowRuntime {
  account: string;
  running: boolean;
  sourceMode: FollowSourceMode;
  detail: string;
  startedAt: number | null;
  /** local YYYY-MM-DD */
  day: string;
  followedToday: number;
  /** timestamps of successful follows (for 30m window) */
  followTimestamps: number[];
  processed: number;
  skipped: number;
  currentHandle: string | null;
  nextAt: number | null;
  /** handles already tried this session */
  seen: string[];
  /** list queue remaining */
  queue: string[];
  emptyScrolls: number;
  logs: FollowLogEntry[];
  postFollow?: { handle: string; account: string; expiresAt: number; attempts: number; tweet?: TimelineTweet };
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function createInitialFollowRuntime(): FollowRuntime {
  return {
    account: "",
    running: false,
    sourceMode: "list",
    detail: "Sẵn sàng",
    startedAt: null,
    day: todayKey(),
    followedToday: 0,
    followTimestamps: [],
    processed: 0,
    skipped: 0,
    currentHandle: null,
    nextAt: null,
    seen: [],
    queue: [],
    emptyScrolls: 0,
    logs: [],
  };
}

function rollDay(rt: FollowRuntime): FollowRuntime {
  const day = todayKey();
  if (rt.day === day) return rt;
  return { ...rt, day, followedToday: 0 };
}

export async function loadFollowSettings(): Promise<FollowSettings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeFollowSettings(raw[SETTINGS_KEY]);
}

export async function saveFollowSettings(settings: FollowSettings): Promise<FollowSettings> {
  const clean = sanitizeFollowSettings(settings);
  const followed = await loadFollowHistory(getXConnection().handle || "");
  const handles = parseHandleList(clean.usernameList);
  if (handles.some(handle => followed.has(handle)))
    clean.usernameList = handles.filter(handle => !followed.has(handle)).map(handle => `@${handle}`).join("\n");
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  return clean;
}

export async function loadFollowRuntime(): Promise<FollowRuntime> {
  const raw = await chrome.storage.local.get(RUNTIME_KEY);
  const blob = raw[RUNTIME_KEY];
  if (!blob || typeof blob !== "object") return syncFollowUsage(createInitialFollowRuntime());
  const o = blob as Partial<FollowRuntime>;
  const base = createInitialFollowRuntime();
  return syncFollowUsage(rollDay({
    ...base,
    ...o,
    followTimestamps: Array.isArray(o.followTimestamps)
      ? o.followTimestamps.filter((t) => typeof t === "number")
      : [],
    seen: Array.isArray(o.seen) ? o.seen.map(String) : [],
    queue: Array.isArray(o.queue) ? o.queue.map(String) : [],
    logs: Array.isArray(o.logs) ? (o.logs as FollowLogEntry[]) : [],
    running: o.running === true,
    postFollow: o.postFollow && normalizeFollowHandle(o.postFollow.handle) && normalizeFollowHandle(o.postFollow.account) && Number.isFinite(o.postFollow.expiresAt)
      ? { handle: normalizeFollowHandle(o.postFollow.handle)!, account: normalizeFollowHandle(o.postFollow.account)!, expiresAt: o.postFollow.expiresAt,
          attempts: Math.max(0, Math.min(3, Number(o.postFollow.attempts) || 0)), tweet: sanitizeTimelineTweets(o.postFollow.tweet ? [o.postFollow.tweet] : [])[0] } : undefined,
  }));
}

async function syncFollowUsage(rt: FollowRuntime): Promise<FollowRuntime> {
  const usage = await loadFollowUsage(getXConnection().handle || "unknown");
  return { ...rt, day: usage.day, followedToday: usage.count, followTimestamps: usage.timestamps };
}

export async function saveFollowRuntime(rt: FollowRuntime, cancelled: () => boolean = () => false): Promise<void> {
  const synced = await syncFollowUsage(rollDay(rt));
  if (!cancelled()) await chrome.storage.local.set({ [RUNTIME_KEY]: synced });
}

export function countInWindow(timestamps: number[], now = Date.now()): number {
  const cut = now - WINDOW_MS;
  return timestamps.filter((t) => Number.isFinite(t) && t > cut && t <= now).length;
}

export function toFollowPublic(
  rt: FollowRuntime,
  settings: FollowSettings,
): FollowRuntimePublic {
  const rolled = rollDay(rt);
  return {
    running: rolled.running,
    sourceMode: rolled.sourceMode,
    detail: rolled.detail,
    startedAt: rolled.startedAt,
    followedToday: rolled.followedToday,
    dailyTarget: settings.pace.dailyTarget,
    followedInWindow: countInWindow(rolled.followTimestamps),
    maxPer30Min: settings.pace.maxPer30Min,
    processed: rolled.processed,
    skipped: rolled.skipped,
    currentHandle: rolled.currentHandle,
    nextAt: rolled.nextAt,
    recentLogs: rolled.logs.slice(0, 40),
  };
}

export function pushFollowLog(
  rt: FollowRuntime,
  entry: Omit<FollowLogEntry, "id" | "at"> & { at?: number },
): FollowRuntime {
  const log: FollowLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: entry.at ?? Date.now(),
    handle: entry.handle,
    action: entry.action,
    reason: entry.reason,
    message: entry.message,
  };
  return { ...rt, logs: [log, ...rt.logs].slice(0, MAX_LOGS) };
}

export function noteFollowSuccess(rt: FollowRuntime): FollowRuntime {
  const now = Date.now();
  const rolled = rollDay(rt);
  const stamps = [...rolled.followTimestamps.filter((t) => now - t < WINDOW_MS), now];
  return {
    ...rolled,
    followedToday: rolled.followedToday + 1,
    followTimestamps: stamps,
    processed: rolled.processed + 1,
  };
}

export function canFollowNow(
  rt: FollowRuntime,
  settings: FollowSettings,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string; waitMs?: number } {
  const rolled = rollDay(rt);
  if (rolled.followedToday >= settings.pace.dailyTarget) {
    return { ok: false, reason: "daily_limit" };
  }
  const inWin = countInWindow(rolled.followTimestamps, now);
  if (inWin >= settings.pace.maxPer30Min) {
    const active = rolled.followTimestamps
      .filter((t) => Number.isFinite(t) && t <= now && now - t < WINDOW_MS).sort((a, b) => a - b);
    const releaseAt = active[active.length - settings.pace.maxPer30Min];
    const waitMs = Math.max(1000, WINDOW_MS - (now - releaseAt) + 500);
    return { ok: false, reason: "rate_30m", waitMs };
  }
  return { ok: true };
}

export function randomDelayMs(settings: FollowSettings): number {
  const min = settings.pace.delaySecMin * 1000;
  const max = settings.pace.delaySecMax * 1000;
  return min + Math.floor(Math.random() * (max - min + 1));
}
