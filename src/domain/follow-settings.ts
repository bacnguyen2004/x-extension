/**
 * Tab Follow — nguồn + bộ lọc trước khi Follow (kiểu X68 Safe Follow + Sorsa/tick).
 */

export type FollowSourceMode = "list" | "kol_followers";
export type VerifiedMode = "any" | "require" | "exclude";

export interface FollowFilters {
  /** null = không lọc min */
  sorsaMin: number | null;
  sorsaMax: number | null;
  /** true = vẫn follow khi public search không có điểm */
  allowMissingSorsa: boolean;
  verified: VerifiedMode;
  followersMin: number | null;
  followersMax: number | null;
  /** handles lowercase, không @ */
  blacklist: string[];
  whitelist: string[];
}

export interface FollowPace {
  dailyTarget: number;
  maxPer30Min: number;
  delaySecMin: number;
  delaySecMax: number;
}

export interface FollowSettings {
  sourceMode: FollowSourceMode;
  /** Textarea list mode */
  usernameList: string;
  /** KOL handle for followers scrape */
  kolHandle: string;
  engageLatestPost?: boolean;
  filters: FollowFilters;
  pace: FollowPace;
}

export interface FollowCandidate {
  handle: string;
  verified: boolean;
  followers: number | null;
  sorsa: number | null;
  alreadyFollowing?: boolean;
  ownProfile?: boolean;
}

export type FollowSkipReason =
  | "bad_handle"
  | "blacklist"
  | "not_in_whitelist"
  | "already_following"
  | "own_profile"
  | "verified_required"
  | "verified_excluded"
  | "followers_low"
  | "followers_high"
  | "followers_unknown"
  | "sorsa_low"
  | "sorsa_high"
  | "sorsa_missing";

export type FollowEvalResult =
  | { ok: true }
  | { ok: false; reason: FollowSkipReason };

export interface FollowLogEntry {
  id: string;
  at: number;
  handle: string;
  action: "follow" | "skip" | "error" | "info";
  reason?: string;
  message: string;
}

export interface FollowRuntimePublic {
  running: boolean;
  sourceMode: FollowSourceMode;
  detail: string;
  startedAt: number | null;
  followedToday: number;
  dailyTarget: number;
  followedInWindow: number;
  maxPer30Min: number;
  processed: number;
  skipped: number;
  currentHandle: string | null;
  nextAt: number | null;
  recentLogs: FollowLogEntry[];
}

export function createDefaultFollowFilters(): FollowFilters {
  return {
    sorsaMin: 200,
    sorsaMax: null,
    allowMissingSorsa: false,
    verified: "any",
    followersMin: null,
    followersMax: null,
    blacklist: [],
    whitelist: [],
  };
}

export function createDefaultFollowPace(): FollowPace {
  return {
    dailyTarget: 100,
    maxPer30Min: 14,
    delaySecMin: 45,
    delaySecMax: 150,
  };
}

export function createDefaultFollowSettings(): FollowSettings {
  return {
    sourceMode: "list",
    usernameList: "",
    kolHandle: "",
    engageLatestPost: false,
    filters: createDefaultFollowFilters(),
    pace: createDefaultFollowPace(),
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

/** Parse @user / user / https://x.com/user → lowercase handle. */
export function normalizeFollowHandle(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  let h = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      h = new URL(s).pathname.split("/").filter(Boolean)[0] || "";
    } catch {
      return null;
    }
  }
  h = h.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
  const reserved = new Set([
    "home", "explore", "search", "notifications", "messages", "settings",
    "i", "compose", "login", "signup", "followers", "following", "verified_followers",
  ]);
  if (reserved.has(h.toLowerCase())) return null;
  return h.toLowerCase();
}

