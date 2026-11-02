/**
 * Tab Unfollow — quét Following, bảo vệ whitelist/Sorsa/tick trước khi hủy follow.
 */

import {
  normalizeFollowHandle,
  parseHandleList,
  type VerifiedMode,
} from "./follow-settings.ts";

export type UnfollowSourceMode = "own_following" | "list";

export interface UnfollowProtect {
  /** Handles không bao giờ unfollow */
  whitelist: string[];
  /** Sorsa >= ngưỡng → bảo vệ (null = off) */
  sorsaMin: number | null;
  /** Bảo vệ acc có tick */
  protectVerified: boolean;
  /** Bảo vệ khi chưa có điểm Sorsa */
  protectMissingSorsa: boolean;
}

/** Ai được phép unfollow (sau lớp bảo vệ). */
export interface UnfollowTargets {
  /** Chỉ unfollow nếu Sorsa < max (null = không lọc theo max) */
  sorsaMax: number | null;
  /** any = không lọc tick; require = chỉ unfollow có tick; exclude = chỉ unfollow không tick */
  verified: VerifiedMode;
  /** Followers > max → bỏ qua / không unfollow (null = off) */
  followersMax: number | null;
  /** Chỉ unfollow acc không follow lại mình (không FL back) */
  onlyNotFollowBack: boolean;
  /** Ưu tiên unfollow các handle này */
  blacklist: string[];
}

export interface UnfollowPace {
  dailyTarget: number;
  maxPer30Min: number;
  delaySecMin: number;
  delaySecMax: number;
}

export interface UnfollowSettings {
  sourceMode: UnfollowSourceMode;
  /** own handle nếu không lấy được từ tab X */
  ownHandle: string;
  usernameList: string;
  protect: UnfollowProtect;
  targets: UnfollowTargets;
  pace: UnfollowPace;
}

export interface UnfollowCandidate {
  handle: string;
  verified: boolean;
  followers: number | null;
  sorsa: number | null;
  /** Đang Following (có nút Unfollow) */
  following: boolean;
  /** Họ có follow lại mình không (badge Follows you). null = chưa rõ */
  followsYou: boolean | null;
  ownProfile?: boolean;
}

export type UnfollowDecision =
  | { action: "unfollow"; reason: string }
  | { action: "protect"; reason: string }
  | { action: "skip"; reason: string };

export interface UnfollowLogEntry {
  id: string;
  at: number;
  handle: string;
  action: "unfollow" | "protect" | "skip" | "error" | "info";
  reason?: string;
  message: string;
}

export interface UnfollowRuntimePublic {
  running: boolean;
  sourceMode: UnfollowSourceMode;
  detail: string;
  startedAt: number | null;
  unfollowedToday: number;
  dailyTarget: number;
  unfollowedInWindow: number;
  maxPer30Min: number;
  processed: number;
  protectedCount: number;
  skipped: number;
  currentHandle: string | null;
  nextAt: number | null;
  /** Số handle đã xem trong session */
  seenCount: number;
  /** Lần cuộn liên tiếp không thấy acc mới */
  emptyScrolls: number;
  recentLogs: UnfollowLogEntry[];
}

export function createDefaultUnfollowSettings(): UnfollowSettings {
  return {
    sourceMode: "own_following",
    ownHandle: "",
    usernameList: "",
    protect: {
      whitelist: [],
      sorsaMin: 500,
      protectVerified: false,
      protectMissingSorsa: true,
    },
    targets: {
      sorsaMax: null,
      verified: "exclude",
      followersMax: null,
      onlyNotFollowBack: true,
      blacklist: [],
    },
    pace: {
      dailyTarget: 80,
      maxPer30Min: 20,
      delaySecMin: 12,
      delaySecMax: 28,
    },
  };
}

/** Số nguyên bất kỳ (không clamp max) — NaN → fallback. */
function freeInt(n: unknown, fallback: number, minFloor = 0): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return fallback;
  return Math.max(minFloor, Math.round(v));
}

/** Optional int — không giới hạn trần; rỗng → null. */
function optionalInt(n: unknown): number | null {
  if (n == null || n === "") return null;
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return null;
  return Math.round(v);
}

function parseHandleSet(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return [
      ...new Set(
        raw
          .map((x) => normalizeFollowHandle(String(x)))
          .filter((h): h is string => !!h),
      ),
    ];
  }
  if (typeof raw === "string") return parseHandleList(raw);
  return [];
}

