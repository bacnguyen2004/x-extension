/**
 * Thao tác DOM trên X. Dễ gãy khi X đổi UI — trả error code rõ.
 */

import {
  click,
  findArticleAction,
  findTweetArticle,
  qs,
  qsa,
  setComposerText,
  sleep,
  waitFor,
  waitForEnabledSubmit,
} from "../dom-utils.ts";
import { detectXIdentity } from "../identity.ts";
import { pathIsHome } from "../identity.ts";
import { findVisibleTimelineTweetArticle } from "../timeline.ts";
import { detectAccountUnavailable } from "../account-status.ts";
import { confirmOwnReply, readReplyAttempt, submitReplyOnce } from "../reply-history.ts";
import { cleanupOwnedComposer, dismissDraftConfirmation } from "../draft-confirmation.ts";
import { followFromPost } from "../inline-follow.ts";

/** Space consecutive interactions so they do not happen in a burst. */
function pauseBetweenActions(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  return sleep(ms);
}

export type EngageResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string; detail?: string };

async function ensureTweetVisible(tweetId: string | null, tweetUrl: string | null): Promise<EngageResult> {
  // Đã ở đúng status?
  if (tweetId && location.href.includes(`/status/${tweetId}`)) {
    await waitFor(() => findTweetArticle(tweetId) || qs('article[data-testid="tweet"]'), 5000);
    const blocked = detectAccountUnavailable();
    if (blocked) return { ok: false, error: blocked };
    return { ok: true };
  }
  // Tweet đang hiện trên timeline hiện tại?
  if (tweetId) {
    const art = findTweetArticle(tweetId);
    if (art) return { ok: true };
  }
  // Cần điều hướng — caller phải gửi result TRƯỚC khi gọi lại sau reload.
  if (tweetUrl && tweetUrl.includes("/status/")) {
    return { ok: false, error: "need_navigate_tweet", detail: tweetUrl };
  }
  if (tweetId) {
    return { ok: false, error: "tweet_not_found" };
  }
  return { ok: true };
}

function replyButton(scope: ParentNode = document): HTMLElement | null {
  if (scope instanceof HTMLElement && scope.matches?.('article[data-testid="tweet"]')) {
    return findArticleAction(scope, ["reply"]);
  }
  return qs('[data-testid="reply"]', scope);
}

function likeButton(scope: ParentNode = document): HTMLElement | null {
  if (scope instanceof HTMLElement && scope.matches?.('article[data-testid="tweet"]')) {
    return findArticleAction(scope, ["like", "unlike"]);
  }
  return qs('[data-testid="like"]', scope) || qs('[data-testid="unlike"]', scope);
}

function retweetButton(scope: ParentNode = document): HTMLElement | null {
  if (scope instanceof HTMLElement && scope.matches?.('article[data-testid="tweet"]')) {
    return findArticleAction(scope, ["retweet", "unretweet"]);
  }
  return qs('[data-testid="retweet"]', scope) || qs('[data-testid="unretweet"]', scope);
}

function replyDialog(): HTMLElement | null {
  return (
    qs('[role="dialog"][aria-modal="true"]') ||
    qs('[data-testid="mask"]')?.parentElement ||
    null
  );
}

function composerBox(root: ParentNode = document): HTMLElement | null {
  const scope = root;
  const direct =
    qs('[data-testid="tweetTextarea_0"]', scope) ||
    qs('[role="textbox"][data-testid^="tweetTextarea"]', scope) ||
    qs('div[role="textbox"][contenteditable="true"]', scope);
  if (!direct) return null;
  if (direct.matches?.('[contenteditable="true"]')) return direct as HTMLElement;
  return (
    (direct.querySelector('[contenteditable="true"]') as HTMLElement | null) ||
    (direct as HTMLElement)
  );
}

function submitButton(root: ParentNode = document): HTMLElement | null {
  return (
    qs('[data-testid="tweetButton"]', root) ||
    qs('[data-testid="tweetButtonInline"]', root)
  );
}

