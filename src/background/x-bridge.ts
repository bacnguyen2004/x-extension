import type { XConnectionPublic } from "../domain/agent-settings.ts";
import { sanitizeOwnerPost, type OwnerPost } from "../domain/reply-conversation.ts";
import { isXTabSender, type MessageSenderLike } from "../messages/validate.ts";
import { rememberFollow } from "./follow-history.ts";
import { waitForFollowProfile } from "./follow-profile.ts";
import { noteXPageReady, xPageRetryDelay } from "./x-page-health.ts";

interface XTabInfo {
  notificationCount?: number | null;
  accountBlock?: string | null;
  tabId: number;
  port: chrome.runtime.Port;
  url: string | null;
  loggedIn: boolean | null;
  handle: string | null;
  composerPresent: boolean | null;
  onHome: boolean | null;
  lastSeenAt: number;
}

const RESULT_TYPES = new Set([
  "x_navigate_link_result",
  "x_prepare_tweet_result",
  "x_back_to_browse_result",
  "x_scroll_result",
  "x_like_result",
  "x_retweet_result",
  "x_tweet_engage_result",
  "x_reply_result",
  "x_quote_result",
  "x_follow_result",
  "x_follow_scan_result",
  "x_follow_profile_meta_result",
  "x_follow_cell_result",
  "x_follow_scroll_list_result",
  "x_unfollow_cell_result",
  "x_unfollow_result",
  "x_post_scan_collect_result",
  "x_post_scan_scroll_result",
  "x_timeline_scan_result",
  "x_latest_profile_post_result",
]);

const tabs = new Map<string, XTabInfo>();
let selectedTabId: number | undefined;
let navigationTail: Promise<unknown> = Promise.resolve();
let navigationGeneration = 0;
const unresponsiveReloadAt = new Map<number, number>();

export function getSelectedXTabId(): number | undefined { return selectedTabId; }

export function selectXTab(tabId: number): void {
  selectedTabId = tabId;
}

function keyOf(sender: MessageSenderLike): string {
  return `${sender.tab!.id}:${sender.frameId ?? 0}`;
}

export function getXAccountForSender(sender: MessageSenderLike): string | null {
  if (sender.tab?.id == null) return null;
  return tabs.get(keyOf(sender))?.handle ?? null;
}

export function getXConnection(): XConnectionPublic {
  const preferred = pickPort();
  if (!preferred) {
    return {
      connected: false,
      tabCount: tabs.size,
      url: null,
      loggedIn: null,
      handle: null,
      composerPresent: null,
      onHome: null,
      lastSeenAt: null,
    };
  }
  return {
    connected: true,
    accountBlock: preferred.accountBlock,
    notificationCount: preferred.notificationCount ?? null,
    tabCount: tabs.size,
    url: preferred.url,
    // Không nhận diện login — luôn coi là OK khi đã có tab.
    loggedIn: true,
    handle: preferred.handle,
    composerPresent: preferred.composerPresent,
    onHome: preferred.onHome,
    lastSeenAt: preferred.lastSeenAt,
  };
}

export function attachXPort(port: chrome.runtime.Port, extensionId: string): boolean {
  const sender = port.sender as MessageSenderLike | undefined;
  if (!sender || !isXTabSender(sender, extensionId)) {
    port.disconnect();
    return false;
  }
  const key = keyOf(sender);
  const info: XTabInfo = {
    tabId: sender.tab!.id!,
    port,
    url: sender.url ?? null,
    loggedIn: null,
    handle: null,
    composerPresent: null,
    onHome: null,
    lastSeenAt: Date.now(),
  };
  tabs.set(key, info);

  port.onMessage.addListener((msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "x_hello" || RESULT_TYPES.has(String(m.type))) {
      info.url = typeof m.href === "string" ? m.href : info.url;
      if (typeof m.loggedIn === "boolean") info.loggedIn = m.loggedIn;
      if (m.accountBlock === null || m.accountBlock === "x_account_requires_attention" || m.accountBlock === "x_rate_limited") info.accountBlock = m.accountBlock as string | null;
      if (typeof m.handle === "string" || m.handle === null) info.handle = (m.handle as string | null) ?? null;
      if (typeof m.composerPresent === "boolean") info.composerPresent = m.composerPresent;
      if (typeof m.onHome === "boolean") info.onHome = m.onHome;
      if (m.notificationCount === null || (typeof m.notificationCount === "number" && Number.isFinite(m.notificationCount) && m.notificationCount >= 0)) info.notificationCount = m.notificationCount === null ? null : Math.min(9999, Math.floor(m.notificationCount as number));
      info.lastSeenAt = Date.now();
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabs.get(key) !== info) return;
    tabs.delete(key);
  });

  port.postMessage({ type: "x_ping" });
  return true;
}

