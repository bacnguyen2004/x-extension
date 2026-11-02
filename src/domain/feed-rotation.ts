/**
 * Feed Rotation Scheduler — xoay nguồn For You / Following / Lists theo thời gian.
 * Không random. Đồng hồ chỉ đếm active scan time.
 */

import type { AgentSettings, BrowseSurface } from "./agent-settings.ts";

export const FEED_ROTATION_ORDER: ReadonlyArray<Exclude<BrowseSurface, "mentions">> = [
  "home",
  "following",
  "lists",
];

export const EMPTY_SCROLL_THRESHOLD = 3;
export const DEFAULT_HOME_SEC = 600;
export const DEFAULT_FOLLOWING_SEC = 600;
export const DEFAULT_LISTS_SEC = 300;

export type FeedRotationPhase =
  | "idle"
  | "navigating"
  | "scanning"
  | "switch_pending"
  | "paused"
  | "error"
  | "waiting_round";

export interface BrowseSchedule {
  /** Thời gian quét For You (giây). */
  homeSec: number;
  /** Thời gian quét Following (giây). */
  followingSec: number;
  /** Thời gian quét Lists (giây). */
  listsSec: number;
  /** Chuyển sớm khi 3 lượt cuộn không có bài mới. */
  earlySwitchOnEmpty: boolean;
  /** Giữ nguồn + thời gian còn lại khi Pause/Resume. */
  keepSourceOnResume: boolean;
}

export interface FeedRotationState {
  /** Nguồn đã xác nhận feed tải thành công. */
  currentSource: Exclude<BrowseSurface, "mentions"> | null;
  /** Nguồn đang điều hướng tới (chưa confirm). */
  targetSource: Exclude<BrowseSurface, "mentions"> | null;
  remainingScanTimeMs: number;
  pendingSwitch: boolean;
  emptyScrolls: number;
  rotationIndex: number;
  exhaustedThisRound: Array<Exclude<BrowseSurface, "mentions">>;
  phase: FeedRotationPhase;
  clockRunning: boolean;
  clockStartedAt: number | null;
  lastUnit?: string;
  /** Số lần nav thất bại liên tiếp (tối đa 1 retry). */
  navAttempts: number;
  error?: string | null;
  /** Người dùng đã chuyển feed thủ công — tạm dừng ép nav. */
  userOverride?: boolean;
  /** Lượt scan gần nhất có bài eligible. */
  sawEligible?: boolean;
}

