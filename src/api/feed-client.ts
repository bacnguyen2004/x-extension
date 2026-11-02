/**
 * Gọi GET https://pogo.social/api/feed. Token chỉ truyền vào lúc gọi — không lưu.
 */

import type { LinkedAccount, ScanSnapshot } from "../domain/types.ts";
import { isHandle } from "../domain/url.ts";
import { normalizeApiCampaign } from "./feed-adapter.ts";
import { extractPollingNextScanAt, extractRetweetPower } from "./feed-meta.ts";

export const POGO_FEED_URL = "https://pogo.social/api/feed";

export type FeedFetchResult =
  | { ok: true; snapshot: ScanSnapshot; httpStatus: number }
  | {
      ok: false;
      httpStatus: number | null;
      error: string;
      login_required: boolean;
    };

/** Lấy mảng campaign từ nhiều dạng envelope phổ biến. */
export function extractCampaignArray(body: unknown): unknown[] {
  return campaignArray(body) ?? [];
}

function campaignArray(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  for (const key of ["campaigns", "data", "items", "feed", "results"]) {
    if (Array.isArray(o[key])) return o[key] as unknown[];
  }
  if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
    const d = o.data as Record<string, unknown>;
    for (const key of ["campaigns", "items", "feed", "results"]) {
      if (Array.isArray(d[key])) return d[key] as unknown[];
    }
  }
  return null;
}

export function extractLinkedAccount(body: unknown): LinkedAccount | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;

  const tryHandle = (v: unknown): string | null =>
    typeof v === "string" && isHandle(v) ? v : null;

  const direct =
    tryHandle(o.linked_handle) ||
    tryHandle(o.twitter_handle) ||
    tryHandle(o.x_handle) ||
    tryHandle(o.handle);
  if (direct) return { handle: direct, source: "api" };

  for (const key of ["twitter_link", "linked_account", "user", "me", "profile", "account"]) {
    const nested = o[key];
    if (!nested || typeof nested !== "object") continue;
    const n = nested as Record<string, unknown>;
    const h =
      tryHandle(n.handle) ||
      tryHandle(n.twitter_handle) ||
      tryHandle(n.x_handle) ||
      tryHandle(n.username);
    if (h) return { handle: h, source: "api" };
  }
  return null;
}

export function snapshotFromFeedBody(body: unknown, observedAt = Date.now()): ScanSnapshot {
  const rawList = extractCampaignArray(body);
  const campaigns = [];
  for (const item of rawList.slice(0, 500)) {
    const c = normalizeApiCampaign(item, observedAt);
    if (c) campaigns.push(c);
  }
  const power = extractRetweetPower(body);
  return {
    campaigns,
    scanned_at: observedAt,
    frame_url: POGO_FEED_URL,
    // An API list is authoritative even when empty (unlike an unrendered DOM).
    feed_present: campaignArray(body) !== null,
    login_required: false,
    linked_account: extractLinkedAccount(body),
    retweet_remaining: power?.remaining ?? null,
    retweet_earning_remaining: power?.earningRemaining ?? null,
    polling_next_scan_at: extractPollingNextScanAt(body, observedAt),
  };
}

export async function fetchPogoFeed(token: string, options: { resolveIdentity?: boolean } = {}): Promise<FeedFetchResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      ok: false,
      httpStatus: null,
      error: "Token trống.",
      login_required: true,
    };
  }

  let response: Response;
  try {
    response = await fetch(POGO_FEED_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: "application/json",
      },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return {
      ok: false,
      httpStatus: null,
      error: "Không gọi được https://pogo.social/api/feed (mạng hoặc CORS).",
      login_required: false,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      httpStatus: response.status,
      error: `API trả ${response.status}. Token hết hạn hoặc không hợp lệ.`,
      login_required: true,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      error: `API trả HTTP ${response.status}.`,
      login_required: false,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      httpStatus: response.status,
      error: "Body API không phải JSON.",
      login_required: false,
    };
  }

  if (campaignArray(body) === null) {
    return { ok: false, httpStatus: response.status,
      error: "Body API không có danh sách campaign hợp lệ.", login_required: false };
  }

  const snapshot = snapshotFromFeedBody(body);
  // Pogo's feed contains campaigns and power, but the viewer's X identity lives
  // at /api/me.twitter_link. Never derive it from a campaign author.
  if (options.resolveIdentity !== false && !snapshot.linked_account) {
    try {
      const me = await fetch("https://pogo.social/api/me", {
        method: "GET",
        headers: { Authorization: `Bearer ${trimmed}`, Accept: "application/json" },
        credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000),
      });
      if (me.status === 401 || me.status === 403) {
        return { ok: false, httpStatus: me.status, error: "Phiên Pogo không còn hợp lệ khi kiểm tra tài khoản.", login_required: true };
      }
      if (me.ok) snapshot.linked_account = extractLinkedAccount(await me.json());
    } catch {
      // Preserve readable feed data. Automatic auth still requires a verified
      // linked identity before committing the Bearer.
    }
  }

  return { ok: true, snapshot, httpStatus: response.status };
}
