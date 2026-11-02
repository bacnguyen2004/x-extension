import { detectXIdentity, pathIsHome } from "../x/identity.ts";
import { detectXPlatformBlock } from "../x/platform-block.ts";
import { goHomeNaturally, homeNavError } from "../x/home-nav.ts";
import {
  browseNavError,
  ensureBrowseSurface,
  type BrowseNavKind,
} from "../x/browse-nav.ts";
import {
  acquireFeedNavigationLock,
  releaseFeedNavigationLock,
  isFeedNavigationLocked,
} from "../x/feed-navigator.ts";
import type { BrowseSurface } from "../domain/agent-settings.ts";
import { readTweet } from "../x/reading.ts";
import { ActionDeadlineError, ActionStoppedError, actionSignal, beginAction, stopActions, isActionStopped } from "../x/action-control.ts";
import { pickScrollRoot, pickScrollRoots, runScrollBurst } from "../x/scroll.ts";
import { click, findTweetArticle, qsa, sleep, waitFor } from "../x/dom-utils.ts";
import { confirmOwnReply, readReplyAttempt } from "../x/reply-history.ts";
import { backToBrowse } from "../x/back-to-browse.ts";
import {
  engageTweetOnce,
  followAuthor,
  hasOwnReplyToTweet,
  likeVisibleOrTweet,
  quoteTweet,
  replyTweet,
  retweetTweet,
  unfollowAuthor,
} from "../x/actions/engage.ts";
import {
  followInUserCell,
  readFollowProfileMeta,
  scanFollowUserCells,
  scrollFollowersList,
  unfollowInUserCell,
} from "./x-follow-scan.ts";
import {
  collectVisibleProfilePosts,
  scrollProfileBurst,
  type PostScanThresholds,
  type ScannedPostPayload,
} from "./x-post-scan.ts";
import { collectVisibleTimelineTweets, collectVisibleMentionTweets, readConversationContext } from "../x/timeline.ts";
import type { OwnerPost } from "../domain/reply-conversation.ts";
import { readNotificationBadge } from "../x/notification-badge.ts";
import { collectNotificationTweets } from "../x/notification-feed.ts";
import { readTweetArticle, isDirectMention } from "../x/timeline.ts";
import { findXNavigationLink } from "../x/navigation.ts";
import { pauseAfterPageChange } from "../x/page-pause.ts";
import { armAutoLeave, clearAutoLeave } from "../x/auto-leave.ts";
import { dismissDraftConfirmation } from "../x/draft-confirmation.ts";
import { latestProfilePost } from "../x/latest-profile-post.ts";
import { rememberNotificationPosition, restoreNotificationPosition, notificationNavigationBlocked } from "../x/notification-position.ts";
import { readFeedState, waitForFeedReady, nextFeedRecovery, type FeedState, type FeedRecoveryState } from "../x/feed-state.ts";

const BROWSE_SURFACES = new Set<BrowseSurface>(["home", "following", "lists", "mentions"]);
let pendingFeed: { doc: Document; key: string; before: string; at: number } | null = null;
const recoveryByDocument = new WeakMap<Document, Map<string, FeedRecoveryState>>();
const feedKey = (surface: BrowseSurface, listUrl?: string | null) => `${surface}:${surface === "lists" ? listUrl ?? "" : ""}`;

async function readyFeed(surface: BrowseSurface, listUrl?: string | null) {
  const key = feedKey(surface, listUrl);
  const pending = pendingFeed?.doc === document && pendingFeed.key === key ? pendingFeed : null;
  const result = await waitForFeedReady(() => readFeedState(document, location.pathname, surface, listUrl), sleep,
    { before: pending?.before });
  if (result.ready && pendingFeed === pending) pendingFeed = null;
  return result;
}