export function defaultBrowseSchedule(): BrowseSchedule {
  return {
    homeSec: DEFAULT_HOME_SEC,
    followingSec: DEFAULT_FOLLOWING_SEC,
    listsSec: DEFAULT_LISTS_SEC,
    earlySwitchOnEmpty: true,
    keepSourceOnResume: true,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.round(Math.min(max, Math.max(min, v)));
}

/** Storage dùng giây (60–7200). UI nhập phút rồi nhân 60 khi lưu. */
export function sanitizeBrowseSchedule(raw: unknown): BrowseSchedule {
  const d = defaultBrowseSchedule();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  return {
    homeSec: clampInt(o.homeSec, 60, 7200, d.homeSec),
    followingSec: clampInt(o.followingSec, 60, 7200, d.followingSec),
    listsSec: clampInt(o.listsSec, 60, 7200, d.listsSec),
    earlySwitchOnEmpty: o.earlySwitchOnEmpty !== false,
    keepSourceOnResume: o.keepSourceOnResume !== false,
  };
}

export function browseScheduleOf(settings: AgentSettings): BrowseSchedule {
  return sanitizeBrowseSchedule(settings.browseSchedule);
}

/** Nguồn lướt X tham gia xoay (không gồm Notifications). */
export function enabledFeedRotationSurfaces(
  settings: AgentSettings,
): Array<Exclude<BrowseSurface, "mentions">> {
  const out: Array<Exclude<BrowseSurface, "mentions">> = [];
  if (settings.modules.homeScroll) out.push("home");
  if (settings.modules.followingFeed) out.push("following");
  // listUrlOrName đã được sanitize ở agent-settings trước khi vào đây.
  if (settings.modules.lists && (settings.listUrlOrName ?? "").trim()) out.push("lists");
  return out;
}

export function anyFeedRotationOn(settings: AgentSettings): boolean {
  return enabledFeedRotationSurfaces(settings).length > 0;
}

export function scanDurationMs(
  surface: Exclude<BrowseSurface, "mentions">,
  schedule: BrowseSchedule,
): number {
  if (surface === "following") return Math.max(60_000, schedule.followingSec * 1000);
  if (surface === "lists") return Math.max(60_000, schedule.listsSec * 1000);
  return Math.max(60_000, schedule.homeSec * 1000);
}

export function createFeedRotationState(): FeedRotationState {
  return {
    currentSource: null,
    targetSource: null,
    remainingScanTimeMs: 0,
    pendingSwitch: false,
    emptyScrolls: 0,
    rotationIndex: 0,
    exhaustedThisRound: [],
    phase: "idle",
    clockRunning: false,
    clockStartedAt: null,
    navAttempts: 0,
    error: null,
  };
}

const PHASES = new Set<FeedRotationPhase>([
  "idle",
  "navigating",
  "scanning",
  "switch_pending",
  "paused",
  "error",
  "waiting_round",
]);

function isFeedSurface(v: unknown): v is Exclude<BrowseSurface, "mentions"> {
  return v === "home" || v === "following" || v === "lists";
}

export function sanitizeFeedRotationState(raw: unknown): FeedRotationState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const base = createFeedRotationState();
  const phase = typeof o.phase === "string" && PHASES.has(o.phase as FeedRotationPhase)
    ? (o.phase as FeedRotationPhase)
    : base.phase;
  const exhausted = Array.isArray(o.exhaustedThisRound)
    ? o.exhaustedThisRound.filter(isFeedSurface)
    : [];
  return {
    currentSource: isFeedSurface(o.currentSource) ? o.currentSource : null,
    targetSource: isFeedSurface(o.targetSource) ? o.targetSource : null,
    remainingScanTimeMs: clampInt(o.remainingScanTimeMs, 0, 7_200_000, 0),
    pendingSwitch: o.pendingSwitch === true,
    emptyScrolls: clampInt(o.emptyScrolls, 0, EMPTY_SCROLL_THRESHOLD, 0),
    rotationIndex: clampInt(o.rotationIndex, 0, 99, 0),
    exhaustedThisRound: exhausted,
    phase,
    clockRunning: o.clockRunning === true,
    clockStartedAt: typeof o.clockStartedAt === "number" && Number.isFinite(o.clockStartedAt)
      ? o.clockStartedAt
      : null,
    lastUnit: typeof o.lastUnit === "string" ? o.lastUnit : undefined,
    navAttempts: clampInt(o.navAttempts, 0, 5, 0),
    error: typeof o.error === "string" ? o.error : null,
    userOverride: o.userOverride === true,
    sawEligible: o.sawEligible === true,
  };
}

/**
 * Migrate `browseSession` cũ (đếm 3–6 lượt) → time-based session trên cùng nguồn.
 */
export function migrateLegacyBrowseSession(
  session: { surface?: BrowseSurface; remaining?: number; total?: number } | null | undefined,
  settings: AgentSettings,
  now: number,
): FeedRotationState | undefined {
  if (!session || !isFeedSurface(session.surface)) return undefined;
  const enabled = enabledFeedRotationSurfaces(settings);
  if (!enabled.includes(session.surface)) return undefined;
  const schedule = browseScheduleOf(settings);
  const index = Math.max(0, enabled.indexOf(session.surface));
  const state = createFeedRotationState();
  state.currentSource = session.surface;
  state.targetSource = session.surface;
  state.rotationIndex = index;
  state.remainingScanTimeMs = scanDurationMs(session.surface, schedule);
  state.phase = "scanning";
  state.clockRunning = false;
  state.clockStartedAt = null;
  state.lastUnit = typeof (session as { lastUnit?: string }).lastUnit === "string"
    ? (session as { lastUnit?: string }).lastUnit
    : undefined;
  // Không chạy clock ngay — Resume sẽ resumeScanClock.
  void now;
  return state;
}

export function activeFeedSource(
  state: FeedRotationState | null | undefined,
): Exclude<BrowseSurface, "mentions"> | null {
  if (!state) return null;
  return state.targetSource ?? state.currentSource;
}

/**
 * Chặn Notifications chỉ khi đã có phiên quét feed đang chạy.
 * `navigating` chưa confirm (chưa currentSource) vẫn cho phép đợt thông báo mở trước.
 */
export function feedRotationBlocksNotifications(
  state: FeedRotationState | null | undefined,
): boolean {
  if (!state) return false;
  if (state.phase === "scanning" || state.phase === "switch_pending") return true;
  if (state.phase === "paused" && !!state.currentSource) return true;
  return false;
}

