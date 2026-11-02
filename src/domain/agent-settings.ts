/** Cấu hình Agent X Content Creator (Pogo = một module nguồn task). */

import type { AgentJob } from "./agent-queue.ts";
import type { PogoRetweetPower } from "./pogo-retweet.ts";
import type { AdaptiveRestState } from "./adaptive-rest.ts";
import {
  defaultBrowseSchedule,
  sanitizeBrowseSchedule,
  type BrowseSchedule,
  type FeedRotationState,
} from "./feed-rotation.ts";
import { clampNotificationCooldownMin, NOTIFICATION_BATCH_COOLDOWN_MIN_DEFAULT } from "./notification-batch.ts";

export type { BrowseSchedule, FeedRotationState };

export type AgentPriority = "pogo_then_browse" | "pogo_only" | "browse_only";
export type AgentRunStatus = "idle" | "running" | "paused" | "waiting" | "error";
export type AgentSpeedPreset = "safe" | "normal" | "fast";
export type ActivityLevel = "info" | "action" | "warn" | "error";

/** Giữ để tương thích storage cũ — không còn giới hạn số. */
export interface AgentQuota {
  reply: number;
  quote: number;
  retweet: number;
  follow: number;
  like: number;
}

/** Bật/tắt từng loại action — không dùng hạn mức số. */
export interface AgentActionToggles {
  like: boolean;
  retweet: boolean;
  follow: boolean;
  reply: boolean;
  quote: boolean;
}

/** Feed lướt X dùng chung queue / daily / rest với Home. */
export type BrowseSurface = "home" | "following" | "lists" | "mentions";

export interface AgentModules {
  pogoTasks: boolean;
  /** List link đã dán ở tab Nguồn — ưu tiên trước Pogo khi bật. */
  linkList: boolean;
  homeScroll: boolean;
  /** Follow từ list username (tab Follow) khi lướt Home/Following. */
  following: boolean;
  /** Tab Following trên Home (cạnh For you) — không phải /user/following. */
  followingFeed: boolean;
  /** Một list X đã cấu hình (`listUrlOrName`). */
  lists: boolean;
  /** Thông báo · All — Reply người/kênh tương tác (bật thông báo). */
  notifications: boolean;
}

export type BrowseWeights = Partial<Record<BrowseSurface, number>>;

export function defaultBrowseWeights(): Record<BrowseSurface, number> {
  return { home: 30, following: 25, lists: 20, mentions: 25 };
}

export interface AgentHumanize {
  /** % Like trên bài hợp lệ; làm ngay trên feed nếu chỉ Like. */
  likePct: number;
  /** % Reply trên bài hợp lệ; được chọn thì mở bài (cần API key). */
  replyPct: number;
  /** % Follow tác giả trên bài hợp lệ. */
  followPct: number;
  /** Separate chance for a username-list Follow while browsing. Missing legacy values use followPct. */
  listFollowPct?: number;
  /** % RT khi đã mở bài (Home). */
  retweetPct: number;
  readMsMin: number;
  readMsMax: number;
}

