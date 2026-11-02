/** Nhận diện phiên X từ DOM (không đoán bằng cookie). */

export interface XIdentity {
  loggedIn: boolean;
  /** True chỉ khi chắc chắn đang ở tường login/signup. */
  loginWall: boolean;
  handle: string | null;
  composerPresent: boolean;
  onHome: boolean;
}

function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(t)) return null;
  return t;
}

export function pathIsHome(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === "/home" || p === "/";
}

/** Trang list timeline: /i/lists/<id> hoặc /user/lists/<slug>. */
export function pathIsList(pathname: string): boolean {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0].toLowerCase() === "i" && parts[1].toLowerCase() === "lists") {
    return /^\d{4,20}$/.test(parts[2]);
  }
  if (parts.length >= 3 && parts[1].toLowerCase() === "lists") {
    return /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) && /^[A-Za-z0-9_-]{1,64}$/.test(parts[2]);
  }
  return false;
}

export function pathIsNotifications(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "").toLowerCase();
  return p === "/notifications" || p.startsWith("/notifications/");
}

/** Mentions tab: /notifications/mentions. */
export function pathIsMentions(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "").toLowerCase();
  return p === "/notifications/mentions";
}

/**
 * Tab All của Thông báo: `/notifications` (không gồm Mentions / Verified).
 * Agent dùng All vì kênh/user bật thông báo cũng hiện ở đây.
 */
export function pathIsNotificationsAll(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "").toLowerCase();
  return p === "/notifications";
}

/** Path phù hợp để scroll/scan theo browse surface. */
export function pathMatchesBrowseSurface(
  pathname: string,
  surface: "home" | "following" | "lists" | "mentions",
): boolean {
  if (surface === "home" || surface === "following") return pathIsHome(pathname);
  if (surface === "lists") return pathIsList(pathname);
  // Surface id vẫn là "mentions" (storage/weights); nav thực tế = Notifications All.
  return pathIsNotificationsAll(pathname) || pathIsMentions(pathname);
}

function pathIsAuthFlow(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return (
    p.includes("/i/flow/login") ||
    p.includes("/i/flow/signup") ||
    p === "/login" ||
    p.startsWith("/login/") ||
    p === "/logout" ||
    p.startsWith("/logout/")
  );
}

/**
 * Heuristic DOM cho x.com / twitter.com.
 * Ưu tiên tín hiệu “đã vào app” (nav/timeline/tweet) hơn link /login phụ.
 * Khi SPA còn load, /home không có loginButton → coi như đã login (optimistic).
 */
export function detectXIdentity(
  doc: Pick<Document, "querySelector">,
  pathname: string,
): XIdentity {
  const composerPresent = !!(
    doc.querySelector('a[data-testid="SideNav_NewTweet_Button"]') ||
    doc.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
    doc.querySelector('a[href="/compose/post"]') ||
    doc.querySelector('a[href="/compose/tweet"]') ||
    doc.querySelector('[data-testid="tweetButtonInline"]') ||
    doc.querySelector('[data-testid="tweetTextarea_0"]')
  );

  const hasTimeline = !!(
    doc.querySelector('article[data-testid="tweet"]') ||
    doc.querySelector('[data-testid="tweet"]') ||
    doc.querySelector('[data-testid="cellInnerDiv"]')
  );

  const hasAppChrome = !!(
    doc.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
    doc.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
    doc.querySelector('[data-testid="AppTabBar_Explore_Link"]') ||
    doc.querySelector('[data-testid="AppTabBar_Notifications_Link"]') ||
    doc.querySelector('[data-testid="primaryColumn"]') ||
    doc.querySelector('[data-testid="sidebarColumn"]') ||
    doc.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
    doc.querySelector('[data-testid="SearchBox_Search_Input"]') ||
    doc.querySelector('header[role="banner"]') ||
    doc.querySelector('main[role="main"]') ||
    doc.querySelector('nav[role="navigation"]')
  );

  const profileLink = doc.querySelector('a[data-testid="AppTabBar_Profile_Link"]') as {
    getAttribute(name: string): string | null;
  } | null;
  const profileHref = profileLink?.getAttribute("href");
  let handle = normalizeHandle(profileHref?.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "").replace(/^\//, "").replace(/[/?#].*$/, "") ?? null);

  if (!handle) {
    const switcher = doc.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') as {
      getAttribute(name: string): string | null;
      textContent?: string | null;
    } | null;
    const label = `${switcher?.getAttribute("aria-label") ?? ""} ${switcher?.textContent ?? ""}`;
    const m = label.match(/@([A-Za-z0-9_]{1,15})/);
    handle = normalizeHandle(m?.[1] ?? null);
  }

  if (!handle) {
    // Compact sidebars hide the @handle text but retain the active account avatar.
    const avatar = doc.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] [data-testid^="UserAvatar-Container-"]');
    handle = normalizeHandle(avatar?.getAttribute("data-testid")?.replace(/^UserAvatar-Container-/, ""));
  }

  const loginCta = !!(
    doc.querySelector('[data-testid="loginButton"]') ||
    doc.querySelector('[data-testid="login"]') ||
    doc.querySelector('a[href="/login"]')
  );

  const authFlow = pathIsAuthFlow(pathname);
  const loginWall =
    authFlow ||
    (loginCta && !hasAppChrome && !composerPresent && !handle && !hasTimeline);

  // Optimistic: đã thấy app/timeline/composer/handle, hoặc đang /home mà không phải login wall.
  const loggedIn =
    !loginWall &&
    (composerPresent ||
      !!handle ||
      hasAppChrome ||
      hasTimeline ||
      (pathIsHome(pathname) && !loginCta));

  return {
    loggedIn,
    loginWall,
    handle,
    composerPresent,
    onHome: pathIsHome(pathname),
  };
}