/** Đóng menu/ overlay còn sót sau RT trước khi mở reply. */
async function dismissOpenMenus(): Promise<void> {
  const confirm = qs('[data-testid="retweetConfirm"]');
  if (confirm) {
    // Menu RT còn mở — Escape để đóng, tránh che reply.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
  }
  const menu = qs('[role="menu"]');
  if (menu) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(250);
  }
}

/** X chặn reply bài quá cũ / hạn chế audience / cần Subscribe. */
function detectReplyBlocked(root: ParentNode = document): string | null {
  // Quét cả khối text — banner vàng thường nằm trong div dài, dễ vượt giới hạn span ngắn.
  const blob = (
    (root as HTMLElement).innerText ||
    (root as HTMLElement).textContent ||
    document.body?.innerText ||
    ""
  ).replace(/\s+/g, " ");
  if (/can'?t reply to a post this old|cannot reply to a post this old|không thể trả lời.*quá cũ|bài viết này quá cũ/i.test(blob)) {
    return "reply_too_old";
  }
  if (
    /only some accounts can reply|who can reply|only people (you )?mention|only people mentioned|only verified|chỉ một số tài khoản|chỉ những người được nhắc|ai có thể trả lời/i.test(
      blob,
    )
  ) {
    return "reply_restricted";
  }
  if (
    /subscribers? only|only subscribers|subscription required|super follow|chỉ người đăng ký|cần đăng ký|subscribe to reply|đăng ký để trả lời/i.test(
      blob,
    )
  ) {
    return "reply_subscribers_only";
  }
  return null;
}