/** Trừ thời gian active kể từ lần tick clock trước. */
export function tickScanClock(state: FeedRotationState, now: number): FeedRotationState {
  if (!state.clockRunning || state.clockStartedAt == null) return state;
  const elapsed = Math.max(0, now - state.clockStartedAt);
  const remaining = Math.max(0, state.remainingScanTimeMs - elapsed);
  const next: FeedRotationState = {
    ...state,
    remainingScanTimeMs: remaining,
    clockStartedAt: now,
  };
  if (remaining <= 0 && state.phase === "scanning") {
    next.pendingSwitch = true;
    next.phase = "switch_pending";
  }
  return next;
}

export function pauseScanClock(state: FeedRotationState, now: number): FeedRotationState {
  const ticked = tickScanClock(state, now);
  return {
    ...ticked,
    clockRunning: false,
    clockStartedAt: null,
    phase: ticked.phase === "scanning" || ticked.phase === "switch_pending"
      ? "paused"
      : ticked.phase,
  };
}

export function resumeScanClock(state: FeedRotationState, now: number): FeedRotationState {
  if (!state.currentSource && !state.targetSource) return state;
  if (state.phase === "error" || state.phase === "waiting_round" || state.phase === "idle") {
    return state;
  }
  if (state.phase === "navigating") {
    return { ...state, clockRunning: false, clockStartedAt: null };
  }
  const pending = state.pendingSwitch || state.remainingScanTimeMs <= 0;
  return {
    ...state,
    clockRunning: !pending,
    clockStartedAt: pending ? null : now,
    phase: pending ? "switch_pending" : "scanning",
    userOverride: false,
  };
}

/** Bắt đầu điều hướng tới nguồn (chưa chạy đồng hồ). */
export function beginNavigateToSource(
  state: FeedRotationState,
  surface: Exclude<BrowseSurface, "mentions">,
  index: number,
): FeedRotationState {
  return {
    ...state,
    targetSource: surface,
    rotationIndex: index,
    phase: "navigating",
    clockRunning: false,
    clockStartedAt: null,
    pendingSwitch: false,
    emptyScrolls: 0,
    navAttempts: 0,
    error: null,
    userOverride: false,
    sawEligible: false,
  };
}

/** Feed đã tải thành công — cập nhật currentSource và bắt đầu đồng hồ. */
export function confirmSourceReady(
  state: FeedRotationState,
  schedule: BrowseSchedule,
  now: number,
): FeedRotationState {
  const surface = state.targetSource ?? state.currentSource;
  if (!surface) return state;
  const keepRemaining = state.currentSource === surface
    && state.remainingScanTimeMs > 0
    && (state.phase === "scanning" || state.phase === "paused" || state.phase === "switch_pending" || state.phase === "navigating");
  const remaining = keepRemaining
    ? state.remainingScanTimeMs
    : scanDurationMs(surface, schedule);
  const pending = state.pendingSwitch || remaining <= 0;
  return {
    ...state,
    currentSource: surface,
    targetSource: surface,
    remainingScanTimeMs: remaining,
    pendingSwitch: pending,
    phase: pending ? "switch_pending" : "scanning",
    clockRunning: !pending,
    clockStartedAt: pending ? null : now,
    navAttempts: 0,
    error: null,
    userOverride: false,
  };
}

export function noteNavigationFailure(
  state: FeedRotationState,
  error: string,
): FeedRotationState {
  const attempts = state.navAttempts + 1;
  if (attempts <= 1) {
    return {
      ...state,
      navAttempts: attempts,
      phase: "navigating",
      clockRunning: false,
      clockStartedAt: null,
      error,
    };
  }
  return {
    ...state,
    navAttempts: attempts,
    phase: "error",
    clockRunning: false,
    clockStartedAt: null,
    error: error || "feed_navigation_failed",
  };
}

export function noteEligibleScan(state: FeedRotationState, eligibleCount: number): FeedRotationState {
  if (eligibleCount > 0) {
    return { ...state, emptyScrolls: 0, sawEligible: true };
  }
  return { ...state, sawEligible: false };
}

/**
 * Sau một lượt cuộn hoàn tất trên feed.
 * Không tăng emptyScrolls khi loading / network / selector lỗi.
 */