export function parseHandleList(text: string): string[] {
  const parts = String(text || "")
    .split(/[\s,;]+/)
    .map((p) => normalizeFollowHandle(p))
    .filter((h): h is string => !!h);
  return [...new Set(parts)];
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

export function sanitizeFollowSettings(raw: unknown): FollowSettings {
  const d = createDefaultFollowSettings();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const filtersRaw =
    o.filters && typeof o.filters === "object"
      ? (o.filters as Record<string, unknown>)
      : o;
  const paceRaw =
    o.pace && typeof o.pace === "object" ? (o.pace as Record<string, unknown>) : o;

  const sourceMode: FollowSourceMode =
    o.sourceMode === "kol_followers" ? "kol_followers" : "list";

  const verifiedRaw = filtersRaw.verified ?? o.verified;
  const verified: VerifiedMode =
    verifiedRaw === "require" || verifiedRaw === "exclude" ? verifiedRaw : "any";

  const delayMin = freeInt(paceRaw.delaySecMin ?? o.delaySecMin, d.pace.delaySecMin, 0);
  let delayMax = freeInt(paceRaw.delaySecMax ?? o.delaySecMax, d.pace.delaySecMax, 0);
  if (delayMax < delayMin) delayMax = delayMin;

  return {
    sourceMode,
    usernameList: typeof o.usernameList === "string" ? o.usernameList : d.usernameList,
    kolHandle: normalizeFollowHandle(String(o.kolHandle ?? "")) || "",
    engageLatestPost: o.engageLatestPost === true,
    filters: {
      sorsaMin: optionalInt(filtersRaw.sorsaMin !== undefined ? filtersRaw.sorsaMin
        : o.sorsaMin !== undefined ? o.sorsaMin : d.filters.sorsaMin),
      sorsaMax: optionalInt(filtersRaw.sorsaMax ?? o.sorsaMax),
      allowMissingSorsa:
        typeof (filtersRaw.allowMissingSorsa ?? o.allowMissingSorsa) === "boolean"
          ? Boolean(filtersRaw.allowMissingSorsa ?? o.allowMissingSorsa)
          : d.filters.allowMissingSorsa,
      verified,
      followersMin: optionalInt(filtersRaw.followersMin ?? o.followersMin),
      followersMax: optionalInt(filtersRaw.followersMax ?? o.followersMax),
      blacklist: parseHandleSet(filtersRaw.blacklist ?? o.blacklist),
      whitelist: parseHandleSet(filtersRaw.whitelist ?? o.whitelist),
    },
    pace: {
      dailyTarget: freeInt(paceRaw.dailyTarget ?? o.dailyTarget, d.pace.dailyTarget, 1),
      maxPer30Min: freeInt(paceRaw.maxPer30Min ?? o.maxPer30Min, d.pace.maxPer30Min, 1),
      delaySecMin: delayMin,
      delaySecMax: delayMax,
    },
  };
}

/** Parse "1.2K", "12,345", "1,2N", "3.4M" → number | null */
export function parseFollowersCount(text: string): number | null {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  // Prefer number near Followers / người theo dõi
  const m =
    raw.match(/([\d.,]+)\s*([KkMmBb])?\s*(?:Followers|followers|Người theo dõi|người theo dõi)/) ||
    raw.match(/^([\d.,]+)\s*([KkMmBb])?$/);
  if (!m) return null;
  let numStr = m[1];
  if (!m[2] && /^\d{1,3}(?:[.,]\d{3})+$/.test(numStr)) {
    numStr = numStr.replace(/[.,]/g, "");
  } else if (numStr.includes(".") && numStr.includes(",")) {
    const decimal = numStr.lastIndexOf(".") > numStr.lastIndexOf(",") ? "." : ",";
    numStr = numStr.replace(decimal === "." ? /,/g : /\./g, "").replace(",", ".");
  } else {
    numStr = numStr.replace(",", ".");
  }
  const n = Number(numStr);
  if (!Number.isFinite(n)) return null;
  const suf = (m[2] || "").toUpperCase();
  const mult = suf === "K" ? 1e3 : suf === "M" ? 1e6 : suf === "B" ? 1e9 : 1;
  return Math.round(n * mult);
}

export function evaluateFollowCandidate(
  c: FollowCandidate,
  filters: FollowFilters,
): FollowEvalResult {
  const handle = normalizeFollowHandle(c.handle);
  if (!handle) return { ok: false, reason: "bad_handle" };

  if (c.ownProfile) return { ok: false, reason: "own_profile" };
  if (c.alreadyFollowing) return { ok: false, reason: "already_following" };

  if (filters.blacklist.includes(handle)) return { ok: false, reason: "blacklist" };
  if (filters.whitelist.length > 0 && !filters.whitelist.includes(handle)) {
    return { ok: false, reason: "not_in_whitelist" };
  }

  if (filters.verified === "require" && !c.verified) {
    return { ok: false, reason: "verified_required" };
  }
  if (filters.verified === "exclude" && c.verified) {
    return { ok: false, reason: "verified_excluded" };
  }

  const needFollowers =
    filters.followersMin != null || filters.followersMax != null;
  if (needFollowers && c.followers == null) {
    return { ok: false, reason: "followers_unknown" };
  }
  if (filters.followersMin != null && (c.followers as number) < filters.followersMin) {
    return { ok: false, reason: "followers_low" };
  }
  if (filters.followersMax != null && (c.followers as number) > filters.followersMax) {
    return { ok: false, reason: "followers_high" };
  }

  const needSorsa = filters.sorsaMin != null || filters.sorsaMax != null;
  if (c.sorsa == null) {
    if (needSorsa && !filters.allowMissingSorsa) {
      return { ok: false, reason: "sorsa_missing" };
    }
  } else {
    if (filters.sorsaMin != null && c.sorsa < filters.sorsaMin) {
      return { ok: false, reason: "sorsa_low" };
    }
    if (filters.sorsaMax != null && c.sorsa > filters.sorsaMax) {
      return { ok: false, reason: "sorsa_high" };
    }
  }

  return { ok: true };
}