export interface AgentSettings {
  ownHandle: string;
  activeHoursStart: string;
  activeHoursEnd: string;
  delaySecMin: number;
  delaySecMax: number;
  /** @deprecated Không enforce — chỉ giữ storage cũ. */
  dailyQuota: AgentQuota;
  dailyTargets?: DailyTargets;
  /** Bật/tắt Like · RT · Follow · Reply · Quote. */
  actions: AgentActionToggles;
  /** Allow Home reposts as well as Pogo reposts; requires the Retweet action. */
  homeRetweet?: boolean;
  randomAuthorFollow?: boolean;
  /** Follow authors only when their known Sorsa score is strictly above this threshold. */
  randomAuthorFollowSorsaMin?: number;
  modules: AgentModules;
  /** URL hoặc path một list X (khi modules.lists). */
  listUrlOrName?: string;
  /**
   * @deprecated Random weights — giữ để migrate storage cũ, không còn dùng để chọn nguồn.
   */
  browseWeights?: BrowseWeights;
  /** Lịch xoay nguồn For You / Following / Lists theo thời gian. */
  browseSchedule?: BrowseSchedule;
  priority: AgentPriority;
  humanize: AgentHumanize;
  speedPreset: AgentSpeedPreset;
  maxLoops: number;
  sessionLimit: number;
  /** Keep running across session loop limits; daily action limits still apply. */
  continuousRun?: boolean;
  adaptiveRest?: boolean;
  skipOwnPosts: boolean;
  /** Master: có thực thi trên X không. */
  executeActions: boolean;
  /**
   * Khoảng cách giữa các đợt kiểm tra Thông báo (phút).
   * Mặc định 60 — Pogo/feed là chính; đặt 15 nếu muốn trả lời mention nhanh hơn.
   */
  notificationCooldownMin?: number;
}

export interface AgentDailyStats {
  pogoRetweets?: PogoRetweetPower;
  date: string; // YYYY-MM-DD local
  account?: string;
  reply: number;
  quote: number;
  retweet: number;
  follow: number;
  like: number;
  scrollSessions: number;
}

export interface ActivityEntry {
  id: string;
  at: number;
  level: ActivityLevel;
  message: string;
}

export interface AgentRuntime {
  lastBrowseSurface?: BrowseSurface;
  notificationReturn?: BrowseSurface;
  browseCooldowns?: Partial<Record<BrowseSurface, number>>;
  /**
   * @deprecated Đếm 3–6 lượt random — migrate sang browseRotation.
   */
  browseSession?: { surface: BrowseSurface; remaining: number; total: number; lastUnit?: string };
  /** Phiên xoay nguồn theo thời gian (For You → Following → Lists). */
  browseRotation?: FeedRotationState;
  browseVisit?: { surface: BrowseSurface; rolls: { engage: boolean; like: boolean; reply: boolean; retweet: boolean; follow: boolean; listFollow?: boolean; feedLike?: boolean } };
  notificationBatch?: import("./notification-batch.ts").NotificationBatch;
  adaptiveRest?: AdaptiveRestState;
  status: AgentRunStatus;
  killSwitch: boolean;
  detail: string;
  nextActionAt: number | null;
  loopCount: number;
  startedAt: number | null;
  lastError: string | null;
  /** true = chưa có tab X / chưa LIVE. */
  mockMode: boolean;
  /** Số lỗi X liên tiếp — dùng backoff / tạm dừng mềm. */
  consecutiveErrors: number;
}

export interface XConnectionPublic {
  notificationCount?: number | null;
  accountBlock?: string | null;
  connected: boolean;
  tabCount: number;
  url: string | null;
  loggedIn: boolean | null;
  handle: string | null;
  composerPresent: boolean | null;
  onHome: boolean | null;
  lastSeenAt: number | null;
}

export interface AgentPublicState {
  pogoSettlement?: { nextScanAt: number | null; nextCheckAt: number | null; pendingCount: number };
  settings: AgentSettings;
  runtime: AgentRuntime;
  today: AgentDailyStats;
  activity: ActivityEntry[];
  x: XConnectionPublic;
  /** 20 job gần nhất cho UI. */
  recentJobs: AgentJob[];
}

export function todayKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map((kind) => parts.find((p) => p.type === kind)!.value).join("-");
}

export type DailyTargetRange = { min: number; max: number };
export type DailyTargets = { enabled: boolean; afterReached: "browse" | "pause"; ranges: Record<keyof AgentQuota, DailyTargetRange> };
export function defaultDailyTargets(): DailyTargets {
  return { enabled: true, afterReached: "browse", ranges: { reply: { min: 500, max: 500 }, follow: { min: 200, max: 200 },
    like: { min: 0, max: 0 }, retweet: { min: 0, max: 0 }, quote: { min: 0, max: 0 } } };
}

