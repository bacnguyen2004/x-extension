/**
 * FeedNavigator — chuyển nguồn For You / Following / Lists, xác minh thành công.
 * Có navigationLock để tránh nhiều lệnh chuyển đồng thời.
 */

import type { BrowseSurface } from "../domain/agent-settings.ts";
import { readFeedState } from "./feed-state.ts";
import {
  browseNavError,
  ensureBrowseSurface,
  findTimelineTab,
  type BrowseNavKind,
  type EnsureBrowseSurfaceOpts,
} from "./browse-nav.ts";
import { pathMatchesBrowseSurface } from "./identity.ts";

export type FeedNavResult = {
  kind: BrowseNavKind;
  error?: string;
  detail?: string;
  /** Trang đang ở nguồn khác (user đổi thủ công) khi không force. */
  overrideSurface?: Exclude<BrowseSurface, "mentions">;
  verified?: boolean;
};

let navigationLock = false;
let navigationLockAt = 0;
const LOCK_TTL_MS = 15_000;

export function isFeedNavigationLocked(now = Date.now()): boolean {
  if (!navigationLock) return false;
  if (now - navigationLockAt > LOCK_TTL_MS) {
    navigationLock = false;
    return false;
  }
  return true;
}

export function acquireFeedNavigationLock(now = Date.now()): boolean {
  if (isFeedNavigationLocked(now)) return false;
  navigationLock = true;
  navigationLockAt = now;
  return true;
}

export function releaseFeedNavigationLock(): void {
  navigationLock = false;
  navigationLockAt = 0;
}

/** Test helper. */
export function resetFeedNavigationLock(): void {
  releaseFeedNavigationLock();
}

function detectFeedSurfaceOnPage(
  doc: Document,
  pathname: string,
  listUrl?: string | null,
): Exclude<BrowseSurface, "mentions"> | null {
  if (pathMatchesBrowseSurface(pathname, "lists")) {
    if (!listUrl) return "lists";
    try {
      const want = new URL(listUrl, "https://x.com").pathname.replace(/\/+$/, "").toLowerCase();
      const here = pathname.replace(/\/+$/, "").toLowerCase();
      if (here === want) return "lists";
    } catch {
      return "lists";
    }
  }
  if (pathMatchesBrowseSurface(pathname, "home")) {
    const following = findTimelineTab(doc, /^(following|đang theo dõi)$/i);
    if (following?.selected) return "following";
    const forYou = findTimelineTab(doc, /^(for you|dành cho bạn)$/i);
    if (forYou?.selected) return "home";
    // /home nhưng chưa đọc được tab — không đoán.
    return null;
  }
  return null;
}

export interface NavigateFeedOpts extends EnsureBrowseSurfaceOpts {
  /** Ép chuyển dù trang đang ở nguồn khác (scheduler switch). */
  force?: boolean;
  /** List URL đã cấu hình — dùng để nhận diện override Lists. */
  configuredListUrl?: string | null;
  now?: number;
}

/**
 * Điều hướng tới nguồn. Không force: nếu user đang ở nguồn feed khác thì báo override.
 */
export function navigateFeedSource(opts: NavigateFeedOpts): FeedNavResult {
  const now = opts.now ?? Date.now();
  if (!acquireFeedNavigationLock(now)) {
    return { kind: "already", error: "navigation_locked", detail: "busy" };
  }
  try {
    const doc = opts.doc ?? (typeof document !== "undefined" ? document : null);
    const pathname =
      opts.pathname ?? (typeof location !== "undefined" ? location.pathname : "/");
    const surface = opts.surface;
    if (surface === "mentions") {
      const kind = ensureBrowseSurface(opts);
      if (kind === "already") return { kind, verified: true };
      return {
        kind,
        error: browseNavError(surface, kind === "back" ? "back" : kind === "reload" ? "reload" : "link"),
        detail: kind,
      };
    }

    if (!opts.force && doc) {
      const onPage = detectFeedSurfaceOnPage(doc, pathname, opts.configuredListUrl ?? opts.listUrl);
      if (onPage && onPage !== surface) {
        return {
          kind: "already",
          overrideSurface: onPage,
          detail: "user_override",
          verified: true,
        };
      }
    }

    const before = doc
      ? readFeedState(doc, pathname, surface, opts.listUrl).fingerprint
      : "";
    const kind = ensureBrowseSurface(opts);
    if (kind === "already") {
      const verified = doc
        ? readFeedState(doc, pathname, surface, opts.listUrl).surfaceReady
        : true;
      return { kind, verified, detail: before };
    }
    const errKind: Exclude<BrowseNavKind, "already"> =
      kind === "back" ? "back" : kind === "reload" ? "reload" : "link";
    return {
      kind,
      error: browseNavError(surface, errKind),
      detail: kind,
      verified: false,
    };
  } finally {
    // Giữ lock ngắn để lệnh song song thấy busy; caller xác nhận xong mới release sớm hơn nếu cần.
    // Auto-expire qua TTL.
  }
}

export function verifyFeedSource(
  doc: Document,
  pathname: string,
  surface: BrowseSurface,
  listUrl?: string | null,
): boolean {
  return readFeedState(doc, pathname, surface, listUrl).surfaceReady;
}