export function stopAllXBrowse(): void {
  navigationGeneration++;
  for (const t of tabs.values()) {
    try {
      t.port.postMessage({ type: "x_stop" });
    } catch {
      // ignore
    }
  }
}

export function pingAllXTabs(): void {
  for (const t of tabs.values()) {
    try {
      t.port.postMessage({ type: "x_ping" });
    } catch {
      // ignore
    }
  }
}

function pickPort(tabId = selectedTabId): XTabInfo | null {
  const list = [...tabs.values()];
  if (tabId != null) return list.find((t) => t.tabId === tabId) ?? null;
  if (!list.length) return null;
  return list.find((t) => t.onHome) || list[0] || null;
}

export type XActionResult = {
  tweetText?: string;
  notificationKind?: "direct" | "post";
  ownerPost?: OwnerPost;
  parentText?: string;
  conversationContext?: string;
  ok: boolean;
  error?: string;
  detail?: string;
  scrolledPx?: number;
  handle?: string | null;
  likeOk?: boolean;
  likeDetail?: string;
  retweetOk?: boolean;
  retweetDetail?: string;
  replyOk?: boolean;
  replyDetail?: string;
  /** Tab Follow scan payloads */
  candidates?: unknown[];
  meta?: unknown;
  /** Tab SMM profile post scan */
  posts?: unknown[];
  /** Home timeline scan */
  tweets?: unknown[];
};

async function requestAction(
  message: object,
  expectType: string,
  timeoutMs = 45_000,
  tabId?: number,
): Promise<XActionResult> {
  if (tabId != null && selectedTabId != null && tabId !== selectedTabId) return { ok: false, error: "x_tab_not_selected" };
  const target = pickPort(tabId);
  if (!target) return { ok: false, error: "no_x_tab" };
  if (selectedTabId == null && tabId == null) selectXTab(target.tabId);
  const { port, handle } = target;
  const requestId = crypto.randomUUID();
  const generation = navigationGeneration;
  const deadlineAt = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: XActionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      port.onMessage.removeListener(onMsg);
      port.onDisconnect.removeListener(onDisconnect);
      resolve(result);
    };
    const onDisconnect = () => finish({ ok: false, error: timedOut ? "timeout" : "port_closed" });
    const timer = setTimeout(() => {
      timedOut = true;
      // Keep listening briefly: cancellation must release the old lock, and a late
      // successful posting result is still authoritative.
      graceTimer = setTimeout(() => {
        if (generation === navigationGeneration && pickPort(target.tabId)?.port === port &&
            Date.now() - (unresponsiveReloadAt.get(target.tabId) ?? -Infinity) >= 300000 &&
            typeof chrome !== "undefined" && typeof chrome.tabs?.reload === "function") {
          unresponsiveReloadAt.set(target.tabId, Date.now());
          try { void chrome.tabs.reload(target.tabId).catch(() => {}); } catch {}
        }
        finish({ ok: false, error: "timeout", detail: "cancel_unconfirmed" });
      }, 2000);
      try { port.postMessage({ type: "x_cancel", targetRequestId: requestId }); }
      catch { finish({ ok: false, error: "timeout" }); }
    }, timeoutMs);

    function onMsg(msg: unknown): void {
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      if (timedOut && m.type === "x_command_released" && m.requestId === requestId) {
        finish({ ok: false, error: "timeout", detail: "command_released" });
        return;
      }
      if (m.type !== expectType || m.requestId !== requestId) return;
      finish({
        ok: m.ok === true,
        error: timedOut && m.error === "stopped" ? "timeout" : typeof m.error === "string" ? m.error : undefined,
        detail: typeof m.detail === "string" ? m.detail : undefined,
        scrolledPx: typeof m.scrolledPx === "number" ? m.scrolledPx : undefined,
        handle: typeof m.handle === "string" ? m.handle : handle,
        likeOk: typeof m.likeOk === "boolean" ? m.likeOk : undefined,
        likeDetail: typeof m.likeDetail === "string" ? m.likeDetail : undefined,
        retweetOk: typeof m.retweetOk === "boolean" ? m.retweetOk : undefined,
        retweetDetail: typeof m.retweetDetail === "string" ? m.retweetDetail : undefined,
        replyOk: typeof m.replyOk === "boolean" ? m.replyOk : undefined,
        replyDetail: typeof m.replyDetail === "string" ? m.replyDetail : undefined,
        candidates: Array.isArray(m.candidates) ? m.candidates : undefined,
        meta: m.meta && typeof m.meta === "object" ? m.meta : undefined,
        posts: Array.isArray(m.posts) ? m.posts : undefined,
        tweets: Array.isArray(m.tweets) ? m.tweets : undefined,
        parentText: typeof m.parentText === "string" ? m.parentText.slice(0, 4000) : undefined,
        ownerPost: sanitizeOwnerPost(m.ownerPost),
        tweetText: typeof m.tweetText === "string" ? m.tweetText.slice(0, 20000) : undefined,
        notificationKind: m.notificationKind === "direct" || m.notificationKind === "post" ? m.notificationKind : undefined,
        conversationContext: typeof m.conversationContext === "string" ? m.conversationContext.slice(0, 6000) : undefined,
      });
    }

    target.port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(onDisconnect);
    try {
      target.port.postMessage({ ...message, requestId, deadlineAt });
    } catch {
      finish({ ok: false, error: "port_closed" });
    }
  });
}