function sanitizeDailyTargets(raw: unknown): DailyTargets {
  const d = defaultDailyTargets();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const ranges = o.ranges && typeof o.ranges === "object" ? o.ranges as Record<string, unknown> : {};
  for (const kind of Object.keys(d.ranges) as (keyof AgentQuota)[]) {
    const r = ranges[kind]; if (!r || typeof r !== "object") continue;
    const v = r as Record<string, unknown>;
    const max = clampInt(v.max, 0, 9999, d.ranges[kind].max);
    // Keep the legacy storage shape; old ranges migrate to their upper value.
    d.ranges[kind] = { min: max, max };
  }
  return { ...d, enabled: o.enabled !== false, afterReached: o.afterReached === "pause" ? "pause" : "browse" };
}

export function createDefaultAgentSettings(): AgentSettings {
  return {
    ownHandle: "",
    activeHoursStart: "09:00",
    activeHoursEnd: "23:00",
    delaySecMin: 25,
    delaySecMax: 120,
    dailyQuota: { reply: 999, quote: 999, retweet: 999, follow: 999, like: 999 },
    dailyTargets: defaultDailyTargets(),
    actions: { like: true, retweet: true, follow: true, reply: true, quote: false },
    homeRetweet: false,
    randomAuthorFollowSorsaMin: 500,
    modules: {
      pogoTasks: true,
      linkList: false,
      homeScroll: true,
      following: false,
      followingFeed: false,
      lists: false,
      notifications: false,
    },
    listUrlOrName: "",
    browseWeights: defaultBrowseWeights(),
    browseSchedule: defaultBrowseSchedule(),
    priority: "pogo_then_browse",
    humanize: {
      likePct: 40,
      replyPct: 35,
      followPct: 20,
      retweetPct: 12,
      readMsMin: 8000,
      readMsMax: 18000,
    },
    speedPreset: "safe",
    maxLoops: 200,
    sessionLimit: 300,
    continuousRun: true,
    adaptiveRest: true,
    skipOwnPosts: true,
    executeActions: true,
    notificationCooldownMin: NOTIFICATION_BATCH_COOLDOWN_MIN_DEFAULT,
  };
}

export function createEmptyDailyStats(date = todayKey()): AgentDailyStats {
  return {
    date,
    reply: 0,
    quote: 0,
    retweet: 0,
    follow: 0,
    like: 0,
    scrollSessions: 0,
  };
}

export function createInitialRuntime(): AgentRuntime {
  return {
    status: "idle",
    killSwitch: false,
    detail: "Sẵn sàng — cấu hình AI + Tasks rồi bấm Start.",
    nextActionAt: null,
    loopCount: 0,
    startedAt: null,
    lastError: null,
    mockMode: true,
    consecutiveErrors: 0,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.round(Math.min(max, Math.max(min, v)));
}

function clampPct(v: unknown, fallback: number): number {
  return clampInt(v, 0, 100, fallback);
}

/** Chuẩn hoá URL/path một list X; rỗng nếu không hợp lệ. */
export function sanitizeListUrlOrName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().slice(0, 300);
  if (!trimmed) return "";
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://x.com/${trimmed.replace(/^\//, "")}`;
    const url = new URL(withProto);
    const host = url.hostname.toLowerCase();
    if (host !== "x.com" && host !== "www.x.com" && host !== "twitter.com" && host !== "www.twitter.com") {
      return "";
    }
    const parts = url.pathname.split("/").filter(Boolean);
    // /i/lists/<id>
    if (parts.length >= 3 && parts[0].toLowerCase() === "i" && parts[1].toLowerCase() === "lists" && /^\d{4,20}$/.test(parts[2])) {
      return `https://x.com/i/lists/${parts[2]}`;
    }
    // /<user>/lists/<slug>
    if (
      parts.length >= 3 &&
      parts[1].toLowerCase() === "lists" &&
      /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) &&
      /^[A-Za-z0-9_-]{1,64}$/.test(parts[2])
    ) {
      return `https://x.com/${parts[0]}/lists/${parts[2]}`;
    }
  } catch {
    return "";
  }
  return "";
}