async function stalledFeed(port: XPort | null, type: string, surface: BrowseSurface, listUrl: string | null, state: FeedState): Promise<void> {
  const key = feedKey(surface, listUrl);
  let records = recoveryByDocument.get(document);
  if (!records) { records = new Map(); recoveryByDocument.set(document, records); }
  let stored: FeedRecoveryState = records.get(key) ?? { failures: 0, reloadAt: 0 };
  try { stored = { ...stored, reloadAt: Math.max(stored.reloadAt, Number(sessionStorage.getItem(`xcc.feedReload:${key}`)) || 0) }; } catch {}
  const recovery = nextFeedRecovery(stored, Date.now());
  records.set(key, recovery.state);
  if (isActionStopped()) throw new ActionStoppedError();
  if (recovery.action === "top" && state.surfaceReady) {
    for (const root of pickScrollRoots(document, window)) {
      if (isActionStopped()) throw new ActionStoppedError();
      const position = root.scrollY ?? root.scrollTop ?? 0;
      if (position > 0) { root.scrollBy({ top: -position, behavior: "auto" }); await sleep(200); }
    }
    pendingFeed = null;
    replyResult(port, type, { ok: false, error: "feed_recovery_top" });
    return;
  }
  if (recovery.action === "reload") {
    // Persist the reload limit across full page loads; otherwise defer the source.
    try { sessionStorage.setItem(`xcc.feedReload:${key}`, String(recovery.state.reloadAt)); }
    catch { replyResult(port, type, { ok: false, error: "feed_recovery_cooldown" }); return; }
    replyResult(port, type, { ok: false, error: "feed_recovery_reload" });
    const signal = actionSignal();
    setTimeout(() => { if (!signal.aborted && actionSignal() === signal && !isActionStopped()) location.reload(); }, 60);
    return;
  }
  const error = recovery.action === "cooldown" ? "feed_recovery_cooldown"
    : !state.surfaceReady ? "feed_surface_wait" : state.loading && !state.fingerprint ? "feed_loading"
    : state.atBottom || state.empty ? "feed_end_loaded" : "scroll_no_progress";
  replyResult(port, type, { ok: false, error });
}

function parseBrowseSurface(raw: unknown): BrowseSurface {
  return typeof raw === "string" && BROWSE_SURFACES.has(raw as BrowseSurface)
    ? (raw as BrowseSurface)
    : "home";
}

function navigateForBrowseSurface(
  surface: BrowseSurface,
  listUrl?: string | null,
  force = true,
  notificationTab?: "mentions" | "all",
): { kind: BrowseNavKind; error?: string; detail?: string; overrideSurface?: Exclude<BrowseSurface, "mentions"> } {
  const key = feedKey(surface, listUrl);
  if (pendingFeed?.doc === document && pendingFeed.key === key && Date.now() - pendingFeed.at < 30000) {
    return { kind: "already" };
  }
  if (isFeedNavigationLocked()) {
    return { kind: "already", error: "navigation_locked", detail: "busy" };
  }
  if (!acquireFeedNavigationLock()) {
    return { kind: "already", error: "navigation_locked", detail: "busy" };
  }
  try {
    if (!force && surface !== "mentions") {
      const pathname = location.pathname;
      if (pathIsHome(pathname) && (surface === "home" || surface === "following")) {
        const following = findTimelineTabSelected("following");
        const forYou = findTimelineTabSelected("home");
        const onPage: Exclude<BrowseSurface, "mentions"> | null =
          following ? "following" : forYou ? "home" : null;
        if (onPage && onPage !== surface) {
          return { kind: "already", detail: "user_override", overrideSurface: onPage };
        }
      }
    }
    const before = readFeedState(document, location.pathname, surface, listUrl).fingerprint;
    const kind = ensureBrowseSurface({ surface, listUrl: listUrl ?? null, notificationTab });
    if (kind === "already") return { kind };
    pendingFeed = { doc: document, key, before, at: Date.now() };
    const errKind: Exclude<BrowseNavKind, "already"> =
      kind === "back" ? "back" : kind === "reload" ? "reload" : kind === "link" || kind === "tab" ? kind : "reload";
    return {
      kind,
      error: browseNavError(surface, errKind === "tab" || errKind === "link" ? "link" : errKind),
      detail: kind,
    };
  } finally {
    // TTL trên lock; sẵn sàng cho lệnh xác nhận feed tiếp theo.
    releaseFeedNavigationLock();
  }
}

function findTimelineTabSelected(surface: "home" | "following"): boolean {
  const re = surface === "home" ? /^(for you|dành cho bạn)$/i : /^(following|đang theo dõi)$/i;
  const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector("main[role='main']") ?? document;
  for (const tab of root.querySelectorAll<HTMLElement>('[role="tab"]')) {
    const label = (tab.getAttribute("aria-label") || tab.textContent || "").replace(/\s+/g, " ").trim();
    if (!re.test(label)) continue;
    return tab.getAttribute("aria-selected") === "true" || tab.getAttribute("data-selected") === "true";
  }
  return false;
}

export type XPort = { postMessage(msg: object): void };

let busy = false;
let activeCommand: { id: unknown; type: string; startedAt: number; deadlineAt: number } | null = null;
export function setStopped(v: boolean): void {
  if (v) stopActions();
  else beginAction();
}