export function noteScrollUnit(
  state: FeedRotationState,
  opts: {
    foundNew: boolean;
    feedUnreliable?: boolean;
    earlySwitchOnEmpty: boolean;
    unitId: string;
  },
): FeedRotationState {
  if (opts.feedUnreliable) return { ...state, lastUnit: opts.unitId };
  if (state.lastUnit === opts.unitId) return state;
  let emptyScrolls = state.emptyScrolls;
  if (opts.foundNew) emptyScrolls = 0;
  else emptyScrolls = Math.min(EMPTY_SCROLL_THRESHOLD, emptyScrolls + 1);
  const early = opts.earlySwitchOnEmpty && emptyScrolls >= EMPTY_SCROLL_THRESHOLD;
  const timeUp = state.remainingScanTimeMs <= 0 || state.pendingSwitch;
  const pending = early || timeUp;
  return {
    ...state,
    lastUnit: opts.unitId,
    emptyScrolls,
    sawEligible: opts.foundNew ? true : state.sawEligible,
    pendingSwitch: pending || state.pendingSwitch,
    phase: pending ? "switch_pending" : state.phase === "paused" ? "paused" : "scanning",
  };
}

/** Sau khi xử lý xong một bài (like/reply/…) — không trừ thời gian, reset empty. */
export function notePostUnit(
  state: FeedRotationState,
  unitId: string,
): FeedRotationState {
  if (state.lastUnit === unitId) return state;
  return {
    ...state,
    lastUnit: unitId,
    emptyScrolls: 0,
    sawEligible: true,
  };
}

export function markPendingSwitch(state: FeedRotationState): FeedRotationState {
  return { ...state, pendingSwitch: true, phase: "switch_pending", clockRunning: false, clockStartedAt: null };
}

/**
 * Chọn nguồn tiếp theo theo thứ tự cố định, bỏ nguồn tắt / exhausted / cooldown.
 * Một nguồn duy nhất → trả về chính nó (không nav vô nghĩa nếu đã ở đó).
 */
export function nextFeedRotationSource(
  state: FeedRotationState,
  settings: AgentSettings,
  cooldowns?: Partial<Record<BrowseSurface, number>>,
  now = Date.now(),
): {
  surface: Exclude<BrowseSurface, "mentions"> | null;
  index: number;
  waitForNextRound: boolean;
  sameAsCurrent: boolean;
} {
  const enabled = enabledFeedRotationSurfaces(settings).filter(
    (s) => (cooldowns?.[s] ?? 0) <= now,
  );
  if (!enabled.length) {
    const anyCooling = enabledFeedRotationSurfaces(settings).some((s) => (cooldowns?.[s] ?? 0) > now);
    return { surface: null, index: state.rotationIndex, waitForNextRound: anyCooling || enabledFeedRotationSurfaces(settings).length > 0, sameAsCurrent: false };
  }
  if (enabled.length === 1) {
    const only = enabled[0]!;
    return {
      surface: only,
      index: 0,
      waitForNextRound: state.exhaustedThisRound.includes(only),
      sameAsCurrent: activeFeedSource(state) === only,
    };
  }

  const start = Math.max(0, state.rotationIndex);
  for (let step = 1; step <= enabled.length; step++) {
    const idx = (start + step) % enabled.length;
    const surface = enabled[idx]!;
    if (state.exhaustedThisRound.includes(surface)) continue;
    return {
      surface,
      index: idx,
      waitForNextRound: false,
      sameAsCurrent: activeFeedSource(state) === surface,
    };
  }
  return { surface: null, index: start, waitForNextRound: true, sameAsCurrent: false };
}

/** Nguồn đầu tiên khi bắt đầu / sau waiting_round. */
export function firstFeedRotationSource(
  settings: AgentSettings,
  preferred?: BrowseSurface | null,
  cooldowns?: Partial<Record<BrowseSurface, number>>,
  now = Date.now(),
): { surface: Exclude<BrowseSurface, "mentions">; index: number } | null {
  const enabled = enabledFeedRotationSurfaces(settings).filter(
    (s) => (cooldowns?.[s] ?? 0) <= now,
  );
  if (!enabled.length) return null;
  if (preferred && isFeedSurface(preferred) && enabled.includes(preferred)) {
    return { surface: preferred, index: enabled.indexOf(preferred) };
  }
  return { surface: enabled[0]!, index: 0 };
}

export function markSourceExhausted(
  state: FeedRotationState,
  surface: Exclude<BrowseSurface, "mentions">,
): FeedRotationState {
  if (state.exhaustedThisRound.includes(surface)) return state;
  return { ...state, exhaustedThisRound: [...state.exhaustedThisRound, surface] };
}

export function clearExhaustedRound(state: FeedRotationState): FeedRotationState {
  return { ...state, exhaustedThisRound: [], phase: state.phase === "waiting_round" ? "idle" : state.phase };
}

export function enterWaitingRound(state: FeedRotationState): FeedRotationState {
  return {
    ...state,
    phase: "waiting_round",
    pendingSwitch: false,
    clockRunning: false,
    clockStartedAt: null,
    currentSource: null,
    targetSource: null,
    remainingScanTimeMs: 0,
    emptyScrolls: 0,
  };
}

