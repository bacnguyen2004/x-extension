/**
 * Quét UserCell / profile header cho Tab Follow: handle, verified, followers, nút Follow.
 */

import { click, qs, sleep, waitFor } from "../x/dom-utils.ts";
import { pickScrollRoots, runScrollBurst } from "../x/scroll.ts";
import {
  normalizeFollowHandle,
  parseFollowersCount,
  type FollowCandidate,
} from "../domain/follow-settings.ts";

export type CellCandidate = FollowCandidate & {
  hasFollowButton: boolean;
  /** Họ follow lại mình? (Follows you) */
  followsYou?: boolean | null;
};

function textOf(el: Element | null | undefined): string {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

/** Verified / affiliate tick trong name row (giống logic badge Sorsa). */
export function isVerifiedInRoot(root: Element): boolean {
  if (root.querySelector('[data-testid="icon-verified"]')) return true;
  if (root.querySelector('[aria-label*="Verified" i], [aria-label*="Đã xác nhận" i]')) {
    return true;
  }
  if (root.querySelector('[aria-label*="Affiliate" i], [aria-label*="liên kết" i]')) {
    return true;
  }
  // SVG sau link tên thường là tick.
  const nameLink = root.querySelector('a[href^="/"]');
  if (nameLink?.parentElement) {
    const row = nameLink.parentElement;
    if (row.querySelector("svg") && /verified|xác nhận/i.test(row.innerHTML || "")) {
      return true;
    }
    // Nhiều layout: svg sibling không có data-testid
    const svgs = row.querySelectorAll("svg");
    if (svgs.length > 0 && nameLink.nextElementSibling?.querySelector("svg")) return true;
  }
  return !!root.querySelector('svg[aria-label*="Verified" i]');
}

function handleFromRoot(root: Element): string | null {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    if (!m) continue;
    const h = normalizeFollowHandle(m[1]);
    if (h) return h;
  }
  const at = textOf(root).match(/@([A-Za-z0-9_]{1,15})\b/);
  return at ? normalizeFollowHandle(at[1]) : null;
}

function followersFromCell(cell: Element): number | null {
  // Chỉ lấy từ liên kết thống kê, không dùng số ghi trong tên/bio.
  const link = cell.querySelector('a[href$="/followers"], a[href$="/verified_followers"]');
  return link ? parseFollowersCount(textOf(link)) : null;
}

/** Badge “Follows you” / “Theo dõi bạn” trên UserCell hoặc profile. */
export function detectFollowsYou(root: Element | null | undefined): boolean | null {
  if (!root) return null;
  if (root.matches('[data-testid="userFollowIndicator"]') || root.querySelector('[data-testid="userFollowIndicator"]')) return true;
  const blob = textOf(root);
  if (/follows you|theo dõi bạn|đang theo dõi bạn/i.test(blob)) return true;
  // Thiếu badge không chứng minh họ không follow: có thể chưa tải hoặc khác ngôn ngữ.
  return null;
}

function followControlsIn(scope: ParentNode, handle: string, profileOnly = false): {
  follow: HTMLElement | null;
  unfollow: HTMLElement | null;
} {
  let follow: HTMLElement | null = null;
  let unfollow: HTMLElement | null = null;
  const buttons = scope.querySelectorAll<HTMLElement>('button, [role="button"]');
  for (const el of buttons) {
    if (profileOnly && el.closest('article, [data-testid="UserCell"], [data-testid="sidebarColumn"], aside')) continue;
    const testId = (el.getAttribute("data-testid") || "").toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    if (profileOnly) {
      const mentions = aria.match(/@[a-z0-9_]+/g);
      if (mentions?.length && !mentions.includes(`@${handle}`)) continue;
    }
    const label = textOf(el).toLowerCase();
    if (testId.endsWith("-unfollow") || /following|đang theo dõi|unfollow|hủy theo dõi/.test(aria + label)) {
      unfollow = el;
      continue;
    }
    if (
      testId.endsWith("-follow") ||
      /^follow$|^theo dõi$/i.test(label) ||
      ((aria.includes("follow") || aria.includes("theo dõi")) &&
        !aria.includes("following") &&
        !aria.includes("unfollow"))
    ) {
      if (aria.includes("@") && handle && !aria.includes(`@${handle.toLowerCase()}`)) continue;
      follow = el;
    }
  }
  return { follow, unfollow };
}