export function snapshot() {
  const id = detectXIdentity(document, location.pathname);
  return {
    type: "x_hello" as const,
    href: location.href,
    accountBlock: detectXPlatformBlock(document, location.pathname),
    // Luôn true — không nhận diện / chặn login; user tự đăng nhập.
    loggedIn: true,
    handle: id.handle,
    composerPresent: id.composerPresent,
    onHome: id.onHome,
    notificationCount: readNotificationBadge(document),
    at: Date.now(),
  };
}

function replyResult(
  port: XPort | null,
  type: string,
  result: {
    ok: boolean;
    error?: string;
    detail?: string;
    scrolledPx?: number;
    tweets?: unknown[];
    parentText?: string;
    ownerPost?: OwnerPost;
    tweetText?: string;
    notificationKind?: "direct" | "post";
    conversationContext?: string;
  },
): void {
  const snap = snapshot();
  port?.postMessage({
    ...snap,
    type,
    ok: result.ok,
    error: result.error,
    detail: result.detail,
    scrolledPx: result.scrolledPx,
    tweets: result.tweets,
    parentText: result.parentText,
    ownerPost: result.ownerPost,
    tweetText: result.tweetText,
    notificationKind: result.notificationKind,
    conversationContext: result.conversationContext,
    at: Date.now(),
  });
}

export async function handleXCommand(rawPort: XPort | null, msg: unknown): Promise<void> {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  // Capture the ID per command, including the immediate busy response.
  const port: XPort | null = rawPort ? {
    postMessage(result) {
      rawPort.postMessage({ ...result, requestId: m.requestId });
    },
  } : null;

  if (m.type === "x_ping") {
    port?.postMessage(snapshot());
    return;
  }
  if (m.type === "x_stop") {
    stopActions();
    clearAutoLeave();
    port?.postMessage({ type: "x_stopped", at: Date.now() });
    return;
  }
  if (m.type === "x_cancel") {
    if (activeCommand && m.targetRequestId === activeCommand.id) stopActions();
    return;
  }

  if (
    m.type === "x_navigate_link" ||
    m.type === "x_prepare_tweet" ||
    m.type === "x_back_to_browse" ||
    m.type === "x_scroll_burst" ||
    m.type === "x_like" ||
    m.type === "x_retweet" ||
    m.type === "x_tweet_engage" ||
    m.type === "x_reply" ||
    m.type === "x_quote" ||
    m.type === "x_follow" ||
    m.type === "x_follow_scan_cells" ||
    m.type === "x_follow_profile_meta" ||
    m.type === "x_latest_profile_post" ||
    m.type === "x_follow_cell" ||
    m.type === "x_follow_scroll_list" ||
    m.type === "x_unfollow_cell" ||
    m.type === "x_unfollow" ||
    m.type === "x_post_scan_collect" ||
    m.type === "x_post_scan_scroll" ||
    m.type === "x_timeline_scan"
  ) {
    const blocked = detectXPlatformBlock(document, location.pathname);
    if (blocked) {
      replyResult(port, resultType(m.type), { ok: false, error: blocked });
      return;
    }
    if (busy) {
      if (activeCommand && Date.now() >= activeCommand.deadlineAt) stopActions();
      replyResult(port, resultType(m.type), { ok: false, error: "busy",
        detail: activeCommand ? `${activeCommand.type}: ${Math.max(0, Math.floor((Date.now() - activeCommand.startedAt) / 1000))}s` : "unknown_command" });
      return;
    }
    const now = Date.now();
    const deadlineAt = typeof m.deadlineAt === "number" && Number.isFinite(m.deadlineAt)
      ? Math.min(m.deadlineAt, now + 120000) : now + 90000;
    if (deadlineAt <= now) { replyResult(port, resultType(m.type), { ok: false, error: "timeout" }); return; }
    busy = true;
    activeCommand = { id: m.requestId, type: String(m.type), startedAt: now, deadlineAt };
    beginAction(deadlineAt);
    armAutoLeave(deadlineAt);
    const watchdog = setTimeout(stopActions, deadlineAt - now);
    try {
      dismissDraftConfirmation(document);
      if (m.type !== "x_navigate_link" && m.type !== "x_back_to_browse") await pauseAfterPageChange();
      if (m.type === "x_navigate_link") {
        const link = typeof m.url === "string" ? findXNavigationLink(document, m.url, location.href) : null;
        replyResult(port, "x_navigate_link_result", { ok: !!link, ...(link ? {} : { error: "navigation_link_missing" }) });
        if (link) { await new Promise(resolve => setTimeout(resolve, 60)); if (!isActionStopped()) link.click(); }
      }
      else if (m.type === "x_prepare_tweet") await runPrepareTweet(port, m);
      else if (m.type === "x_back_to_browse") replyResult(port, "x_back_to_browse_result", await backToBrowse({ surface: parseBrowseSurface(m.browseSurface), tweetId: strOrNull(m.tweetId) || "", listUrl: strOrNull(m.listUrl), followedProfile: strOrNull(m.followedProfile) || undefined }));
      else if (m.type === "x_scroll_burst") await runScroll(port, m);
      else if (m.type === "x_like") await runLike(port, m);
      else if (m.type === "x_retweet") await runRetweet(port, m);
      else if (m.type === "x_tweet_engage") await runTweetEngage(port, m);
      else if (m.type === "x_reply") await runReply(port, m);
      else if (m.type === "x_quote") await runQuote(port, m);
      else if (m.type === "x_follow") await runFollow(port, m);
      else if (m.type === "x_follow_scan_cells") await runFollowScan(port, m);
      else if (m.type === "x_follow_profile_meta") await runFollowProfileMeta(port, m);
      else if (m.type === "x_latest_profile_post") {
        const handle = String(m.authorHandle || "").replace(/^@/, "");
        if (!/^[a-z0-9_]{1,15}$/i.test(handle) || location.pathname.replace(/\/$/, "").toLowerCase() !== `/${handle.toLowerCase()}`) {
          replyResult(port, "x_latest_profile_post_result", { ok: false, error: "profile_mismatch" });
        } else {
          const found = await waitFor(() => latestProfilePost(document, handle), 6000);
          if (found) await sleep(500);
          const latest = latestProfilePost(document, handle);
          replyResult(port, "x_latest_profile_post_result", { ok: !!latest, tweets: latest ? [latest] : [], ...(latest ? {} : { error: "profile_has_no_posts" }) });
        }
      }
      else if (m.type === "x_follow_cell") await runFollowCell(port, m);
      else if (m.type === "x_follow_scroll_list") await runFollowScrollList(port, m);
      else if (m.type === "x_unfollow_cell") await runUnfollowCell(port, m);
      else if (m.type === "x_unfollow") await runUnfollow(port, m);
      else if (m.type === "x_post_scan_collect") await runPostScanCollect(port, m);
      else if (m.type === "x_post_scan_scroll") await runPostScanScroll(port, m);
      else if (m.type === "x_timeline_scan") await runTimelineScan(port, m);
    } catch (error) {
      replyResult(port, resultType(m.type), {
        ok: false,
        error: error instanceof ActionDeadlineError || Date.now() >= deadlineAt ? "timeout"
          : error instanceof ActionStoppedError ? "stopped" : "action_failed",
      });
    } finally {
      clearTimeout(watchdog);
      busy = false;
      activeCommand = null;
      port?.postMessage({ type: "x_command_released" });
    }
  }
}