export function sanitizeUnfollowSettings(raw: unknown): UnfollowSettings {
  const d = createDefaultUnfollowSettings();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const protectRaw =
    o.protect && typeof o.protect === "object"
      ? (o.protect as Record<string, unknown>)
      : o;
  const targetsRaw =
    o.targets && typeof o.targets === "object"
      ? (o.targets as Record<string, unknown>)
      : o;
  const paceRaw =
    o.pace && typeof o.pace === "object" ? (o.pace as Record<string, unknown>) : o;

  const verifiedRaw = targetsRaw.verified ?? o.verified;
  const verified: VerifiedMode =
    verifiedRaw === "require" || verifiedRaw === "exclude" || verifiedRaw === "any"
      ? verifiedRaw : d.targets.verified;

  const delayMin = freeInt(paceRaw.delaySecMin ?? o.delaySecMin, d.pace.delaySecMin, 0);
  let delayMax = freeInt(paceRaw.delaySecMax ?? o.delaySecMax, d.pace.delaySecMax, 0);
  if (delayMax < delayMin) delayMax = delayMin;

  return {
    sourceMode: o.sourceMode === "list" ? "list" : "own_following",
    ownHandle: normalizeFollowHandle(String(o.ownHandle ?? "")) || "",
    usernameList: typeof o.usernameList === "string" ? o.usernameList : d.usernameList,
    protect: {
      whitelist: parseHandleSet(protectRaw.whitelist ?? o.whitelist),
      sorsaMin: optionalInt(protectRaw.sorsaMin !== undefined
        ? protectRaw.sorsaMin : o.sorsaProtectMin !== undefined
          ? o.sorsaProtectMin : d.protect.sorsaMin),
      protectVerified:
        typeof (protectRaw.protectVerified ?? o.protectVerified) === "boolean"
          ? Boolean(protectRaw.protectVerified ?? o.protectVerified)
          : d.protect.protectVerified,
      protectMissingSorsa:
        typeof (protectRaw.protectMissingSorsa ?? o.protectMissingSorsa) === "boolean"
          ? Boolean(protectRaw.protectMissingSorsa ?? o.protectMissingSorsa)
          : d.protect.protectMissingSorsa,
    },
    targets: {
      sorsaMax: optionalInt(targetsRaw.sorsaMax ?? o.sorsaMax),
      verified,
      followersMax: optionalInt(targetsRaw.followersMax ?? o.followersMax),
      onlyNotFollowBack:
        typeof (targetsRaw.onlyNotFollowBack ?? o.onlyNotFollowBack) === "boolean"
          ? Boolean(targetsRaw.onlyNotFollowBack ?? o.onlyNotFollowBack)
          : d.targets.onlyNotFollowBack,
      blacklist: parseHandleSet(targetsRaw.blacklist ?? o.blacklist),
    },
    pace: {
      dailyTarget: freeInt(paceRaw.dailyTarget ?? o.dailyTarget, d.pace.dailyTarget, 1),
      maxPer30Min: freeInt(paceRaw.maxPer30Min ?? o.maxPer30Min, d.pace.maxPer30Min, 1),
      delaySecMin: delayMin,
      delaySecMax: delayMax,
    },
  };
}

/**
 * Quyết định unfollow / protect / skip.
 * Bảo vệ luôn thắng. Tất cả điều kiện hủy phải thỏa, kể cả tài khoản ưu tiên.
 */
export function evaluateUnfollowCandidate(
  c: UnfollowCandidate,
  settings: UnfollowSettings,
): UnfollowDecision {
  const handle = normalizeFollowHandle(c.handle);
  if (!handle) return { action: "skip", reason: "bad_handle" };
  if (c.ownProfile) return { action: "skip", reason: "own_profile" };
  if (!c.following) return { action: "skip", reason: "not_following" };

  const { protect, targets } = settings;

  if (protect.whitelist.includes(handle)) {
    return { action: "protect", reason: "whitelist" };
  }
  if (protect.protectVerified && c.verified) {
    return { action: "protect", reason: "verified" };
  }
  if (c.sorsa == null) {
    if (protect.protectMissingSorsa) {
      return { action: "protect", reason: "sorsa_missing" };
    }
    if (protect.sorsaMin != null) {
      return { action: "skip", reason: "sorsa_missing" };
    }
  } else if (protect.sorsaMin != null && c.sorsa >= protect.sorsaMin) {
    return { action: "protect", reason: "sorsa_high" };
  }

  // Chỉ unfollow người không FL back.
  if (targets.onlyNotFollowBack) {
    if (c.followsYou === true) {
      return { action: "protect", reason: "follows_you" };
    }
    if (c.followsYou == null) {
      return { action: "skip", reason: "follows_you_unknown" };
    }
    // followsYou === false → tiếp tục lọc khác
  }

  if (targets.verified === "require" && !c.verified) {
    return { action: "skip", reason: "verified_required" };
  }
  if (targets.verified === "exclude" && c.verified) {
    return { action: "skip", reason: "has_tick" };
  }

  if (targets.followersMax != null) {
    if (c.followers == null) return { action: "skip", reason: "followers_unknown" };
    if (c.followers > targets.followersMax) {
      return { action: "skip", reason: "followers_high" };
    }
  }

  if (targets.sorsaMax != null) {
    if (c.sorsa == null) {
      // Không đủ dữ liệu để xác nhận điều kiện hủy.
      return { action: "skip", reason: "sorsa_missing" };
    }
    if (c.sorsa >= targets.sorsaMax) {
      return { action: "skip", reason: "sorsa_above_target" };
    }
  }

  return { action: "unfollow", reason: "ok" };
}

/** Ưu tiên trong nguồn hiện tại, giữ nguyên thứ tự tương đối của mỗi nhóm. */
export function prioritizeUnfollowCandidates<T>(
  items: readonly T[], handleOf: (item: T) => string, settings: UnfollowSettings,
): T[] {
  const priority = new Set(settings.targets.blacklist);
  return [...items].sort((a, b) =>
    Number(priority.has(normalizeFollowHandle(handleOf(b)) || "")) -
    Number(priority.has(normalizeFollowHandle(handleOf(a)) || "")));
}