function closeReplyDialog(root: ParentNode = document): void {
  const close =
    qs('[data-testid="app-bar-close"]', root) ||
    qs('[aria-label="Close"]', root) ||
    qs('[aria-label="Đóng"]', root);
  if (close) click(close);
  else {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  dismissDraftConfirmation(document);
}

/** Điền composer và bấm Post; thử lại nếu nút vẫn disabled. */
async function fillAndSubmit(text: string, root: ParentNode, submit?: (send: HTMLElement) => Promise<EngageResult>, verify?: () => Promise<EngageResult>): Promise<EngageResult> {
  let ownedBox: HTMLElement | undefined;
  try {
    return await fillAndSubmitInner(text, root, submit, verify, box => { ownedBox = box; });
  } finally {
    try { if (ownedBox) cleanupOwnedComposer(ownedBox, text, document); }
    catch { /* Preserve the original submit result and duplicate-send receipt. */ }
  }
}

async function fillAndSubmitInner(text: string, root: ParentNode, submit: ((send: HTMLElement) => Promise<EngageResult>) | undefined,
  verify: (() => Promise<EngageResult>) | undefined, remember: (box: HTMLElement) => void): Promise<EngageResult> {
  const trimmed = text.trim();
  // Không bao giờ dán SKIP / rỗng vào ô reply.
  if (!trimmed || /^SKIP\.?$/i.test(trimmed)) {
    closeReplyDialog(root);
    return { ok: false, error: "empty_text" };
  }

  await sleep(350);
  const blockedEarly = detectReplyBlocked(root) || detectReplyBlocked(document);
  if (blockedEarly) {
    closeReplyDialog(root);
    return { ok: false, error: blockedEarly };
  }

  const box = await waitFor(() => composerBox(root) || composerBox(document), 8000);
  if (!box) return { ok: false, error: "composer_missing" };

  // Banner đôi khi hiện sau khi composer mở — check lần nữa trước khi gõ.
  const blockedBeforeType = detectReplyBlocked(root) || detectReplyBlocked(document);
  if (blockedBeforeType) {
    closeReplyDialog(root);
    return { ok: false, error: blockedBeforeType };
  }

  remember(box);
  let filled = setComposerText(box, trimmed);
  if (!filled) {
    await sleep(400);
    filled = setComposerText(box, trimmed);
  }
  if (!filled) {
    closeReplyDialog(root);
    return { ok: false, error: "composer_set_failed" };
  }

  const findSend = () => submitButton(root) || submitButton(document);
  let send = await waitForEnabledSubmit(findSend, 3500);

  if (!send) {
    const blocked = detectReplyBlocked(root) || detectReplyBlocked(document);
    if (blocked) {
      closeReplyDialog(root);
      return { ok: false, error: blocked };
    }
    // Nút vẫn disabled → bỏ, không retry paste (tránh kẹt vòng với bài cũ / restricted).
    closeReplyDialog(root);
    return { ok: false, error: "submit_disabled" };
  }

  await sleep(Math.max(800, Math.min(2500, trimmed.length * 25)));
  if (submit) {
    const result = await submit(send);
    if (!result.ok || result.detail) return result;
  } else if (!click(send)) return { ok: false, error: "submit_click_failed" };
  await sleep(1200);
  if (verify) return verify();
  return { ok: true };
}

export async function likeVisibleOrTweet(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
  onFeed?: boolean;
}): Promise<EngageResult> {
  if (opts.onFeed && !pathIsHome(location.pathname)) return { ok: false, error: "feed_not_home" };
  const feedArticle = opts.onFeed && opts.tweetId ? findVisibleTimelineTweetArticle(opts.tweetId) : null;
  if (opts.onFeed && !feedArticle) return { ok: false, error: "feed_tweet_missing" };
  if (!opts.onFeed && (opts.tweetId || opts.tweetUrl)) {
    const nav = await ensureTweetVisible(opts.tweetId, opts.tweetUrl);
    if (!nav.ok) return nav;
  }
  const article = feedArticle || (opts.tweetId ? findTweetArticle(opts.tweetId) : null);
  const scope: ParentNode = article || document;
  const readLike = () => likeButton(scope);

  let btn = readLike();
  if (!btn) return { ok: false, error: "like_btn_missing" };
  if (btn.getAttribute("data-testid") === "unlike") {
    return { ok: true, detail: "already_liked" };
  }

  if (!click(btn)) return { ok: false, error: "like_click_failed" };

  // Xác nhận tim đã đổi — poll nhanh để 3 action trong cùng tweet chạy liền.
  const confirmed = await waitFor(() => {
    const b = readLike();
    if (b && b.getAttribute("data-testid") === "unlike") return b;
    return null;
  }, 1800, 120);

  if (confirmed) return { ok: true, detail: "liked" };

  btn = readLike();
  if (btn && btn.getAttribute("data-testid") === "like") {
    click(btn);
    const again = await waitFor(() => {
      const b = readLike();
      return b && b.getAttribute("data-testid") === "unlike" ? b : null;
    }, 1500, 120);
    if (again) return { ok: true, detail: "liked_retry" };
  }

  return { ok: false, error: "like_not_confirmed" };
}

export type TweetEngageReport = {
  ok: boolean;
  error?: string;
  detail?: string;
  like?: EngageResult;
  retweet?: EngageResult;
  reply?: EngageResult;
};