function resultType(cmd: unknown): string {
  if (cmd === "x_back_to_browse") return "x_back_to_browse_result";
  if (cmd === "x_navigate_link") return "x_navigate_link_result";
  if (cmd === "x_prepare_tweet") return "x_prepare_tweet_result";
  if (cmd === "x_scroll_burst") return "x_scroll_result";
  if (cmd === "x_like") return "x_like_result";
  if (cmd === "x_retweet") return "x_retweet_result";
  if (cmd === "x_tweet_engage") return "x_tweet_engage_result";
  if (cmd === "x_reply") return "x_reply_result";
  if (cmd === "x_quote") return "x_quote_result";
  if (cmd === "x_follow") return "x_follow_result";
  if (cmd === "x_follow_scan_cells") return "x_follow_scan_result";
  if (cmd === "x_follow_profile_meta") return "x_follow_profile_meta_result";
  if (cmd === "x_latest_profile_post") return "x_latest_profile_post_result";
  if (cmd === "x_follow_cell") return "x_follow_cell_result";
  if (cmd === "x_follow_scroll_list") return "x_follow_scroll_list_result";
  if (cmd === "x_unfollow_cell") return "x_unfollow_cell_result";
  if (cmd === "x_unfollow") return "x_unfollow_result";
  if (cmd === "x_post_scan_collect") return "x_post_scan_collect_result";
  if (cmd === "x_post_scan_scroll") return "x_post_scan_scroll_result";
  if (cmd === "x_timeline_scan") return "x_timeline_scan_result";
  return "x_action_result";
}

