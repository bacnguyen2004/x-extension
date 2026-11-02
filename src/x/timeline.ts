/**
 * Quét bài đang visible trên timeline Home (browse engage v1).
 */

import { findArticleAction, qsa } from "./dom-utils.ts";
import { isHandle, isTweetId, sanitizeTweetUrl } from "../domain/url.ts";
import type { OwnerPost } from "../domain/reply-conversation.ts";

export interface TimelineTweet {
  tweetId: string;
  authorHandle: string;
  tweetUrl: string;
  text: string | null;
  alreadyLiked: boolean;
  alreadyRetweeted?: boolean;
  alreadyFollowing?: boolean;
  promoted: boolean;
  directedToOwn?: boolean;
  notificationKind?: "direct" | "post";
  notificationType?: "reply" | "mention";
  conversationId?: string;
}

function belongsToArticle(element: Element, article: Element): boolean {
  return element.closest('article[data-testid="tweet"]') === article &&
    !element.closest('[data-testid="card.wrapper"], [data-testid="quoteTweet"], div[role="link"]');
}

function authorFromArticle(article: Element): string | null {
  const name = [...article.querySelectorAll('[data-testid="User-Name"]')].find((el) => belongsToArticle(el, article));
  if (!name) return null;
  const links = name.querySelectorAll("a[href]");
  for (const a of links) {
    const href = (a as HTMLAnchorElement).getAttribute("href") || "";
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    if (m?.[1] && isHandle(m[1]) && !["home", "i", "search", "explore"].includes(m[1].toLowerCase())) {
      return m[1];
    }
  }
  const textMatch = (name.textContent || "").match(/@([A-Za-z0-9_]{1,15})/);
  return textMatch?.[1] && isHandle(textMatch[1]) ? textMatch[1] : null;
}