/** Một lần vào tweet: like + RT + reply liền mạch (không rời trang). */
export async function engageTweetOnce(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
  doLike: boolean;
  doRetweet: boolean;
  replyText?: string | null;
}): Promise<TweetEngageReport> {
  const doReply = !!(opts.replyText && opts.replyText.trim());
  if (!opts.doLike && !opts.doRetweet && !doReply) {
    return { ok: true, detail: "nothing_to_do" };
  }
  const nav = await ensureTweetVisible(opts.tweetId, opts.tweetUrl);
  if (!nav.ok) return { ok: false, error: nav.error, detail: nav.detail };

  let like: EngageResult | undefined;
  let retweet: EngageResult | undefined;
  let reply: EngageResult | undefined;

  // Like → Reply → RT với nghỉ 2–5s giữa mỗi bước (tránh spam/ban). Reply trước RT.
  if (opts.doLike) {
    like = await likeVisibleOrTweet({ tweetId: opts.tweetId, tweetUrl: opts.tweetUrl });
    if (doReply || opts.doRetweet) await pauseBetweenActions(6000, 16000);
  }
  if (doReply) {
    reply = await replyTweet({
      tweetId: opts.tweetId,
      tweetUrl: opts.tweetUrl,
      text: opts.replyText!.trim(),
    });
    if (opts.doRetweet) await pauseBetweenActions(6000, 16000);
  }
  if (opts.doRetweet) {
    retweet = await retweetTweet({ tweetId: opts.tweetId, tweetUrl: opts.tweetUrl });
    await pauseBetweenActions(800, 1600);
  }

  const likeFail = like && !like.ok && like.error !== "already_liked";
  const rtFail = retweet && !retweet.ok && retweet.error !== "already_retweeted";
  const replyFail = reply && !reply.ok;
  const likeOk = !opts.doLike || like?.ok === true;
  const rtOk = !opts.doRetweet || retweet?.ok === true;
  const replyOk = !doReply || reply?.ok === true;

  return {
    ok: likeOk && rtOk && replyOk,
    error: like && !like.ok && likeFail
      ? like.error
      : retweet && !retweet.ok && rtFail
        ? retweet.error
        : reply && !reply.ok && replyFail
          ? reply.error
          : undefined,
    detail:
      [like?.detail, retweet?.detail, reply?.detail].filter(Boolean).join("+") || undefined,
    like,
    retweet,
    reply,
  };
}

export async function retweetTweet(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
}): Promise<EngageResult> {
  const nav = await ensureTweetVisible(opts.tweetId, opts.tweetUrl);
  if (!nav.ok) return nav;
  const article = opts.tweetId ? findTweetArticle(opts.tweetId) : null;
  const scope: ParentNode = article || document;
  const readRt = () => retweetButton(scope);
  const btn = readRt();
  if (!btn) return { ok: false, error: "retweet_btn_missing" };
  if (btn.getAttribute("data-testid") === "unretweet") {
    return { ok: true, detail: "already_retweeted" };
  }
  if (!click(btn)) return { ok: false, error: "retweet_click_failed" };
  const confirm = await waitFor(
    () => qs('[data-testid="retweetConfirm"]') || qs('[data-testid="retweetConfirm"] span'),
    4000,
  );
  if (confirm) click(confirm);
  else {
    const items = qsa('[role="menuitem"]');
    const rt = items.find((el) => /repost|retweet|đăng lại/i.test(el.textContent || ""));
    if (!rt) return { ok: false, error: "retweet_confirm_missing" };
    click(rt);
  }
  const confirmed = await waitFor(() => {
    const b = readRt();
    return b && b.getAttribute("data-testid") === "unretweet" ? b : null;
  }, 2000, 120);
  if (confirmed) return { ok: true, detail: "retweeted" };
  await sleep(200);
  return { ok: true, detail: "retweet_clicked" };
}

/**
 * Đã tự reply bài này trên X chưa (comment tay hoặc agent lần trước).
 * Tránh đăng comment lần 2 khi Pogo vẫn chưa recorded.
 */
