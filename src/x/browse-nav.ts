/**
 * Điều hướng browse surface: ưu tiên click tab/link trên UI X.
 * Following = tab trên Home (cạnh For you), không phải /user/following.
 */

import type { BrowseSurface, AgentSettings } from "../domain/agent-settings.ts";
import { sanitizeListUrlOrName } from "../domain/agent-settings.ts";
import {
  pathIsHome,
  pathIsList,
  pathIsNotifications,
  pathIsNotificationsAll,
  pathMatchesBrowseSurface,
} from "./identity.ts";
import { findXNavigationLink } from "./navigation.ts";
import {
  enabledFeedRotationSurfaces,
  firstFeedRotationSource,
} from "../domain/feed-rotation.ts";

export type BrowseNavKind = "already" | "link" | "tab" | "back" | "reload";

const FOLLOWING_TAB_RE = /^(following|đang theo dõi)$/i;
const FOR_YOU_TAB_RE = /^(for you|dành cho bạn)$/i;
/** Tab All trên Notifications (không dùng Mentions-only). */
const NOTIFICATIONS_ALL_TAB_RE = /^(all|tất cả)$/i;

export function browseSurfaceLabel(surface: BrowseSurface): string {
  return (
    { home: "Home", following: "Following", lists: "Lists", mentions: "Thông báo" } as const
  )[surface];
}

export function browseNavError(surface: BrowseSurface, kind: Exclude<BrowseNavKind, "already">): string {
  if (kind === "back") return `navigating_${surface}_back`;
  return `navigating_${surface}`;
}

function normalizeTabLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findPrimaryColumn(doc: Document): Element | null {
  return doc.querySelector('[data-testid="primaryColumn"]') ?? doc.querySelector("main[role='main']");
}

/** Tab pill trên Home / Notifications (role=tab). */
export function findTimelineTab(
  doc: Document,
  match: RegExp,
): { el: HTMLElement; selected: boolean } | null {
  const root = findPrimaryColumn(doc) ?? doc;
  const tabs = root.querySelectorAll<HTMLElement>('[role="tab"]');
  for (const tab of tabs) {
    const label = normalizeTabLabel(
      tab.getAttribute("aria-label") || tab.textContent || "",
    );
    if (!match.test(label)) continue;
    const selected =
      tab.getAttribute("aria-selected") === "true" ||
      tab.getAttribute("data-selected") === "true";
    return { el: tab, selected };
  }
  return null;
}

export function isFollowingTabSelected(doc: Document): boolean {
  const tab = findTimelineTab(doc, FOLLOWING_TAB_RE);
  return !!tab?.selected;
}

/** Đang ở tab All của Notifications (surface browse "mentions"). */
export function isNotificationsAllSelected(doc: Document): boolean {
  if (typeof location !== "undefined" && pathIsNotificationsAll(location.pathname)) return true;
  const tab = findTimelineTab(doc, NOTIFICATIONS_ALL_TAB_RE);
  return !!tab?.selected;
}

export function enabledBrowseSurfaces(settings: AgentSettings): BrowseSurface[] {
  const out: BrowseSurface[] = [];
  if (settings.modules.homeScroll) out.push("home");
  if (settings.modules.followingFeed) out.push("following");
  if (settings.modules.lists && sanitizeListUrlOrName(settings.listUrlOrName)) out.push("lists");
  if (settings.modules.notifications) out.push("mentions");
  return out;
}

export function anyBrowseModuleOn(settings: AgentSettings): boolean {
  return enabledBrowseSurfaces(settings).length > 0;
}

/**
 * Chọn surface tuần tự (không random).
 * Ưu tiên sticky → mentions (nếu trong enabled) → nguồn feed đầu tiên theo For You → Following → Lists.
 * `weights` / `rng` / `mentionsBoost` giữ chữ ký cũ nhưng bị bỏ qua (không còn tỷ lệ random).
 */