export function requestScrollBurst(opts: {
  distancePx: number;
  steps: number;
  stepDelayMs: number;
  readMs: number;
  restoreNotificationPosition?: boolean;
  browseSurface?: string;
  listUrl?: string | null;
}): Promise<XActionResult> {
  // Content trả lời ngay sau burst (không chờ readMs). Timeout đủ rộng cho SW sleep.
  const budget = 30_000 + opts.steps * opts.stepDelayMs;
  return requestAction({ type: "x_scroll_burst", ...opts }, "x_scroll_result", Math.min(45_000, budget));
}

export function requestTimelineScan(opts?: {
  browseSurface?: string;
  listUrl?: string | null;
  ownHandle?: string | null;
  notificationTab?: "mentions" | "all";
  notificationScroll?: boolean;
}): Promise<XActionResult> {
  return requestAction(
    { type: "x_timeline_scan", browseSurface: opts?.browseSurface ?? "home", listUrl: opts?.listUrl ?? null, ownHandle: opts?.ownHandle,
      notificationTab: opts?.notificationTab, notificationScroll: opts?.notificationScroll },
    "x_timeline_scan_result",
    20_000,
  );
}

export function requestPrepareTweet(opts: {
  listUrl?: string | null;
  tweetId: string | null;
  tweetUrl: string | null;
  readMsMin: number;
  readMsMax: number;
  /** Browse: bắt buộc mở trang status (click vào bài), không đọc/like trên feed. */
  forceOpen?: boolean;
  mentionContext?: boolean;
}): Promise<XActionResult> {
  return requestAction({ type: "x_prepare_tweet", ...opts }, "x_prepare_tweet_result", 90_000);
}

export function requestBackToBrowse(opts: { browseSurface: string; listUrl?: string; tweetId: string; followedProfile?: string }): Promise<XActionResult> {
  return requestAction({ type: "x_back_to_browse", ...opts }, "x_back_to_browse_result", 20000);
}

export function requestLike(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
  onFeed?: boolean;
}): Promise<XActionResult> {
  return requestAction({ type: "x_like", ...opts }, "x_like_result");
}

export function requestRetweet(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
}): Promise<XActionResult> {
  return requestAction({ type: "x_retweet", ...opts }, "x_retweet_result", 25_000);
}

/** Like + RT + reply trên cùng 1 lần mở tweet. */
export function requestTweetEngage(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
  doLike: boolean;
  doRetweet: boolean;
  replyText?: string | null;
}): Promise<XActionResult> {
  return requestAction({ type: "x_tweet_engage", ...opts }, "x_tweet_engage_result", 90_000);
}

export function requestReply(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
  text: string;
  ownHandle?: string | null;
}): Promise<XActionResult> {
  return requestAction({ type: "x_reply", ...opts }, "x_reply_result", 60_000);
}

export function requestQuote(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
  text: string;
}): Promise<XActionResult> {
  return requestAction({ type: "x_quote", ...opts }, "x_quote_result", 60_000);
}