async function runTimelineScan(port: XPort | null, m: Record<string, unknown> = {}): Promise<void> {
  const surface = parseBrowseSurface(m.browseSurface);
  if (surface === "mentions" && notificationNavigationBlocked(document)) {
    replyResult(port, "x_timeline_scan_result", { ok: false, error: "notification_composer_open" }); return;
  }
  const listUrl = typeof m.listUrl === "string" ? m.listUrl : null;
  if (surface === "mentions") rememberNotificationPosition(snapshot().handle || strOrNull(m.ownHandle) || "");
  const tab = m.notificationTab === "mentions" ? "mentions" : "all";
  // A previous tab's pending fingerprint must not authorize reading the wrong tab.
  if (surface === "mentions" && pendingFeed && !location.pathname.endsWith(tab === "mentions" ? "/notifications/mentions" : "/notifications")) pendingFeed = null;
  const nav = navigateForBrowseSurface(surface, listUrl, true, tab);
  if (nav.kind !== "already") {
    replyResult(port, "x_timeline_scan_result", {
      ok: false,
      error: nav.error ?? browseNavError(surface, "reload"),
      detail: nav.detail ?? nav.kind,
    });
    return;
  }
  const ready = await readyFeed(surface, listUrl);
  if (!ready.ready) { await stalledFeed(port, "x_timeline_scan_result", surface, listUrl, ready.state); return; }
  if (surface === "mentions" && m.notificationScroll === true) {
    const root = pickScrollRoot(document, window) || window;
    await runScrollBurst(root, { distancePx: 650, steps: 2, stepDelayMs: 150 }, sleep, pickScrollRoots(document, window), isActionStopped);
    await sleep(400);
  }
  const tweets = surface === "mentions" ? collectNotificationTweets(document, snapshot().handle || strOrNull(m.ownHandle) || "", 30) : collectVisibleTimelineTweets(document, 12);
  replyResult(port, "x_timeline_scan_result", {
    ok: true,
    detail: `scanned_${tweets.length}`,
    tweets,
  });
}

/** Click link thời gian / status trong article — tự nhiên hơn location.assign. */
function tryClickStatusLink(tweetId: string): boolean {
  const article = findTweetArticle(tweetId);
  if (!article) return false;
  const links = qsa<HTMLAnchorElement>(`a[href*="/status/${tweetId}"]`, article).filter((a) => {
    const href = a.getAttribute("href") || a.href || "";
    return href.includes(`/status/${tweetId}`) && !href.includes("/analytics");
  });
  const preferred =
    links.find((a) => a.querySelector("time")) ||
    links.find((a) => /\/status\/\d+$/.test((a.getAttribute("href") || "").split("?")[0] || "")) ||
    links[0];
  return preferred ? click(preferred) : false;
}

function onTweetStatusPage(tweetId: string | null): boolean {
  if (!tweetId) return false;
  return location.pathname.includes(`/status/${tweetId}`);
}

