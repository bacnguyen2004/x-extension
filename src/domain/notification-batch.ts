import { sanitizeTimelineTweets, type TimelineTweet } from "../x/timeline.ts";

export interface NotificationBatch {
  account: string;
  active: boolean;
  armed: boolean;
  expiresAt: number;
  nextEligibleAt: number;
  needsExit: boolean;
  seenIds: string[];
  unreadSince: number;
  scanTab?: "mentions" | "all";
  scanPass?: number;
  candidates?: TimelineTweet[];
}
export const NOTIFICATION_BATCH_LIMIT = 3;
/** Mặc định Hành vi: kiểm tra Thông báo mỗi 60 phút (Pogo/feed là chính). */
export const NOTIFICATION_BATCH_COOLDOWN_MIN_DEFAULT = 60;
export const NOTIFICATION_BATCH_COOLDOWN_MIN_MIN = 5;
export const NOTIFICATION_BATCH_COOLDOWN_MIN_MAX = 180;
export const NOTIFICATION_BATCH_COOLDOWN_MS = NOTIFICATION_BATCH_COOLDOWN_MIN_DEFAULT * 60000;
export const NOTIFICATION_BATCH_ACCUMULATE_MS = 5 * 60000;

export function clampNotificationCooldownMin(raw: unknown, fallback = NOTIFICATION_BATCH_COOLDOWN_MIN_DEFAULT): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.round(Math.min(NOTIFICATION_BATCH_COOLDOWN_MIN_MAX, Math.max(NOTIFICATION_BATCH_COOLDOWN_MIN_MIN, raw)));
}

export function notificationCooldownMs(minutes?: number): number {
  return clampNotificationCooldownMin(minutes) * 60000;
}

export function observeNotificationBatch(
  raw: NotificationBatch | undefined,
  account: string,
  badge: number | null | undefined,
  at = Date.now(),
  cooldownMs = NOTIFICATION_BATCH_COOLDOWN_MS,
): NotificationBatch {
  const own = account.replace(/^@/, '').toLowerCase();
  const wait = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : NOTIFICATION_BATCH_COOLDOWN_MS;
  const state: NotificationBatch = raw?.account === own ? { ...raw, unreadSince: Number.isFinite(raw.unreadSince) ? raw.unreadSince : 0, seenIds: Array.isArray(raw.seenIds) ? raw.seenIds.filter(id => /^\d+$/.test(id)).slice(-1000) : [] }
    : { account: own, active: false, armed: true, expiresAt: 0, nextEligibleAt: at + wait, needsExit: false, seenIds: [], unreadSince: 0 };
  state.candidates = sanitizeTimelineTweets(state.candidates).slice(0, 100);
  state.scanTab = state.scanTab === "all" ? "all" : "mentions";
  state.scanPass = Math.max(0, Math.min(2, Math.floor(Number(state.scanPass) || 0)));
  if (badge === 0) { state.armed = true; state.unreadSince = 0; }
  else if (typeof badge === 'number' && badge > 0 && !state.unreadSince) state.unreadSince = at;
  if (state.active && state.expiresAt <= at) { state.active = false; state.needsExit = true; state.nextEligibleAt = at + wait; }
  return state;
}
export function notificationBatchCanOpen(state: NotificationBatch, badge: number | null | undefined, at = Date.now()): boolean {
  return /^[a-z0-9_]{1,15}$/.test(state.account) && (state.active || (state.nextEligibleAt <= at && !state.needsExit));
}
export function startNotificationBatch(state: NotificationBatch, at = Date.now()): NotificationBatch {
  return state.active ? state : { ...state, active: true, armed: false, expiresAt: at + 300000, scanTab: "mentions", scanPass: 0, candidates: [] };
}
export function finishNotificationBatch(
  state: NotificationBatch,
  scannedIds: string[],
  at = Date.now(),
  cooldownMs = NOTIFICATION_BATCH_COOLDOWN_MS,
): NotificationBatch {
  const wait = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : NOTIFICATION_BATCH_COOLDOWN_MS;
  return { ...state, active: false, needsExit: true, nextEligibleAt: at + wait,
    candidates: [], scanTab: "mentions", scanPass: 0,
    seenIds: [...new Set([...state.seenIds, ...scannedIds])].slice(-1000) };
}