export async function requestFollow(opts: {
  authorHandle: string | null;
  tweetUrl: string | null;
  tweetId?: string | null;
  preferInline?: boolean;
}): Promise<XActionResult> {
  const account = getXConnection().handle || "";
  const generation = navigationGeneration;
  let result = await requestAction({ type: "x_follow", ...opts }, "x_follow_result", 25_000);
  if (result.error === "need_navigate_profile" && opts.authorHandle) {
    const prepared = await inspectFollowProfile(opts.authorHandle, () => generation !== navigationGeneration);
    if (!prepared.ok) return prepared;
    if (generation !== navigationGeneration) return { ok: false, error: "stopped" };
    result = await requestAction({ type: "x_follow", ...opts }, "x_follow_result", 25_000);
  }
  if (opts.authorHandle && result.ok && ["follow_confirmed", "already_following", "follow_requested"].includes(result.detail ?? ""))
    await rememberFollow(account, opts.authorHandle, true, { status: result.detail === "follow_requested" ? "requested" : "following" });
  return result;
}

export function requestLatestProfilePost(handle: string): Promise<XActionResult> {
  return requestAction({ type: "x_latest_profile_post", authorHandle: handle }, "x_latest_profile_post_result", 15000);
}

export function requestFollowScanCells(seen: string[] = []): Promise<XActionResult> {
  return requestAction({ type: "x_follow_scan_cells", seen }, "x_follow_scan_result", 15_000);
}

export async function requestFollowProfileMeta(handle?: string | null, timeoutMs = 15000): Promise<XActionResult> {
  const account = getXConnection().handle || "";
  const result = await requestAction(
    { type: "x_follow_profile_meta", authorHandle: handle ?? null },
    "x_follow_profile_meta_result",
    timeoutMs,
  );
  const meta = result.meta as { onProfile?: boolean; alreadyFollowing?: boolean; verified?: boolean; followsYou?: boolean | null } | undefined;
  if (handle && result.ok && meta?.onProfile === true && meta.alreadyFollowing === true)
    await rememberFollow(account || getXConnection().handle || "", handle, true, { status: "following", verified: meta.verified, followsYou: meta.followsYou });
  return result;
}

export async function inspectFollowProfile(handle: string, cancelled: () => boolean = () => false, wait: (ms: number) => Promise<void> = sleepMs): Promise<XActionResult> {
  const generation = navigationGeneration;
  const stopped = () => cancelled() || generation !== navigationGeneration;
  if (stopped()) return { ok: false, error: "stopped" };
  if (await xPageRetryDelay() > 0) return { ok: false, error: "x_page_cooling_down" };
  const result = await waitForFollowProfile(handle, {
    read: timeoutMs => requestFollowProfileMeta(handle, timeoutMs),
    navigate: url => navigateXTab(url, stopped), wait, cancelled: stopped,
  });
  if (!stopped()) await noteXPageReady(result.ok || ["profile_unavailable", "profile_suspended", "profile_restricted"].includes(result.error ?? ""));
  return result;
}

export async function requestFollowInCell(handle: string): Promise<XActionResult> {
  const account = getXConnection().handle || "";
  const result = await requestAction(
    { type: "x_follow_cell", authorHandle: handle },
    "x_follow_cell_result",
    20_000,
  );
  if (result.ok && ["follow_confirmed", "already_following", "follow_requested"].includes(result.detail ?? ""))
    await rememberFollow(account, handle, true, { status: result.detail === "follow_requested" ? "requested" : "following" });
  return result;
}

export function requestFollowScrollList(steps = 3): Promise<XActionResult> {
  return requestAction(
    { type: "x_follow_scroll_list", steps },
    "x_follow_scroll_list_result",
    20_000,
  );
}

export async function requestUnfollowInCell(handle: string): Promise<XActionResult> {
  const account = getXConnection().handle || "";
  const result = await requestAction(
    { type: "x_unfollow_cell", authorHandle: handle },
    "x_unfollow_cell_result",
    20_000,
  );
  if (result.ok && ["unfollow_confirmed", "already_not_following"].includes(result.detail ?? "")) await rememberFollow(account, handle, false);
  return result;
}

export async function requestUnfollowProfile(handle: string): Promise<XActionResult> {
  const account = getXConnection().handle || "";
  const result = await requestAction(
    { type: "x_unfollow", authorHandle: handle },
    "x_unfollow_result",
    25_000,
  );
  if (result.ok && ["unfollow_confirmed", "already_not_following"].includes(result.detail ?? "")) await rememberFollow(account, handle, false);
  return result;
}

