import type { BrowseSurface } from "../domain/agent-settings.ts";
import { pickScrollRoots } from "./scroll.ts";
import { findTimelineTab } from "./browse-nav.ts";
import { assertActionActive, ActionStoppedError, ActionDeadlineError } from "./action-control.ts";

const KEY = "xcc.notificationReturn";
/** Tab-local position survives content-script reloads; never overwrite it while in Notifications/a thread. */
export function rememberNotificationPosition(account: string): void {
  const path = location.pathname.replace(/\/+$/, "");
  const source: BrowseSurface | null = path === "/home"
    ? findTimelineTab(document, /^(following|đang theo dõi)$/i)?.selected ? "following" : "home"
    : /^\/i\/lists\/\d+$/.test(path) ? "lists" : null;
  if (!source || !/^[a-z0-9_]{1,15}$/i.test(account)) return;
  const positions = pickScrollRoots(document, window).map(root => Math.max(0, root.scrollY ?? root.scrollTop ?? 0));
  try { sessionStorage.setItem(KEY, JSON.stringify({ account: account.toLowerCase(), source, path, positions, at: Date.now() })); } catch {}
}

export function restoreNotificationPosition(account: string, source: BrowseSurface): void {
  assertActionActive();
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (!saved || saved.account !== account.toLowerCase() || saved.source !== source || saved.path !== location.pathname.replace(/\/+$/, "") ||
        !Number.isFinite(saved.at) || Date.now() - saved.at > 30 * 60000 || !Array.isArray(saved.positions)) return;
    pickScrollRoots(document, window).forEach((root, index) => {
      assertActionActive();
      const top = saved.positions[index];
      if (Number.isFinite(top) && top >= 0) root.scrollBy({ top: top - (root.scrollY ?? root.scrollTop ?? 0), behavior: "auto" });
    });
    sessionStorage.removeItem(KEY);
  } catch (error) {
    if (error instanceof ActionStoppedError || error instanceof ActionDeadlineError) throw error;
  }
}

export function notificationNavigationBlocked(doc: Document): boolean {
  return [...doc.querySelectorAll('[data-testid="tweetTextarea_0"]')].some(el =>
    !el.closest('[hidden], [aria-hidden="true"]') && (!!el.closest('[role="dialog"]') || !!el.textContent?.trim()));
}
