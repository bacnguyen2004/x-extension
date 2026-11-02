/**
 * Về Home qua nút Home hoặc Back; chỉ tải trang khi không còn lựa chọn.
 */

import { pathIsHome } from "./identity.ts";

export type HomeNavKind = "already" | "link" | "back" | "reload";

/**
 * @param reloadPct xác suất full mở /home (0–100). Mặc định 0.
 */
export function goHomeNaturally(opts?: {
  reloadPct?: number;
  rng?: () => number;
  /** Inject cho test */
  historyLength?: number;
  assign?: (url: string) => void;
  back?: () => void;
  pathname?: string;
  origin?: string;
  activateHome?: () => boolean;
}): HomeNavKind {
  const pathname = opts?.pathname ?? (typeof location !== "undefined" ? location.pathname : "/");
  if (pathIsHome(pathname)) return "already";

  const activateHome = opts?.activateHome ?? (() => {
    if (typeof document === "undefined" || opts?.assign || opts?.back) return false;
    const link = document.querySelector<HTMLAnchorElement>('a[data-testid="AppTabBar_Home_Link"], a[href="/home"]');
    if (!link) return false;
    link.click();
    return true;
  });
  if (activateHome()) return "link";
  const reloadPct = Math.max(0, Math.min(100, opts?.reloadPct ?? 0));
  const rng = opts?.rng ?? Math.random;
  const histLen =
    opts?.historyLength ??
    (typeof history !== "undefined" ? history.length : 1);
  const origin =
    opts?.origin ??
    (typeof location !== "undefined" ? location.origin : "https://x.com");
  const doAssign =
    opts?.assign ??
    ((url: string) => {
      location.assign(url);
    });
  const doBack =
    opts?.back ??
    (() => {
      history.back();
    });

  const preferBack = histLen > 1 && rng() * 100 >= reloadPct;
  if (preferBack) {
    doBack();
    return "back";
  }
  doAssign(`${origin}/home`);
  return "reload";
}

export function homeNavError(kind: Exclude<HomeNavKind, "already">): string {
  return kind === "back" ? "navigating_home_back" : "navigating_home";
}