/**
 * Thực hiện chuyển nguồn: đánh dấu exhausted nếu early-empty, chọn next, begin navigate.
 * Không gọi khi đang xử lý bài (caller phải đợi).
 */
export function switchToNextSource(
  state: FeedRotationState,
  settings: AgentSettings,
  opts: {
    reason: "time_elapsed" | "empty_content" | "source_disabled" | "manual";
    cooldowns?: Partial<Record<BrowseSurface, number>>;
    now?: number;
  },
): FeedRotationState {
  const now = opts.now ?? Date.now();
  let next: FeedRotationState = { ...state, pendingSwitch: false, clockRunning: false, clockStartedAt: null };
  const leaving = activeFeedSource(state);
  if (leaving && (opts.reason === "empty_content" || opts.reason === "source_disabled")) {
    next = markSourceExhausted(next, leaving);
  }
  const pick = nextFeedRotationSource(next, settings, opts.cooldowns, now);
  if (pick.waitForNextRound || !pick.surface) {
    return enterWaitingRound(next);
  }
  if (pick.sameAsCurrent && enabledFeedRotationSurfaces(settings).length === 1) {
    // Một nguồn: reset đồng hồ, không nav lại.
    const schedule = browseScheduleOf(settings);
    return {
      ...next,
      currentSource: pick.surface,
      targetSource: pick.surface,
      rotationIndex: pick.index,
      remainingScanTimeMs: scanDurationMs(pick.surface, schedule),
      emptyScrolls: 0,
      exhaustedThisRound: [],
      phase: "scanning",
      clockRunning: true,
      clockStartedAt: now,
      navAttempts: 0,
      error: null,
      lastUnit: undefined,
      sawEligible: false,
    };
  }
  return beginNavigateToSource(next, pick.surface, pick.index);
}

/** Đồng bộ khi user đổi feed thủ công — không ép quay về nguồn cũ. */
export function syncUserOverride(
  state: FeedRotationState,
  surface: Exclude<BrowseSurface, "mentions">,
  schedule: BrowseSchedule,
  now: number,
): FeedRotationState {
  const enabledIndex = FEED_ROTATION_ORDER.indexOf(surface);
  return {
    ...state,
    currentSource: surface,
    targetSource: surface,
    rotationIndex: Math.max(0, enabledIndex),
    remainingScanTimeMs: scanDurationMs(surface, schedule),
    pendingSwitch: false,
    emptyScrolls: 0,
    phase: "scanning",
    clockRunning: false,
    clockStartedAt: null,
    navAttempts: 0,
    error: null,
    userOverride: true,
    sawEligible: false,
    lastUnit: undefined,
  };
}

/**
 * Đảm bảo runtime có rotation hợp lệ trước khi plan.
 * Không tự chuyển nguồn — chỉ khôi phục / khởi tạo.
 */
export function ensureFeedRotation(
  state: FeedRotationState | null | undefined,
  settings: AgentSettings,
  opts: {
    now: number;
    preferred?: BrowseSurface | null;
    keepSourceOnResume?: boolean;
  },
): FeedRotationState {
  const enabled = enabledFeedRotationSurfaces(settings);
  if (!enabled.length) {
    return { ...createFeedRotationState(), phase: "idle" };
  }
  const schedule = browseScheduleOf(settings);
  let rot = state ? { ...state } : createFeedRotationState();
  const keep = opts.keepSourceOnResume ?? schedule.keepSourceOnResume;

  // Nguồn hiện tại bị tắt → chuẩn bị chuyển.
  const active = activeFeedSource(rot);
  if (active && !enabled.includes(active)) {
    rot = markPendingSwitch(markSourceExhausted(rot, active));
    return rot;
  }

  if (rot.phase === "error") return rot;
  if (rot.phase === "waiting_round") return rot;

  if (!active) {
    const first = firstFeedRotationSource(settings, keep ? opts.preferred : null);
    if (!first) return createFeedRotationState();
    return beginNavigateToSource(rot, first.surface, first.index);
  }

  // Giữ nguồn đang quét; đảm bảo index khớp enabled hiện tại.
  const idx = enabled.indexOf(active);
  if (idx >= 0) rot.rotationIndex = idx;
  return rot;
}

export function feedSurfaceLabel(surface: Exclude<BrowseSurface, "mentions">): string {
  return ({ home: "For You", following: "Following", lists: "Lists" } as const)[surface];
}