export function hasOwnReplyToTweet(tweetId: string, ownHandle: string): boolean {
  const id = tweetId.trim();
  const handle = ownHandle.replace(/^@/, "").toLowerCase();
  if (!/^\d{1,30}$/.test(id) || !/^[a-z0-9_]{1,15}$/.test(handle)) return false;

  const original = findTweetArticle(id);
  for (const article of qsa('article[data-testid="tweet"]')) {
    if (original && article === original) continue;

    // Status URL của chính article này — nếu là bài gốc thì bỏ.
    const links = [...article.querySelectorAll("a[href*='/status/']")];
    const statusHref = (links.find((a) => a.querySelector("time")) ? [links.find((a) => a.querySelector("time"))!] : links)
      .map((a) => a.getAttribute("href") || "")
      .find((h) => /\/status\/\d+/.test(h));
    if (statusHref && statusHref.includes(`/status/${id}`)) {
      // Link tới đúng id có thể là "Replying to" hoặc chính timestamp của gốc.
      const ownStatus = /\/status\/(\d+)/.exec(statusHref)?.[1];
      if (ownStatus === id) continue;
    }

    const authorScope = article.querySelector('[data-testid="User-Name"]');
    const authored = authorScope
      ? [...authorScope.querySelectorAll("a[href]")].some((a) =>
          (a.getAttribute("href") || "").split("?")[0].replace(/\/$/, "").toLowerCase() === `/${handle}`)
      : !!statusHref && new RegExp(`^/${handle}/status/\\d+`, "i").test(statusHref);
    if (!authored) continue;

    const text = article.textContent || "";
    const html = article.innerHTML || "";
    if (
      (typeof location !== "undefined" && new RegExp(`/status/${id}(?:[/?#]|$)`).test(location.href) &&
        /replied|replying to|đã trả lời|đang trả lời/i.test(text)) ||
      new RegExp(`/status/${id}(?:[/?#"']|$)`).test(html)
    ) {
      return true;
    }
  }
  return false;
}

export async function replyTweet(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
  text: string;
  ownHandle?: string | null;
}): Promise<EngageResult> {
  const raw = opts.text.trim();
  if (!raw || /^SKIP\.?$/i.test(raw)) return { ok: false, error: "empty_text" };
  const nav = await ensureTweetVisible(opts.tweetId, opts.tweetUrl);
  if (!nav.ok) return nav;
  await dismissOpenMenus();
  await sleep(500);

  let own =
    (opts.ownHandle || "").replace(/^@/, "") ||
    detectXIdentity(document, location.pathname).handle ||
    "";
  if (!own) own = await waitFor(() => detectXIdentity(document, location.pathname).handle, 3000, 250) || "";
  if (opts.tweetId && own && hasOwnReplyToTweet(opts.tweetId, own)) {
    try { await confirmOwnReply(opts.tweetId, own); } catch { /* Still skip the visible reply. */ }
    return { ok: true, detail: "already_replied" };
  }
  try {
    const evidence = opts.tweetId && own ? await readReplyAttempt(opts.tweetId, own) : null;
    if (evidence) {
      return { ok: true, detail: evidence.state === "confirmed" ? "already_replied" : "reply_attempt_exists" };
    }
  } catch {
    return { ok: false, error: "reply_history_unavailable" };
  }

  const scope = opts.tweetId ? findTweetArticle(opts.tweetId) || document : document;

  const pre = detectReplyBlocked(scope) || detectReplyBlocked(document);
  if (pre) return { ok: false, error: pre };

  const btn = replyButton(scope) || replyButton(document);
  if (!btn) return { ok: false, error: "reply_btn_missing" };
  const aria = `${btn.getAttribute("aria-label") || ""} ${btn.textContent || ""}`;
  if (/subscribe|đăng ký|subscribers? only/i.test(aria)) {
    return { ok: false, error: "reply_subscribers_only" };
  }
  click(btn);

  const dialog = await waitFor(() => replyDialog(), 5000);
  const limited = qs('[data-testid="sheetDialog"]');
  if (limited) {
    const cancel =
      qs('[data-testid="confirmationSheetCancel"]', limited) ||
      qs('[data-testid="app-bar-close"]', limited);
    if (cancel) click(cancel);
    const sub = detectReplyBlocked(limited);
    return { ok: false, error: sub || "reply_restricted" };
  }

  const root: ParentNode = dialog || document;
  await sleep(450);
  const blocked = detectReplyBlocked(root) || detectReplyBlocked(document);
  if (blocked) {
    closeReplyDialog(root);
    return { ok: false, error: blocked };
  }
  const oldToasts = new Set(qsa('[data-testid="toast"]'));
  return fillAndSubmit(raw, root, async (send) => {
    if (!own) {
      const avatar = qsa('[data-testid^="UserAvatar-Container-"]', root).find(el => !el.closest('article[data-testid="tweet"]'));
      own = detectXIdentity(document, location.pathname).handle || avatar?.getAttribute("data-testid")?.replace(/^UserAvatar-Container-/, "") || "";
    }
    if (!opts.tweetId || !own) return { ok: false, error: "reply_identity_missing" };
    const current = detectXIdentity(document, location.pathname).handle;
    if (current && current.toLowerCase() !== own.toLowerCase()) return { ok: false, error: "reply_identity_missing" };
    if (hasOwnReplyToTweet(opts.tweetId, own)) {
      await confirmOwnReply(opts.tweetId, own);
      return { ok: true, detail: "already_replied" };
    }
    try {
      const result = await submitReplyOnce(opts.tweetId, own, () => {
        const activeHandle = detectXIdentity(document, location.pathname).handle;
        if ((activeHandle && activeHandle.toLowerCase() !== own.toLowerCase()) || hasOwnReplyToTweet(opts.tweetId!, own)) return false;
        return click(send);
      });
      if (result === "exists") return { ok: true, detail: "reply_attempt_exists" };
      return result === "submitted" ? { ok: true } : { ok: false, error: "submit_click_failed" };
    } catch {
      return { ok: false, error: "reply_history_unavailable" };
    }
  }, async () => {
    // Submission is complete after the click; X may omit or delay its sent toast.
    const confirmed = hasOwnReplyToTweet(opts.tweetId!, own) ||
      qsa('[data-testid="toast"]').some((toast) => !oldToasts.has(toast) &&
        /your (post|reply|tweet) was sent|bài (đăng|viết).*đã.*gửi|đã gửi.*(bài|trả lời)/i.test(toast.textContent || ""));
    if (!confirmed) return { ok: true, detail: "reply_submitted" };
    await confirmOwnReply(opts.tweetId!, own);
    return { ok: true, detail: "reply_confirmed" };
  });
}

