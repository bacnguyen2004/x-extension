import type { BrowseSurface } from "../domain/agent-settings.ts";
import { findTimelineTab } from "./browse-nav.ts";
import { pathMatchesBrowseSurface } from "./identity.ts";

export interface FeedState {
  surfaceReady: boolean;
  fingerprint: string;
  loading: boolean;
  empty: boolean;
  hasContent: boolean;
  height: number;
  atBottom: boolean;
}

export function readFeedState(doc: Document, pathname: string, surface: BrowseSurface, listUrl?: string | null): FeedState {
  const primary = doc.querySelector('[data-testid="primaryColumn"]') ?? doc.querySelector('main[role="main"]');
  let surfaceReady = pathMatchesBrowseSurface(pathname, surface) && !!primary;
  if (surface === "home" || surface === "following") {
    const tab = findTimelineTab(doc, surface === "home" ? /^(for you|dành cho bạn)$/i : /^(following|đang theo dõi)$/i);
    surfaceReady = surfaceReady && tab?.selected === true;
  } else if (surface === "lists" && listUrl) {
    try { surfaceReady = surfaceReady && new URL(listUrl, "https://x.com").pathname.replace(/\/+$/, "") === pathname.replace(/\/+$/, ""); }
    catch { surfaceReady = false; }
  } else if (surface === "mentions") {
    const tab = findTimelineTab(doc, /\/notifications\/mentions\/?$/i.test(pathname)
      ? /^(mentions|đề cập|lượt đề cập|lượt nhắc đến|nhắc đến)$/i : /^(all|tất cả)$/i);
    // All must actually be selected, not merely present in the URL.
    surfaceReady = surfaceReady && tab?.selected === true;
  }
  const articles = [...(primary?.querySelectorAll('article[data-testid="tweet"]') ?? [])].filter(article =>
    !article.closest('[hidden], [aria-hidden="true"]') &&
    (!!article.querySelector('a[href*="/status/"]') || !!article.textContent?.trim()));
  const cells = surface === "mentions" && !articles.length
    ? [...(primary?.querySelectorAll('[data-testid="notification"], [data-testid="cellInnerDiv"]') ?? [])] : [];
  const fingerprint = [...articles, ...cells].slice(0, 40).map(article => {
    const link = [...article.querySelectorAll('a[href*="/status/"]')].find(a => a.querySelector("time"))
      ?? article.querySelector('a[href*="/status/"]');
    return link?.getAttribute("href") ?? article.textContent?.slice(0, 80) ?? "";
  }).join("|");
  // X keeps loading sentinels mounted below the viewport. They must not block
  // reading/scrolling content that is already ready on screen.
  const loading = [...(primary?.querySelectorAll('[role="progressbar"], [aria-busy="true"]') ?? [])].some(el => {
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    if (typeof el.getBoundingClientRect !== "function") return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < (doc.defaultView?.innerHeight || 800);
  });
  const empty = !!primary?.querySelector('[data-testid="emptyState"], [data-testid="empty_state_header_text"]');
  const root = doc.scrollingElement ?? doc.documentElement;
  const height = root?.scrollHeight ?? 0;
  const atBottom = height > 0 && (root?.clientHeight ?? 0) > 0 && (root?.scrollTop ?? 0) + root.clientHeight >= height - 4;
  return { surfaceReady, fingerprint, loading, empty, hasContent: articles.length > 0 || cells.length > 0 || empty,
    height, atBottom };
}

/** Existing posts are usable while X fetches more. Only a source transition needs
 * evidence that the old feed has been replaced; a spinner alone is not evidence. */
export async function waitForFeedReady(
  read: () => FeedState,
  wait: (ms: number) => Promise<void>,
  opts: { before?: string; timeoutMs?: number } = {},
): Promise<{ ready: boolean; state: FeedState }> {
  let sawLoading = false, sawMissingContent = false;
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  let state = read();
  for (let elapsed = 0; elapsed <= (opts.timeoutMs ?? 8000); elapsed += 200) {
    if (Date.now() >= deadline) break;
    state = read();
    sawLoading ||= state.loading;
    sawMissingContent ||= !state.hasContent;
    const changed = opts.before == null || state.fingerprint !== opts.before || sawMissingContent || (sawLoading && !state.loading);
    const usable = state.hasContent && (!!state.fingerprint || !state.loading);
    if (state.surfaceReady && usable && changed) return { ready: true, state };
    if (elapsed < (opts.timeoutMs ?? 8000)) await wait(200);
  }
  return { ready: false, state };
}

export interface FeedRecoveryState { failures: number; reloadAt: number }
export function nextFeedRecovery(state: FeedRecoveryState, now: number): { state: FeedRecoveryState; action: "wait" | "top" | "reload" | "cooldown" } {
  const next = { ...state, failures: state.failures + 1 };
  if (next.failures === 3) return { state: next, action: "top" };
  if (next.failures >= 6) {
    if (!next.reloadAt || now - next.reloadAt >= 300000) return { state: { failures: 0, reloadAt: now }, action: "reload" };
    return { state: next, action: "cooldown" };
  }
  return { state: next, action: "wait" };
}