function sanitizeBrowseWeights(raw: unknown): BrowseWeights {
  const d = defaultBrowseWeights();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const out: BrowseWeights = {};
  for (const key of Object.keys(d) as BrowseSurface[]) {
    if (o[key] !== undefined) out[key] = clampInt(o[key], 0, 100, d[key]);
  }
  return { ...d, ...out };
}

function sanitizeTime(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  return /^\d{2}:\d{2}$/.test(v) ? v : fallback;
}

function sanitizeHandle(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(t)) return "";
  return t;
}

export function sanitizeAgentSettings(raw: unknown): AgentSettings {
  const d = createDefaultAgentSettings();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const quota = o.dailyQuota && typeof o.dailyQuota === "object" ? (o.dailyQuota as Record<string, unknown>) : {};
  const actionsRaw = o.actions && typeof o.actions === "object" ? (o.actions as Record<string, unknown>) : null;
  const modules = o.modules && typeof o.modules === "object" ? (o.modules as Record<string, unknown>) : {};
  const humanize = o.humanize && typeof o.humanize === "object" ? (o.humanize as Record<string, unknown>) : {};

  const priority: AgentPriority =
    o.priority === "pogo_only" || o.priority === "browse_only" || o.priority === "pogo_then_browse"
      ? o.priority
      : d.priority;
  const speedPreset: AgentSpeedPreset =
    o.speedPreset === "normal" || o.speedPreset === "fast" || o.speedPreset === "safe"
      ? o.speedPreset
      : d.speedPreset;

  let delayMin = clampInt(o.delaySecMin, 1, 600, d.delaySecMin);
  let delayMax = clampInt(o.delaySecMax, 1, 900, d.delaySecMax);
  if (delayMax < delayMin) delayMax = delayMin;

  let readMin = clampInt(humanize.readMsMin, 500, 60_000, d.humanize.readMsMin);
  let readMax = clampInt(humanize.readMsMax, 500, 120_000, d.humanize.readMsMax);
  if (readMax < readMin) readMax = readMin;

  return {
    ownHandle: sanitizeHandle(o.ownHandle),
    homeRetweet: o.homeRetweet === true,
    activeHoursStart: sanitizeTime(o.activeHoursStart, d.activeHoursStart),
    activeHoursEnd: sanitizeTime(o.activeHoursEnd, d.activeHoursEnd),
    delaySecMin: delayMin,
    delaySecMax: delayMax,
    dailyTargets: sanitizeDailyTargets(o.dailyTargets),
    dailyQuota: {
      reply: clampInt(quota.reply, 0, 9999, d.dailyQuota.reply),
      quote: clampInt(quota.quote, 0, 9999, d.dailyQuota.quote),
      retweet: clampInt(quota.retweet, 0, 9999, d.dailyQuota.retweet),
      follow: clampInt(quota.follow, 0, 9999, d.dailyQuota.follow),
      like: clampInt(quota.like, 0, 9999, d.dailyQuota.like),
    },
    actions: actionsRaw
      ? {
          like: actionsRaw.like !== false,
          retweet: actionsRaw.retweet !== false,
          follow: actionsRaw.follow !== false,
          reply: actionsRaw.reply !== false,
          quote: actionsRaw.quote === true,
        }
      : {
          // Migrate từ quota cũ: 0 = tắt.
          like: clampInt(quota.like, 0, 9999, 1) > 0,
          retweet: clampInt(quota.retweet, 0, 9999, 1) > 0,
          follow: clampInt(quota.follow, 0, 9999, 1) > 0,
          reply: clampInt(quota.reply, 0, 9999, 1) > 0,
          quote: clampInt(quota.quote, 0, 9999, 0) > 0,
        },
    modules: {
      pogoTasks: modules.pogoTasks !== false,
      linkList: modules.linkList === true,
      homeScroll: modules.homeScroll !== false,
      following: modules.following === true,
      followingFeed: modules.followingFeed === true,
      lists: modules.lists === true,
      notifications: modules.notifications === true,
    },
    listUrlOrName: sanitizeListUrlOrName(o.listUrlOrName),
    browseWeights: sanitizeBrowseWeights(o.browseWeights),
    browseSchedule: sanitizeBrowseSchedule(o.browseSchedule),
    randomAuthorFollow: o.randomAuthorFollow === true,
    randomAuthorFollowSorsaMin: clampInt(o.randomAuthorFollowSorsaMin, 0, Number.MAX_SAFE_INTEGER, 500),
    priority,
    humanize: {
      likePct: clampPct(humanize.likePct, d.humanize.likePct),
      replyPct: clampPct(humanize.replyPct, d.humanize.replyPct),
      followPct: clampPct(humanize.followPct, d.humanize.followPct),
      listFollowPct: clampPct(humanize.listFollowPct, clampPct(humanize.followPct, d.humanize.followPct)),
      retweetPct: clampPct(humanize.retweetPct, d.humanize.retweetPct),
      readMsMin: readMin,
      readMsMax: readMax,
    },
    speedPreset,
    maxLoops: clampInt(o.maxLoops, 1, 500, d.maxLoops),
    continuousRun: o.continuousRun !== false,
    adaptiveRest: o.adaptiveRest !== false,
    // Session phải ≥ Max loops — nếu không agent dừng sớm vì session (vd. loop 80/200, session 80).
    sessionLimit: Math.max(
      clampInt(o.sessionLimit, 1, 1000, d.sessionLimit),
      clampInt(o.maxLoops, 1, 500, d.maxLoops),
    ),
    skipOwnPosts: o.skipOwnPosts !== false,
    executeActions: o.executeActions !== false,
    notificationCooldownMin: clampNotificationCooldownMin(o.notificationCooldownMin, d.notificationCooldownMin ?? NOTIFICATION_BATCH_COOLDOWN_MIN_DEFAULT),
  };
}