export async function quoteTweet(opts: {
  tweetId: string | null;
  tweetUrl: string | null;
  text: string;
}): Promise<EngageResult> {
  if (!opts.text.trim()) return { ok: false, error: "empty_text" };
  const nav = await ensureTweetVisible(opts.tweetId, opts.tweetUrl);
  if (!nav.ok) return nav;
  await dismissOpenMenus();
  await sleep(600);
  const scope = opts.tweetId ? findTweetArticle(opts.tweetId) || document : document;
  const btn = retweetButton(scope);
  if (!btn) return { ok: false, error: "retweet_btn_missing" };
  click(btn);
  await sleep(400);
  const items = await waitFor(() => {
    const list = qsa('[role="menuitem"]');
    return list.find((el) => /quote|trích|dẫn/i.test(el.textContent || "")) || null;
  }, 4000);
  if (!items) return { ok: false, error: "quote_menu_missing" };
  click(items);
  const dialog = await waitFor(() => replyDialog(), 5000);
  const root: ParentNode = dialog || document;
  const own = detectXIdentity(document, location.pathname).handle;
  const oldToasts = new Set(qsa('[data-testid="toast"]'));
  return fillAndSubmit(opts.text.trim(), root, async (send) => {
    if (!opts.tweetId || !own) return { ok: false, error: "reply_identity_missing" };
    try {
      const result = await submitReplyOnce(opts.tweetId, own, () => {
        if (detectXIdentity(document, location.pathname).handle?.toLowerCase() !== own.toLowerCase()) return false;
        return click(send);
      }, "quote");
      if (result === "exists") return { ok: true, detail: "quote_attempt_exists" };
      return result === "submitted" ? { ok: true } : { ok: false, error: "submit_click_failed" };
    } catch { return { ok: false, error: "reply_history_unavailable" }; }
  }, async () => {
    const sent = await waitFor(() => qsa('[data-testid="toast"]').some((toast) => !oldToasts.has(toast) &&
      /your (post|tweet) was sent|bài (đăng|viết).*đã.*gửi|đã gửi.*bài/i.test(toast.textContent || "")) || null, 4000, 250);
    if (!sent) return { ok: false, error: "quote_submission_uncertain" };
    await confirmOwnReply(opts.tweetId!, own!, "quote");
    return { ok: true, detail: "quote_confirmed" };
  });
}