/** Quét UserCell trong primaryColumn (Following/Followers list). */
export function scanFollowUserCells(seen: Set<string> = new Set()): CellCandidate[] {
  const column =
    qs('[data-testid="primaryColumn"]') ||
    qs('main[role="main"]') ||
    document.body;
  if (!column) return [];

  const out: CellCandidate[] = [];
  const onFollowingList = typeof location !== "undefined" &&
    /^\/[A-Za-z0-9_]{1,15}\/following\/?$/i.test(location.pathname);
  column.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
    // Bỏ suggestion sidebar nếu lọt
    if (cell.closest('[data-testid="sidebarColumn"]')) return;
    const handle = handleFromRoot(cell);
    if (!handle || seen.has(handle)) return;
    const { follow, unfollow } = followControlsIn(cell, handle);
    const relationship = detectFollowsYou(cell);
    const hasHandle = Array.from(cell.querySelectorAll('a[href]')).some(link =>
      Array.from(textOf(link).matchAll(/@([A-Za-z0-9_]{1,15})\b/g))
        .some(match => normalizeFollowHandle(match[1]) === handle));
    const cellReady = onFollowingList && hasHandle && !!unfollow &&
      !cell.closest('[aria-busy="true"]') && !cell.querySelector('[role="progressbar"], [aria-busy="true"]');
    out.push({
      handle,
      verified: isVerifiedInRoot(cell),
      followers: followersFromCell(cell),
      sorsa: null,
      alreadyFollowing: !!unfollow,
      hasFollowButton: !!follow && !unfollow,
      // Following đã hiển thị đủ: không có badge nghĩa là không follow lại.
      followsYou: relationship ?? (cellReady ? false : null),
    });
  });
  return out;
}

/** Meta trên trang profile đang mở. */
export function readFollowProfileMeta(expectedHandle?: string | null): FollowCandidate & {
  onProfile: boolean;
  hasFollowButton: boolean;
  followsYou: boolean | null;
} {
  const path = location.pathname.replace(/\/+$/, "");
  const pathHandle = normalizeFollowHandle(path.split("/").filter(Boolean)[0] || "");
  const handle = expectedHandle
    ? normalizeFollowHandle(expectedHandle)
    : pathHandle;
  const onProfile = !!(handle && path.toLowerCase() === `/${handle}`);

  const column =
    qs('[data-testid="primaryColumn"]') ||
    qs('main[role="main"]') ||
    document.body;

  const nameRoot = Array.from(column?.querySelectorAll('[data-testid="UserName"], [data-testid="User-Name"]') || [])
    .find(el => !el.closest('article, [data-testid="UserCell"], aside'));

  let followers: number | null = null;
  // Link /followers trên profile header
  const flwLink = handle ? Array.from(column?.querySelectorAll(`a[href="/${handle}/followers"], a[href="/${handle}/verified_followers"]`) || [])
    .find(el => !el.closest('article, [data-testid="UserCell"], aside')) : undefined;
  if (flwLink) {
    followers = parseFollowersCount(textOf(flwLink)) ?? parseFollowersCount(textOf(flwLink.parentElement));
  }

  const verified = nameRoot ? isVerifiedInRoot(nameRoot) : column ? isVerifiedInRoot(column) : false;
  const controls = handle && column ? followControlsIn(column, handle, true) : { follow: null, unfollow: null };
  const ownProfile = !!qs('[data-testid="editProfileButton"]', column || document);

  // Chỉ đọc badge quan hệ trong header; nội dung bài viết không phải bằng chứng.
  let followsYou: boolean | null = null;
  if (nameRoot && detectFollowsYou(nameRoot) === true) followsYou = true;
  else if (Array.from(column?.querySelectorAll('[data-testid="userFollowIndicator"]') || [])
    .some(el => !el.closest('article, [data-testid="UserCell"], aside'))) {
    followsYou = true;
  }
  // Chỉ suy ra "không follow lại" khi đúng profile và header đã tải đủ.
  const nameMatches = nameRoot && Array.from(textOf(nameRoot).matchAll(/@([A-Za-z0-9_]{1,15})\b/g))
    .some(match => normalizeFollowHandle(match[1]) === handle);
  if (followsYou == null && onProfile && nameMatches && flwLink &&
    (controls.follow || controls.unfollow) && !nameRoot?.closest('[aria-busy="true"]')) {
    followsYou = false;
  }

  return {
    handle: handle || "",
    verified,
    followers,
    sorsa: null,
    alreadyFollowing: !!controls.unfollow,
    ownProfile,
    onProfile,
    hasFollowButton: !!controls.follow && !controls.unfollow,
    followsYou,
  };
}