async function runPrepareTweet(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const tweetId = strOrNull(m.tweetId);
  const tweetUrl = strOrNull(m.tweetUrl);
  const forceOpen = m.forceOpen === true;
  const validUrl = tweetUrl ? (() => { try { return new URL(tweetUrl); } catch { return null; } })() : null;
  const canNavigate =
    !!tweetId &&
    !!validUrl &&
    ["https://x.com", "https://twitter.com"].includes(validUrl.origin) &&
    validUrl.pathname.endsWith(`/status/${tweetId}`);

  // Browse / forceOpen: luôn mở trang status (click bài) trước khi đọc — không like trên feed.
  if (forceOpen && tweetId && canNavigate && !onTweetStatusPage(tweetId)) {
    if (tryClickStatusLink(tweetId)) {
      replyResult(port, "x_prepare_tweet_result", {
        ok: false,
        error: "navigating_tweet",
        detail: tweetUrl!,
      });
      return;
    }
    await finishAction(port, "x_prepare_tweet_result", {
      ok: false,
      error: "need_navigate_tweet",
      detail: tweetUrl!,
    });
    return;
  }

  // Đã ở status (hoặc Pogo cho phép đọc trên timeline nếu article đang hiện).
  if (tweetId && await readTweet(tweetId, num(m.readMsMin, 8000), num(m.readMsMax, 18000))) {
    // forceOpen mà vẫn chỉ thấy article trên Home → ép mở status.
    if (forceOpen && !onTweetStatusPage(tweetId) && canNavigate) {
      if (tryClickStatusLink(tweetId)) {
        replyResult(port, "x_prepare_tweet_result", {
          ok: false,
          error: "navigating_tweet",
          detail: tweetUrl!,
        });
        return;
      }
      await finishAction(port, "x_prepare_tweet_result", {
        ok: false,
        error: "need_navigate_tweet",
        detail: tweetUrl!,
      });
      return;
    }
    const own = snapshot().handle;
    const article = findTweetArticle(tweetId);
    if (own && hasOwnReplyToTweet(tweetId, own)) {
      await confirmOwnReply(tweetId, own);
      replyResult(port, "x_prepare_tweet_result", { ok: true, detail: "already_replied" });
      return;
    }
    const evidence = own ? await readReplyAttempt(tweetId, own) : null;
    if (evidence) {
      replyResult(port, "x_prepare_tweet_result", { ok: true, detail: evidence.state === "confirmed" ? "already_replied" : "reply_attempt_exists" });
      return;
    }
    replyResult(port, "x_prepare_tweet_result", {
      ok: true,
      detail: onTweetStatusPage(tweetId) ? "read_status" : "read_timeline",
      tweetText: article ? readTweetArticle(article)?.text || "" : "",
      ...(m.mentionContext === true ? { notificationKind: article && isDirectMention(article, own || "") ? "direct" as const : "post" as const } : {}),
      ...(m.mentionContext === true && /^\/[A-Za-z0-9_]+\/status\/\d+(?:\/|$)/.test(location.pathname) ? readConversationContext(document, tweetId, own || "") : {}),
    });
    return;
  }

  if (canNavigate && !onTweetStatusPage(tweetId)) {
    if (forceOpen && tryClickStatusLink(tweetId!)) {
      replyResult(port, "x_prepare_tweet_result", {
        ok: false,
        error: "navigating_tweet",
        detail: tweetUrl!,
      });
      return;
    }
    await finishAction(port, "x_prepare_tweet_result", {
      ok: false,
      error: "need_navigate_tweet",
      detail: tweetUrl!,
    });
    return;
  }
  replyResult(port, "x_prepare_tweet_result", { ok: false, error: "tweet_not_found" });
}

async function runScroll(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  if (m.restoreNotificationPosition === true && notificationNavigationBlocked(document)) {
    replyResult(port, "x_scroll_result", { ok: false, error: "notification_composer_open" }); return;
  }
  const surface = parseBrowseSurface(m.browseSurface);
  const listUrl = typeof m.listUrl === "string" ? m.listUrl : null;
  // Backward compat: không truyền surface → giữ hành vi về Home như cũ.
  if (m.browseSurface == null && !pathIsHome(location.pathname)) {
    const kind = goHomeNaturally();
    if (kind !== "already") {
      replyResult(port, "x_scroll_result", {
        ok: false,
        error: homeNavError(kind),
        detail: kind === "back" ? "history_back" : "reload_home",
      });
      return;
    }
  } else if (m.browseSurface != null) {
    const nav = navigateForBrowseSurface(surface, listUrl);
    if (nav.kind !== "already") {
      replyResult(port, "x_scroll_result", {
        ok: false,
        error: nav.error ?? browseNavError(surface, "reload"),
        detail: nav.detail ?? nav.kind,
      });
      return;
    }
  }
  const ready = await readyFeed(surface, listUrl);
  if (!ready.ready) { await stalledFeed(port, "x_scroll_result", surface, listUrl, ready.state); return; }
  if (m.restoreNotificationPosition === true) {
    restoreNotificationPosition(snapshot().handle || "", surface);
    replyResult(port, "x_scroll_result", { ok: true, detail: "notification_feed_restored" });
    return;
  }
  const beforeScroll = ready.state;
  const winTarget = window as unknown as { scrollBy: typeof window.scrollBy };
  const roots = pickScrollRoots(document, winTarget);
  const root = pickScrollRoot(document, winTarget) || winTarget;
  const distancePx = num(m.distancePx, 900);
  const steps = Math.min(6, Math.max(1, num(m.steps, 3)));
  // Giữ burst ngắn — trả lời port ngay, không chờ readMs (read do agent delay).
  const stepDelayMs = Math.min(500, Math.max(80, num(m.stepDelayMs, 250)));
  const scrolled = await runScrollBurst(
    root,
    { distancePx, steps, stepDelayMs },
    sleep,
    roots,
    isActionStopped,
  );
  if (isActionStopped()) {
    replyResult(port, "x_scroll_result", { ok: false, error: "stopped" });
    return;
  }
  if (scrolled === 0) {
    const deadline = Date.now() + 2000;
    for (let elapsed = 0; elapsed < 2000; elapsed += 200) {
      if (Date.now() >= deadline) break;
      const after = readFeedState(document, location.pathname, surface, listUrl);
      if (after.surfaceReady && (after.fingerprint !== beforeScroll.fingerprint || after.height > beforeScroll.height)) {
        const record = recoveryByDocument.get(document)?.get(feedKey(surface, listUrl));
        if (record) record.failures = 0;
        replyResult(port, "x_scroll_result", { ok: false, error: "feed_content_changed" }); return;
      }
      await sleep(200);
    }
    await stalledFeed(port, "x_scroll_result", surface, listUrl, readFeedState(document, location.pathname, surface, listUrl));
    return;
  }
  const record = recoveryByDocument.get(document)?.get(feedKey(surface, listUrl));
  if (record) record.failures = 0;
  replyResult(port, "x_scroll_result", { ok: true, scrolledPx: scrolled, detail: scrolled > 0 ? "scrolled" : "scroll_no_progress" });
}