/** Nút trong “You might like” / Who to follow / sidebar — không phải CTA profile. */
function isSuggestionFollowControl(el: Element): boolean {
  if (el.closest('article[data-testid="tweet"]')) return true;
  if (el.closest('[data-testid="UserCell"]')) return true;
  if (el.closest('[data-testid="sidebarColumn"]')) return true;
  if (el.closest('aside[role="complementary"]')) return true;
  const aside = el.closest("aside");
  if (aside) {
    const t = (aside.getAttribute("aria-label") || aside.textContent || "").toLowerCase();
    if (
      t.includes("you might like") ||
      t.includes("who to follow") ||
      t.includes("có thể bạn sẽ thích")
    ) {
      return true;
    }
  }
  return false;
}

/** Chỉ lấy follow/unfollow của chính profile trong primaryColumn. */
function profileFollowControls(handle: string): {
  follow: HTMLElement | null;
  unfollow: HTMLElement | null;
  ownProfile: boolean;
  requested: boolean;
} {
  const root =
    qs<HTMLElement>('[data-testid="primaryColumn"]') ||
    qs<HTMLElement>('main[role="main"]') ||
    document.body;

  const ownProfile = !!qs('[data-testid="editProfileButton"]', root);

  const candidates = [
    ...qsa<HTMLElement>('[data-testid$="-unfollow"]', root),
    ...qsa<HTMLElement>('[data-testid$="-follow"]', root),
    ...qsa<HTMLElement>('button', root),
    ...qsa<HTMLElement>('[role="button"]', root),
  ];

  let follow: HTMLElement | null = null;
  let unfollow: HTMLElement | null = null;
  let requested = false;

  for (const el of candidates) {
    if (isSuggestionFollowControl(el)) continue;
    const testId = (el.getAttribute("data-testid") || "").toLowerCase();
    const label = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    const mentions = aria.match(/@[a-z0-9_]+/g);
    if (mentions?.length && !mentions.includes(`@${handle.toLowerCase()}`)) continue;
    if (/^(requested|pending|đã gửi yêu cầu|đang chờ)$/i.test(label)) {
      requested = true;
      continue;
    }

    if (/-unfollow$/.test(testId)) {
      unfollow = unfollow || el;
      continue;
    }
    if (/-follow$/.test(testId)) {
      follow = follow || el;
      continue;
    }

    if (
      !unfollow &&
      (/^following$|^đang theo dõi$|^unfollow$/i.test(label) ||
        aria.includes("following") ||
        aria.includes("unfollow") ||
        aria.includes("đang theo dõi"))
    ) {
      unfollow = el;
      continue;
    }
    if (
      !follow &&
      (/^follow$|^theo dõi$/i.test(label) ||
        ((aria.includes("follow") || aria.includes("theo dõi")) &&
          !aria.includes("following") &&
          !aria.includes("unfollow")))
    ) {
      if (aria && handle && aria.includes("@") && !aria.toLowerCase().includes(`@${handle.toLowerCase()}`)) {
        continue;
      }
      follow = el;
    }
  }

  return { follow, unfollow, ownProfile, requested };
}