function findUserCell(handle: string): Element | null {
  const column =
    qs('[data-testid="primaryColumn"]') ||
    qs('main[role="main"]') ||
    document.body;
  if (!column) return null;
  for (const c of column.querySelectorAll('[data-testid="UserCell"]')) {
    if (handleFromRoot(c) === handle) return c;
  }
  return null;
}

/** Click Follow trên UserCell của handle (list Followers). */
export async function followInUserCell(handleRaw: string): Promise<{
  ok: boolean;
  detail?: string;
  error?: string;
}> {
  const handle = normalizeFollowHandle(handleRaw);
  if (!handle) return { ok: false, error: "bad_handle" };

  const cell = findUserCell(handle);
  if (!cell) return { ok: false, error: "cell_not_found" };

  const { follow, unfollow } = followControlsIn(cell, handle);
  if (unfollow) return { ok: true, detail: "already_following" };
  if (!follow) return { ok: false, error: "follow_btn_missing" };
  if (follow.getAttribute("aria-disabled") === "true" || (follow as HTMLButtonElement).disabled) {
    return { ok: false, error: "follow_disabled" };
  }
  if (!click(follow)) return { ok: false, error: "follow_click_failed" };

  const confirmed = await waitFor(() => {
    const again = followControlsIn(cell, handle);
    return again.unfollow ? again : null;
  }, 5000);
  if (!confirmed) return { ok: false, error: "follow_not_confirmed" };
  return { ok: true, detail: "follow_confirmed" };
}

/** Click Unfollow trên UserCell (Following list). Xác nhận dialog nếu có. */
export async function unfollowInUserCell(handleRaw: string): Promise<{
  ok: boolean;
  detail?: string;
  error?: string;
}> {
  const handle = normalizeFollowHandle(handleRaw);
  if (!handle) return { ok: false, error: "bad_handle" };

  const cell = findUserCell(handle);
  if (!cell) return { ok: false, error: "cell_not_found" };

  const { follow, unfollow } = followControlsIn(cell, handle);
  if (follow && !unfollow) return { ok: true, detail: "already_not_following" };
  if (!unfollow) return { ok: false, error: "unfollow_btn_missing" };
  if (!click(unfollow)) return { ok: false, error: "unfollow_click_failed" };

  // Dialog xác nhận Unfollow
  await sleep(400);
  const confirm =
    qs('[data-testid="confirmationSheetConfirm"]') ||
    Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find((el) =>
      /^(unfollow|hủy theo dõi)$/i.test((el.textContent || "").trim()),
    ) ||
    null;
  if (confirm) {
    click(confirm);
  }

  const done = await waitFor(() => {
    const again = followControlsIn(cell, handle);
    return again.follow && !again.unfollow ? again : null;
  }, 5000);
  if (!done) return { ok: false, error: "unfollow_not_confirmed" };
  return { ok: true, detail: "unfollow_confirmed" };
}

/**
 * Cuộn Following/Followers. X thường không cuộn trên primaryColumn —
 * dùng nhiều root (overflow con + window) giống Home scroll.
 */
export async function scrollFollowersList(steps = 3): Promise<void> {
  const roots = pickScrollRoots(document, window as unknown as {
    scrollBy(options: { top: number; behavior?: ScrollBehavior }): void;
  });
  const primary = roots[0];
  if (!primary) {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    await sleep(500);
    return;
  }
  const distancePx = Math.max(600, Math.floor(window.innerHeight * 0.95) * Math.max(1, steps));
  await runScrollBurst(
    primary,
    {
      distancePx,
      steps: Math.max(3, Math.min(8, steps + 1)),
      stepDelayMs: 280 + Math.floor(Math.random() * 220),
    },
    sleep,
    roots.slice(1),
  );
  // Cho virtual list hydrate UserCell mới.
  await sleep(700);
}