async function runLike(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const r = await likeVisibleOrTweet({
    tweetId: strOrNull(m.tweetId),
    tweetUrl: strOrNull(m.tweetUrl),
    onFeed: m.onFeed === true,
  });
  await finishAction(port, "x_like_result", r);
}

async function runTweetEngage(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const r = await engageTweetOnce({
    tweetId: strOrNull(m.tweetId),
    tweetUrl: strOrNull(m.tweetUrl),
    doLike: m.doLike === true,
    doRetweet: m.doRetweet === true,
    replyText: strOrNull(m.replyText),
  });
  const navErr = (e?: EngageResult) =>
    e && !e.ok && (e.error === "need_navigate_tweet" || e.error === "navigating_tweet");
  const nav =
    r.error === "need_navigate_tweet" ||
    r.error === "navigating_tweet" ||
    navErr(r.like) ||
    navErr(r.retweet) ||
    navErr(r.reply);
  const navDetail =
    (r.detail && r.detail.startsWith("https://") ? r.detail : null) ||
    detailOf(r.like) ||
    detailOf(r.retweet) ||
    detailOf(r.reply);

  port?.postMessage({
    ...snapshot(),
    type: "x_tweet_engage_result",
    ok: r.ok,
    error: nav ? "navigating_tweet" : r.error,
    detail: nav ? navDetail : r.detail,
    likeOk: r.like?.ok === true,
    likeDetail: resultDetail(r.like),
    retweetOk: r.retweet?.ok === true,
    retweetDetail: resultDetail(r.retweet),
    replyOk: r.reply?.ok === true,
    replyDetail: resultDetail(r.reply),
    at: Date.now(),
  });

  if (nav && typeof navDetail === "string" && navDetail.startsWith("https://")) {
    await new Promise((res) => setTimeout(res, 60));
    if (!isActionStopped()) location.assign(navDetail);
  }
}

type EngageResult = { ok: true; detail?: string } | { ok: false; error: string; detail?: string };

function detailOf(r?: EngageResult): string | null {
  if (!r || r.ok) return null;
  return typeof r.detail === "string" && r.detail.startsWith("https://") ? r.detail : null;
}

function resultDetail(r?: EngageResult): string | undefined {
  if (!r) return undefined;
  if (r.ok) return r.detail;
  return r.error;
}

async function runRetweet(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const r = await retweetTweet({
    tweetId: strOrNull(m.tweetId),
    tweetUrl: strOrNull(m.tweetUrl),
  });
  await finishAction(port, "x_retweet_result", r);
}

async function runReply(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const text = typeof m.text === "string" ? m.text : "";
  const r = await replyTweet({
    tweetId: strOrNull(m.tweetId),
    tweetUrl: strOrNull(m.tweetUrl),
    text,
    ownHandle: snapshot().handle || strOrNull(m.ownHandle),
  });
  await finishAction(port, "x_reply_result", r);
}

async function runQuote(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const text = typeof m.text === "string" ? m.text : "";
  const r = await quoteTweet({
    tweetId: strOrNull(m.tweetId),
    tweetUrl: strOrNull(m.tweetUrl),
    text,
  });
  await finishAction(port, "x_quote_result", r);
}

async function runFollow(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const r = await followAuthor({
    authorHandle: strOrNull(m.authorHandle),
    tweetUrl: strOrNull(m.tweetUrl),
    tweetId: strOrNull(m.tweetId),
    preferInline: m.preferInline === true,
  });
  await finishAction(port, "x_follow_result", r);
}