function tweetIdFromArticle(article: Element, author: string): string | null {
  const links = [...article.querySelectorAll('a[href*="/status/"]')].filter((a) => belongsToArticle(a, article) &&
    !a.closest('[data-testid="tweetText"]'));
  links.sort((a, b) => Number(!!b.querySelector("time")) - Number(!!a.querySelector("time")));
  for (const a of links) {
    const href = (a as HTMLAnchorElement).href || (a as HTMLAnchorElement).getAttribute("href") || "";
    const m = href.match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d{8,22})(?:[/?#]|$)/);
    if (m?.[1]?.toLowerCase() === author.toLowerCase() && isTweetId(m[2])) return m[2];
  }
  return null;
}

function textFromArticle(article: Element): string | null {
  const el = [...article.querySelectorAll('[data-testid="tweetText"]')].find((el) => belongsToArticle(el, article));
  const text = (el?.textContent || "").replace(/\s+/g, " ").trim();
  return text || null;
}

export function readTweetArticle(article: Element): { author: string; text: string; tweetId: string; tweetUrl: string } | null {
  if (article.parentElement?.closest('article[data-testid="tweet"]')) return null;
  const author = authorFromArticle(article), text = textFromArticle(article);
  const tweetId = author ? tweetIdFromArticle(article, author) : null;
  return author && text && tweetId ? { author, text, tweetId, tweetUrl: `https://x.com/${author}/status/${tweetId}` } : null;
}

function isPromoted(article: Element): boolean {
  // Look for a standalone UI label, not words in the post or author's name.
  const labels = article.querySelectorAll('span, [data-testid="socialContext"], [data-testid="promotedIndicator"], [data-testid="promotedLabel"]');
  for (const label of labels) {
    if (!belongsToArticle(label, article)) continue;
    if (label.closest('[data-testid="tweetText"], [data-testid="User-Name"], [data-testid="card.wrapper"]')) continue;
    const text = (label.textContent || "").replace(/\s+/g, " ").trim();
    if (/^(?:ad|ads|promoted|sponsored|được tài trợ|quảng cáo)$/iu.test(text)) return true;
  }
  return false;
}

export function isRoughlyVisible(el: Element): boolean {
  if (typeof el.getBoundingClientRect !== "function") return true;
  const r = el.getBoundingClientRect();
  // linkedom/jsdom thường trả rect 0 — coi như visible trong unit test.
  if (!r || (r.width === 0 && r.height === 0 && r.top === 0 && r.bottom === 0)) return true;
  if (r.height < 40 || r.width < 40) return false;
  const vh = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
  return r.bottom > 40 && r.top < vh - 40;
}

/** Resolve the current visible post itself, never a wrapper quoting this ID. */
export function findVisibleTimelineTweetArticle(tweetId: string, doc: Document = document): HTMLElement | null {
  for (const article of qsa<HTMLElement>('article[data-testid="tweet"]', doc)) {
    if (article.parentElement?.closest('article[data-testid="tweet"]') || article.closest('[aria-hidden="true"]') || !isRoughlyVisible(article)) continue;
    const author = authorFromArticle(article);
    if (author && tweetIdFromArticle(article, author) === tweetId) return article;
  }
  return null;
}

/** Sanitize payload từ content → TimelineTweet[]. */
export function sanitizeTimelineTweets(raw: unknown): TimelineTweet[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineTweet[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const tweetId = typeof o.tweetId === "string" ? o.tweetId : "";
    const authorHandle = typeof o.authorHandle === "string" ? o.authorHandle : "";
    if (!isTweetId(tweetId) || !isHandle(authorHandle)) continue;
    if (seen.has(tweetId)) continue;
    const tweetUrl =
      sanitizeTweetUrl(typeof o.tweetUrl === "string" ? o.tweetUrl : null) ||
      sanitizeTweetUrl(`https://x.com/${authorHandle}/status/${tweetId}`);
    if (!tweetUrl) continue;
    seen.add(tweetId);
    out.push({
      tweetId,
      authorHandle,
      tweetUrl,
      text: typeof o.text === "string" ? o.text.slice(0, 4000) : null,
      alreadyLiked: o.alreadyLiked === true,
      alreadyRetweeted: o.alreadyRetweeted === true,
      alreadyFollowing: o.alreadyFollowing === true,
      promoted: o.promoted === true,
      ...(o.directedToOwn === true ? { directedToOwn: true } : {}),
      ...(o.notificationKind === "direct" || o.notificationKind === "post" ? { notificationKind: o.notificationKind } : {}),
      ...(o.notificationType === "reply" || o.notificationType === "mention" ? { notificationType: o.notificationType } : {}),
      ...(typeof o.conversationId === "string" && /^\d+$/.test(o.conversationId) ? { conversationId: o.conversationId } : {}),
    });
  }
  return out;
}

function replyHandles(article: Element): string[] {
  return [...article.querySelectorAll('a[href]')].filter(a => belongsToArticle(a, article) && !a.closest('[data-testid="tweetText"], [data-testid="User-Name"]'))
    .map(a => (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase()).filter((h): h is string => !!h);
}

export function collectVisibleMentionTweets(doc: Document, ownHandle: string, limit = 12): TimelineTweet[] {
  const own = ownHandle.replace(/^@/, '').toLowerCase();
  if (!isHandle(own)) return [];
  return collectVisibleTimelineTweets(doc, limit).filter(post => {
    if (post.authorHandle.toLowerCase() === own || post.promoted) return false;
    const article = findVisibleTimelineTweetArticle(post.tweetId, doc);
    return !!article && isDirectMention(article, own);
  }).map(post => ({ ...post, directedToOwn: true }));
}

export function isDirectMention(article: Element, ownHandle: string): boolean {
  const own = ownHandle.replace(/^@/, '').toLowerCase();
  if (!isHandle(own) || authorFromArticle(article)?.toLowerCase() === own) return false;
  const parentLink = [...article.querySelectorAll('a[href]')].some(a => belongsToArticle(a, article) &&
    !a.closest('[data-testid="tweetText"], [data-testid="User-Name"]') &&
    new RegExp(`^/${own}/status/\\d+(?:[/?#]|$)`, 'i').test(a.getAttribute('href') || ''));
  return new RegExp(`@${own}(?![A-Za-z0-9_])`, 'i').test(textFromArticle(article) || '') || replyHandles(article).includes(own) || parentLink;
}

/** Read preceding posts only on the already opened target thread. Never infer hidden text. */
export function readConversationContext(doc: Document, targetId: string, ownHandle = ""): { parentText: string; conversationContext: string; ownerPost?: OwnerPost } {
  const root = doc.querySelector('[data-testid="primaryColumn"]') || doc.querySelector('main') || doc;
  const articles = [...root.querySelectorAll('article[data-testid="tweet"]')].filter(a => !a.parentElement?.closest('article[data-testid="tweet"]') && !a.closest('[aria-hidden="true"]') && !isPromoted(a));
  const posts = articles.map(article => {
    const author = authorFromArticle(article);
    return { article, author, id: author ? tweetIdFromArticle(article, author) : null, text: textFromArticle(article) };
  });
  const index = posts.findIndex(post => post.id === targetId);
  if (index < 0) return { parentText: '', conversationContext: '' };
  const prior = posts.slice(0, index).filter(post => post.id && post.author && post.text).slice(-3);
  // A profile link identifies a recipient, not the exact parent post.
  const parentLinks = [...posts[index].article.querySelectorAll('a[href]')].filter(a => belongsToArticle(a, posts[index].article) && !a.closest('[data-testid="tweetText"], [data-testid="User-Name"]'))
    .map(a => (a.getAttribute('href') || '').match(/^\/[A-Za-z0-9_]+\/status\/(\d+)(?:[/?#]|$)/)?.[1]).filter(Boolean);
  const parent = [...prior].reverse().find(post => parentLinks.includes(post.id!));
  const own = ownHandle.replace(/^@/, '').toLowerCase();
  const ownerEntry = own ? (parent?.author?.toLowerCase() === own ? parent : posts.slice(0, index).find(p => p.author?.toLowerCase() === own && p.id && p.text)) : null;
  const ownerPost: OwnerPost | undefined = ownerEntry?.id && ownerEntry.author && ownerEntry.text
    ? { author: ownerEntry.author, tweetId: ownerEntry.id, text: ownerEntry.text.slice(0, 4000), relationship: parent === ownerEntry ? "parent" : "thread_context" } : undefined;
  const ownerFrame = ownerPost && posts[index].author?.toLowerCase() !== own
    ? `READ IN ORDER: (1) YOUR EARLIER POST: ${JSON.stringify(ownerPost)}\n(2) COMMENT YOU ARE ANSWERING: ${JSON.stringify({ author: posts[index].author, tweetId: targetId, text: posts[index].text })}\n(3) You are @${own}, the post owner, replying to this commenter. Determine what their comment means about your post before drafting. Do not treat the commenter as the owner of the subject described in your post. A thread_context relationship does not prove the exact parent.\n` : '';
  const describe = (post: typeof posts[number]) => `@${post.author}${own ? (post.author?.toLowerCase() === own ? ' [ACCOUNT OWNER]' : ' [OTHER AUTHOR]') : ' [OWNER IDENTITY UNAVAILABLE]'} (#${post.id}): ${post.text}`;
  return { parentText: parent?.text?.slice(0, 4000) || '',
    ...(ownerPost ? { ownerPost } : {}),
    conversationContext: prior.length ? `${ownerFrame}${own ? `ACCOUNT OWNER: @${own}.\n` : ''}CURRENT MESSAGE TO ANSWER: @${posts[index].author} (#${targetId}).\n${parent ? 'Earlier thread posts:' : 'Visible preceding thread posts (exact parent not verified):'}\n${prior.map(describe).join('\n\n')}\nDetails belong to their labeled authors; they do not establish the current author's image, appearance or experiences.`.slice(0, 6000) : '' };
}

/** Only explicit parent permalinks prove which exact tweet a visible own reply answers. */
export function readOwnRepliesToTweet(doc: Document, targetId: string, ownHandle: string): Array<{ tweetId: string; text: string }> {
  const own = ownHandle.replace(/^@/, '').toLowerCase();
  if (!isHandle(own) || !isTweetId(targetId)) return [];
  const root = doc.querySelector('[data-testid="primaryColumn"]') || doc.querySelector('main') || doc;
  const result: Array<{ tweetId: string; text: string }> = [];
  for (const article of root.querySelectorAll('article[data-testid="tweet"]')) {
    if (article.closest('[aria-hidden="true"]') || isPromoted(article)) continue;
    const post = readTweetArticle(article);
    if (!post || post.author.toLowerCase() !== own || post.tweetId === targetId) continue;
    const parent = [...article.querySelectorAll('a[href]')].some(a => belongsToArticle(a, article) &&
      !a.closest('[data-testid="tweetText"], [data-testid="User-Name"]') && !a.querySelector('time') &&
      new RegExp(`/status/${targetId}(?:[/?#]|$)`).test(a.getAttribute('href') || ''));
    if (parent) result.push({ tweetId: post.tweetId, text: post.text });
  }
  return result;
}

/** Tối đa `limit` bài visible trên timeline hiện tại. */
export function collectVisibleTimelineTweets(
  doc: Document = document,
  limit = 12,
  visibleOnly = true,
): TimelineTweet[] {
  const articles = qsa<HTMLElement>('article[data-testid="tweet"]', doc);
  const out: TimelineTweet[] = [];
  const seen = new Set<string>();

  for (const article of articles) {
    if (article.parentElement?.closest('article[data-testid="tweet"]') || article.closest('[aria-hidden="true"]')) continue;
    if (visibleOnly && !isRoughlyVisible(article)) continue;
    const authorHandle = authorFromArticle(article);
    const tweetId = authorHandle ? tweetIdFromArticle(article, authorHandle) : null;
    if (!tweetId || !authorHandle) continue;
    if (seen.has(tweetId)) continue;
    const tweetUrl = sanitizeTweetUrl(`https://x.com/${authorHandle}/status/${tweetId}`);
    if (!tweetUrl) continue;
    seen.add(tweetId);

    const unlike = findArticleAction(article, ["unlike"]);
    const like = findArticleAction(article, ["like"]);
    out.push({
      tweetId,
      authorHandle,
      tweetUrl,
      text: textFromArticle(article),
      alreadyLiked: !!unlike && !like,
      alreadyRetweeted: !!findArticleAction(article, ["unretweet"]),
      alreadyFollowing: [...article.querySelectorAll('[data-testid$="-unfollow"]')].some((el) => belongsToArticle(el, article)),
      promoted: isPromoted(article),
    });
    if (out.length >= limit) break;
  }
  return out;
}