export async function followAuthor(opts: {
  authorHandle: string | null;
  tweetUrl: string | null;
  preferInline?: boolean;
  tweetId?: string | null;
}): Promise<EngageResult> {
  const handle = opts.authorHandle?.replace(/^@/, "");
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { ok: false, error: "no_handle" };
  if (opts.preferInline && opts.tweetId) {
    const inline = await followFromPost(handle, opts.tweetId);
    if (inline.ok || inline.error !== "inline_follow_unavailable") return inline;
  }
  const profile = `https://x.com/${handle}`;
  const path = location.pathname.toLowerCase().replace(/\/+$/, "");
  // A /handle/status/id page is a tweet, not the author's profile.
  const onProfile = path === `/${handle.toLowerCase()}`;
  if (!onProfile) {
    // Không assign ở đây — để x-commands trả lời port trước rồi mới navigate.
    return { ok: false, error: "need_navigate_profile", detail: profile };
  }
  await sleep(800);

  const blockedEarly = detectAccountUnavailable();
  if (blockedEarly) return { ok: false, error: blockedEarly };

  let unavailable: string | null = null;
  const controls = await waitFor(() => {
    unavailable = detectAccountUnavailable();
    if (unavailable) return "blocked" as const;
    const current = profileFollowControls(handle);
    return current.follow || current.unfollow || current.ownProfile || current.requested
      ? current
      : null;
  }, 8000);
  if (controls === "blocked" || unavailable) {
    return { ok: false, error: unavailable || detectAccountUnavailable() || "profile_unavailable" };
  }
  if (!controls) {
    return { ok: false, error: detectAccountUnavailable() || "follow_btn_missing" };
  }
  const { follow, unfollow, ownProfile, requested } = controls;
  if (ownProfile) return { ok: true, detail: "own_profile" };
  if (requested) return { ok: true, detail: "follow_requested" };
  // Đã follow rồi → thôi, không bấm Follow trong “You might like”.
  if (unfollow) return { ok: true, detail: "already_following" };
  if (!follow) return { ok: false, error: detectAccountUnavailable() || "follow_btn_missing" };

  const testId = (follow.getAttribute("data-testid") || "").toLowerCase();
  if (testId.includes("unfollow")) return { ok: true, detail: "already_following" };

  if (follow.getAttribute("aria-disabled") === "true" || (follow as HTMLButtonElement).disabled) {
    return { ok: false, error: "follow_disabled" };
  }
  if (!click(follow)) return { ok: false, error: "follow_click_failed" };
  const confirmed = await waitFor(() => {
    const current = profileFollowControls(handle);
    return current.unfollow || current.requested ? current : null;
  }, 5000);
  if (!confirmed) return { ok: false, error: "follow_not_confirmed" };
  return { ok: true, detail: confirmed.requested ? "follow_requested" : "follow_confirmed" };
}

export async function unfollowAuthor(opts: {
  authorHandle: string | null;
}): Promise<EngageResult> {
  const handle = opts.authorHandle?.replace(/^@/, "");
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { ok: false, error: "no_handle" };
  const profile = `https://x.com/${handle}`;
  const path = location.pathname.toLowerCase().replace(/\/+$/, "");
  const onProfile = path === `/${handle.toLowerCase()}`;
  if (!onProfile) {
    return { ok: false, error: "need_navigate_profile", detail: profile };
  }
  await sleep(800);

  const controls = await waitFor(() => {
    const current = profileFollowControls(handle);
    return current.follow || current.unfollow || current.ownProfile ? current : null;
  }, 8000);
  if (!controls) return { ok: false, error: "unfollow_btn_missing" };
  if (controls.ownProfile) return { ok: true, detail: "own_profile" };
  if (controls.follow && !controls.unfollow) return { ok: true, detail: "already_not_following" };
  if (!controls.unfollow) return { ok: false, error: "unfollow_btn_missing" };

  if (!click(controls.unfollow)) return { ok: false, error: "unfollow_click_failed" };
  await sleep(400);
  const confirm =
    qs('[data-testid="confirmationSheetConfirm"]') ||
    qsa<HTMLElement>('button, [role="button"]').find((el) =>
      /^(unfollow|hủy theo dõi)$/i.test((el.textContent || "").trim()),
    ) ||
    null;
  if (confirm) click(confirm);

  const done = await waitFor(() => {
    const current = profileFollowControls(handle);
    return current.follow && !current.unfollow ? current : null;
  }, 5000);
  if (!done) return { ok: false, error: "unfollow_not_confirmed" };
  return { ok: true, detail: "unfollow_confirmed" };
}