export function pickBrowseSurface(opts: {
  enabled: BrowseSurface[];
  weights?: unknown;
  mentionsBoost?: number;
  rng?: () => number;
  /** Sticky: tiếp tục surface đang làm dở (pending job). */
  sticky?: BrowseSurface | null;
}): BrowseSurface | null {
  const enabled = opts.enabled;
  if (!enabled.length) return null;
  if (opts.sticky && enabled.includes(opts.sticky)) return opts.sticky;
  if (enabled.includes("mentions")) return "mentions";
  const feed = enabled.filter((s): s is Exclude<BrowseSurface, "mentions"> => s !== "mentions");
  if (!feed.length) return enabled[0] ?? null;
  // Thứ tự cố định For You → Following → Lists.
  for (const surface of ["home", "following", "lists"] as const) {
    if (feed.includes(surface)) return surface;
  }
  return feed[0] ?? null;
}

/** Nguồn feed xoay (không gồm Notifications). */
export function enabledFeedSurfaces(settings: AgentSettings): Array<Exclude<BrowseSurface, "mentions">> {
  return enabledFeedRotationSurfaces(settings);
}

export function pickFirstFeedSurface(
  settings: AgentSettings,
  preferred?: BrowseSurface | null,
): Exclude<BrowseSurface, "mentions"> | null {
  return firstFeedRotationSource(settings, preferred)?.surface ?? null;
}

export interface EnsureBrowseSurfaceOpts {
  surface: BrowseSurface;
  notificationTab?: "mentions" | "all";
  listUrl?: string | null;
  doc?: Document;
  pathname?: string;
  origin?: string;
  historyLength?: number;
  reloadPct?: number;
  rng?: () => number;
  click?: (el: Element) => void;
  assign?: (url: string) => void;
  back?: () => void;
  /** Inject: tìm link theo URL trên trang. */
  findLink?: (url: string) => Element | null;
}

/**
 * Đưa trang X về đúng browse surface. Ưu tiên click UI.
 */