async function runFollowScan(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const seenArr = Array.isArray(m.seen) ? m.seen.filter((x): x is string => typeof x === "string") : [];
  const seen = new Set(seenArr.map((s) => s.toLowerCase()));
  const candidates = scanFollowUserCells(seen);
  port?.postMessage({
    ...snapshot(),
    type: "x_follow_scan_result",
    ok: true,
    candidates,
    at: Date.now(),
  });
}

async function runFollowProfileMeta(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const handle = strOrNull(m.authorHandle);
  const meta = readFollowProfileMeta(handle);
  // Nếu chưa đúng profile → bảo SW navigate.
  if (handle && !meta.onProfile) {
    replyResult(port, "x_follow_profile_meta_result", {
      ok: false,
      error: "need_navigate_profile",
      detail: `https://x.com/${handle}`,
    });
    return;
  }
  port?.postMessage({
    ...snapshot(),
    type: "x_follow_profile_meta_result",
    ok: true,
    meta,
    at: Date.now(),
  });
}

async function runFollowCell(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const handle = strOrNull(m.authorHandle);
  if (!handle) {
    replyResult(port, "x_follow_cell_result", { ok: false, error: "no_handle" });
    return;
  }
  const r = await followInUserCell(handle);
  replyResult(port, "x_follow_cell_result", {
    ok: r.ok,
    error: r.error,
    detail: r.detail,
  });
}

async function runFollowScrollList(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const steps = typeof m.steps === "number" ? m.steps : 3;
  await scrollFollowersList(steps);
  replyResult(port, "x_follow_scroll_list_result", { ok: true, detail: "scrolled" });
}

async function runUnfollowCell(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const handle = strOrNull(m.authorHandle);
  if (!handle) {
    replyResult(port, "x_unfollow_cell_result", { ok: false, error: "no_handle" });
    return;
  }
  const r = await unfollowInUserCell(handle);
  replyResult(port, "x_unfollow_cell_result", {
    ok: r.ok,
    error: r.error,
    detail: r.detail,
  });
}

async function runUnfollow(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const r = await unfollowAuthor({ authorHandle: strOrNull(m.authorHandle) });
  await finishAction(port, "x_unfollow_result", r);
}

async function runPostScanCollect(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const username = String(m.username || "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    replyResult(port, "x_post_scan_collect_result", { ok: false, error: "bad_username" });
    return;
  }
  const rawTh = m.thresholds && typeof m.thresholds === "object"
    ? (m.thresholds as Record<string, unknown>)
    : {};
  const thresholds: PostScanThresholds = {
    views: num(rawTh.views, 0),
    likes: num(rawTh.likes, 0),
    reposts: num(rawTh.reposts, 0),
    replies: num(rawTh.replies, 0),
  };
  const targetCount = Math.min(500, Math.max(1, num(m.targetCount, 50)));
  // Chỉ trả bài đang hiện (đủ metric). SW merge vào map riêng — không seed stub.
  const map = collectVisibleProfilePosts(
    username,
    thresholds,
    new Map<string, ScannedPostPayload>(),
    targetCount,
  );
  const posts = [...map.values()];
  port?.postMessage({
    ...snapshot(),
    type: "x_post_scan_collect_result",
    ok: true,
    posts,
    at: Date.now(),
  });
}

async function runPostScanScroll(port: XPort | null, m: Record<string, unknown>): Promise<void> {
  const dy = typeof m.distancePx === "number" ? m.distancePx : 0;
  const scrolledPx = scrollProfileBurst(dy);
  replyResult(port, "x_post_scan_scroll_result", { ok: true, detail: "scrolled", scrolledPx });
}

/** Trả lời port trước, rồi mới location.assign — tránh timeout vì mất port. */
async function finishAction(
  port: XPort | null,
  type: string,
  r: { ok: boolean; error?: string; detail?: string; scrolledPx?: number },
): Promise<void> {
  const navUrl =
    !r.ok &&
    (r.error === "need_navigate_tweet" ||
      r.error === "navigating_tweet")
      ? r.detail
      : null;

  replyResult(port, type, {
    ok: r.ok,
    error: navUrl
      ? r.error === "need_navigate_profile" || r.error === "navigating_profile"
        ? "navigating_profile"
        : "navigating_tweet"
      : r.error,
    detail: r.detail,
    scrolledPx: r.scrolledPx,
  });

  if (navUrl && typeof navUrl === "string" && navUrl.startsWith("https://")) {
    await new Promise((r) => setTimeout(r, 60));
    if (isActionStopped()) return;
    location.assign(navUrl);
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