export function applySpeedPreset(settings: AgentSettings, preset: AgentSpeedPreset): AgentSettings {
  if (preset === "fast") {
    return {
      ...settings,
      speedPreset: preset,
      delaySecMin: 12,
      delaySecMax: 45,
      humanize: {
        ...settings.humanize,
        readMsMin: 800,
        readMsMax: 2500,
        likePct: 20,
        replyPct: 15,
        followPct: 10,
        retweetPct: 6,
      },
    };
  }
  if (preset === "normal") {
    return {
      ...settings,
      speedPreset: preset,
      delaySecMin: 20,
      delaySecMax: 80,
      humanize: {
        ...settings.humanize,
        readMsMin: 1500,
        readMsMax: 5000,
        likePct: 30,
        replyPct: 25,
        followPct: 15,
        retweetPct: 10,
      },
    };
  }
  return {
    ...settings,
    speedPreset: "safe",
    delaySecMin: 25,
    delaySecMax: 120,
    humanize: {
      ...settings.humanize,
      readMsMin: 2000,
      readMsMax: 8000,
      likePct: 40,
      replyPct: 35,
      followPct: 20,
      retweetPct: 12,
    },
  };
}

export function priorityLabel(p: AgentPriority): string {
  if (p === "pogo_only") return "Chỉ task Pogo";
  if (p === "browse_only") return "Chỉ lướt X";
  return "Pogo trước, rồi lướt X";
}

export function statusLabel(s: AgentRunStatus): string {
  switch (s) {
    case "running":
      return "Đang chạy";
    case "paused":
      return "Tạm dừng";
    case "waiting":
      return "Đang chờ delay";
    case "error":
      return "Lỗi";
    default:
      return "Chưa chạy";
  }
}