export function ensureBrowseSurface(opts: EnsureBrowseSurfaceOpts): BrowseNavKind {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : null);
  const pathname =
    opts.pathname ?? (typeof location !== "undefined" ? location.pathname : "/");
  const origin =
    opts.origin ?? (typeof location !== "undefined" ? location.origin : "https://x.com");
  const doClick =
    opts.click ??
    ((el: Element) => {
      (el as HTMLElement).click?.();
    });
  const doAssign =
    opts.assign ??
    ((url: string) => {
      if (typeof location !== "undefined") location.assign(url);
    });
  const doBack =
    opts.back ??
    (() => {
      if (typeof history !== "undefined") history.back();
    });
  const findLink =
    opts.findLink ??
    ((url: string) => {
      if (!doc || typeof location === "undefined") return null;
      return findXNavigationLink(doc, url, location.href);
    });

  const { surface } = opts;

  if (surface === "home") {
    if (pathIsHome(pathname) && doc) {
      const following = findTimelineTab(doc, FOLLOWING_TAB_RE);
      if (following?.selected) {
        const forYou = findTimelineTab(doc, FOR_YOU_TAB_RE);
        if (forYou && !forYou.selected) {
          doClick(forYou.el);
          return "tab";
        }
      }
      return "already";
    }
    if (pathIsHome(pathname)) return "already";
    return goViaHomeChrome({
      doc,
      origin,
      historyLength: opts.historyLength,
      reloadPct: opts.reloadPct ?? 0,
      rng: opts.rng,
      doClick,
      doAssign,
      doBack,
      afterHome: null,
    });
  }

  if (surface === "following") {
    if (pathIsHome(pathname) && doc) {
      const tab = findTimelineTab(doc, FOLLOWING_TAB_RE);
      if (tab?.selected) return "already";
      if (tab) {
        doClick(tab.el);
        return "tab";
      }
      // Đã Home nhưng chưa thấy tab — coi như đã ở feed (For you); thử lại sau.
      return "already";
    }
    return goViaHomeChrome({
      doc,
      origin,
      historyLength: opts.historyLength,
      reloadPct: opts.reloadPct ?? 0,
      rng: opts.rng,
      doClick,
      doAssign,
      doBack,
      afterHome: "following",
    });
  }

  if (surface === "mentions") {
    const mentions = opts.notificationTab === "mentions";
    const match = mentions ? /^(mentions|đề cập|lượt đề cập|lượt nhắc đến|nhắc đến)$/i : NOTIFICATIONS_ALL_TAB_RE;
    const targetPath = mentions ? "/notifications/mentions" : "/notifications";
    // Product = Notifications · All (kênh/user bật thông báo cũng hiện ở đây).
    if (pathname.replace(/\/+$/, "").toLowerCase() === targetPath) {
      const tab = doc ? findTimelineTab(doc, match) : null;
      if (tab && !tab.selected) { doClick(tab.el); return "tab"; }
      return "already";
    }
    if (pathIsNotifications(pathname) && doc) {
      const tab = findTimelineTab(doc, match);
      if (tab?.selected) return "already";
      if (tab) {
        doClick(tab.el);
        return "tab";
      }
      // Đang Mentions/Verified — ưu tiên click All; fallback gán /notifications.
    }
    if (doc) {
      const notif =
        doc.querySelector<HTMLElement>('a[data-testid="AppTabBar_Notifications_Link"]') ||
        doc.querySelector<HTMLElement>('a[href="/notifications"]');
      if (notif && !pathIsNotifications(pathname)) {
        doClick(notif);
        return "link";
      }
      const allTab = findTimelineTab(doc, match);
      if (allTab && !allTab.selected) {
        doClick(allTab.el);
        return "tab";
      }
    }
    const allUrl = `${origin}${targetPath}`;
    const link = findLink(allUrl);
    if (link) {
      doClick(link);
      return "link";
    }
    doAssign(allUrl);
    return "reload";
  }

  // lists
  const listUrl = sanitizeListUrlOrName(opts.listUrl ?? "");
  if (!listUrl) {
    doAssign(`${origin}/home`);
    return "reload";
  }
  if (pathIsList(pathname) && pathMatchesBrowseSurface(pathname, "lists")) {
    try {
      const want = new URL(listUrl);
      const here = pathname.replace(/\/+$/, "").toLowerCase();
      const wantPath = want.pathname.replace(/\/+$/, "").toLowerCase();
      if (here === wantPath) return "already";
    } catch {
      /* fall through */
    }
  }
  const existing = findLink(listUrl);
  if (existing) {
    doClick(existing);
    return "link";
  }
  if (doc) {
    const listsNav =
      doc.querySelector<HTMLElement>('a[href="/i/lists"]') ||
      doc.querySelector<HTMLElement>('a[data-testid="AppTabBar_Lists_Link"]');
    if (listsNav && !pathIsList(pathname)) {
      doClick(listsNav);
      return "link";
    }
  }
  doAssign(listUrl);
  return "reload";
}

function goViaHomeChrome(opts: {
  doc: Document | null;
  origin: string;
  historyLength?: number;
  reloadPct: number;
  rng?: () => number;
  doClick: (el: Element) => void;
  doAssign: (url: string) => void;
  doBack: () => void;
  afterHome: "following" | null;
}): BrowseNavKind {
  if (opts.doc) {
    const home =
      opts.doc.querySelector<HTMLElement>('a[data-testid="AppTabBar_Home_Link"]') ||
      opts.doc.querySelector<HTMLElement>('a[href="/home"]');
    if (home) {
      opts.doClick(home);
      return "link";
    }
  }
  const histLen =
    opts.historyLength ??
    (typeof history !== "undefined" ? history.length : 1);
  const rng = opts.rng ?? Math.random;
  const preferBack = histLen > 1 && rng() * 100 >= opts.reloadPct;
  if (preferBack) {
    opts.doBack();
    return "back";
  }
  opts.doAssign(`${opts.origin}/home`);
  return "reload";
}

/** Map surface → prefix log Nhật ký. */
export function browseActivityPrefix(surface: BrowseSurface | null | undefined): string {
  if (!surface || surface === "home") return "[Home]";
  return `[${browseSurfaceLabel(surface)}]`;
}