/** Tab SMM — thu thập bài đang hiện trên profile. */
export function requestPostScanCollect(opts: {
  username: string;
  thresholds: { views: number; likes: number; reposts: number; replies: number };
  targetCount: number;
  knownIds?: string[];
  tabId?: number;
}): Promise<XActionResult> {
  return requestAction(
    { type: "x_post_scan_collect", ...opts },
    "x_post_scan_collect_result",
    20_000,
    opts.tabId,
  );
}

export function requestPostScanScroll(distancePx?: number, tabId?: number): Promise<XActionResult> {
  return requestAction(
    { type: "x_post_scan_scroll", distancePx },
    "x_post_scan_scroll_result",
    15_000,
    tabId,
  );
}

function waitTabComplete(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    function onUpdated(id: number, info: chrome.tabs.TabChangeInfo): void {
      if (id === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === "complete") done();
    });
  });
}

/** Navigate the connected X tab (or create one). Waits until load completes. */
export async function navigateXTab(
  url: string,
  cancelled: () => boolean = () => false,
): Promise<{ ok: boolean; error?: string; tabId?: number }> {
  const generation = navigationGeneration;
  const result = navigationTail.then(() => navigateXTabOwned(url, () => cancelled() || generation !== navigationGeneration));
  navigationTail = result.catch(() => {});
  return result;
}

async function navigateXTabOwned(url: string, cancelled: () => boolean): Promise<{ ok: boolean; error?: string; tabId?: number }> {
  try {
    if (cancelled()) return { ok: false, error: "stopped" };
    const existing = await chrome.tabs.query({
      url: ["https://x.com/*", "https://twitter.com/*"],
    });
    let tabId: number | undefined;
    const chosen = existing.find((tab) => tab.id === selectedTabId) ?? existing[0];
    if (cancelled()) return { ok: false, error: "stopped" };
    if (chosen?.id != null) {
      tabId = chosen.id;
      selectXTab(tabId);
      if (chosen.url?.replace(/\/$/, "") === url.replace(/\/$/, "")) return { ok: true, tabId };
      if (pickPort(tabId)) {
        const internal = await requestAction({ type: "x_navigate_link", url }, "x_navigate_link_result", 5000, tabId);
        if (cancelled()) return { ok: false, error: "stopped" };
        if (internal.ok) {
          await sleepMs(900);
          return cancelled() ? { ok: false, error: "stopped", tabId } : { ok: true, tabId };
        }
        if (internal.error !== "navigation_link_missing") return { ok: false, error: internal.error || "navigation_failed", tabId };
      }
      await chrome.tabs.update(tabId, { active: true, url });
      if (chosen.windowId != null) {
        try {
          await chrome.windows.update(chosen.windowId, { focused: true });
        } catch {
          /* ignore */
        }
      }
    } else {
      const created = await chrome.tabs.create({ url, active: true });
      tabId = created.id;
      if (tabId != null) selectXTab(tabId);
    }
    if (tabId != null) await waitTabComplete(tabId);
    // Cho content script kịp connect port.
    await sleepMs(900);
    return { ok: true, tabId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Đợi tab X có port (content script). */
export async function waitForXConnection(
  timeoutMs = 12_000,
  tabId?: number,
): Promise<{ ok: boolean; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pickPort(tabId)) return { ok: true };
    await sleepMs(400);
  }
  return { ok: false, error: "no_x_tab" };
}

/**
 * Tab X còn mở nhưng Map port trong SW trống (sau ngủ MV3 / reload).
 * Nudge content script; nếu script đã chết thì inject lại.
 */
export async function ensureXTabsConnected(timeoutMs = 6000): Promise<{ ok: boolean; openTabs: number; error?: string }> {
  if (pickPort()) return { ok: true, openTabs: tabs.size };
  pingAllXTabs();
  let openTabs: chrome.tabs.Tab[] = [];
  try {
    openTabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  } catch {
    return { ok: false, openTabs: 0, error: "tabs_query_failed" };
  }
  if (openTabs.length === 0) return { ok: false, openTabs: 0, error: "no_x_tab" };

  for (const tab of openTabs) {
    if (tab.id == null) continue;
    let nudged = false;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "x_ensure_port" });
      nudged = true;
    } catch {
      nudged = false;
    }
    if (!nudged) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/x-content.js"],
        });
      } catch {
        /* tab may be chrome:// or restricted */
      }
    }
  }

  const ready = await waitForXConnection(timeoutMs);
  return { ok: ready.ok, openTabs: openTabs.length, error: ready.ok ? undefined : "x_tab_disconnected" };
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
