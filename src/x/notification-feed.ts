import { collectVisibleTimelineTweets, findVisibleTimelineTweetArticle, isDirectMention, isRoughlyVisible, type TimelineTweet } from "./timeline.ts";
import { isHandle, sanitizeTweetUrl, handleFromTweetUrl, tweetIdFromTweetUrl } from "../domain/url.ts";

const EXCLUDED_EVENT = /\b(?:liked|likes|reposted|retweeted|followed you|recommended|you might like)\b|đã thích|thích bài|thích trả lời|đăng lại|đã theo dõi bạn|gợi ý cho bạn/i;
const NEW_POST_EVENT = /\bposted\b|new (?:post|tweet)|post notification|đã đăng|bài đăng mới|đăng bài/i;
const REPLY_EVENT = /replied to (?:you|your (?:post|reply|tweet))|trả lời bạn|trả lời (?:bài đăng|bình luận|bài viết) của bạn/i;
const DIRECT_EVENT = /mentioned you|replied to (?:you|your (?:post|reply|tweet))|nhắc đến bạn|trả lời bạn|trả lời (?:bài đăng|bình luận|bài viết) của bạn/i;
function outsidePostText(cell: Element): string {
  const clone = cell.cloneNode(true) as Element;
  clone.querySelectorAll('article, [data-testid="tweetText"], [data-testid="quoteTweet"], button').forEach(el => el.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}
/** Collect only relevant replies/mentions; never treat a KOL new-post alert as a conversation. */
export function collectNotificationTweets(doc: Document, ownHandle: string, limit = 30): TimelineTweet[] {
  const own = ownHandle.replace(/^@/, '').toLowerCase();
  if (!isHandle(own)) return [];
  const root = doc.querySelector('[data-testid="primaryColumn"]') || doc.querySelector('main');
  if (!root) return [];
  const result: TimelineTweet[] = [], seen = new Set<string>();
  for (const post of collectVisibleTimelineTweets(doc, 50)) {
    const article = findVisibleTimelineTweetArticle(post.tweetId, doc);
    if (!article || !root.contains(article) || post.promoted || post.authorHandle.toLowerCase() === own) continue;
    const cell = article.closest('[data-testid="cellInnerDiv"], [data-testid="notification"]');
    if (cell && EXCLUDED_EVENT.test(outsidePostText(cell))) continue;
    const label = cell ? outsidePostText(cell) : "";
    if (NEW_POST_EVENT.test(label) && !DIRECT_EVENT.test(label)) continue;
    if (!isDirectMention(article, own) && !DIRECT_EVENT.test(label)) continue;
    const replyTarget = [...article.querySelectorAll('a[href]')].some(a =>
      a.closest('article[data-testid="tweet"]') === article && !a.closest('[data-testid="tweetText"], [data-testid="User-Name"], [data-testid="quoteTweet"]') &&
      new RegExp(`^/${own}(?:/status/\\d+)?/?$`, "i").test(a.getAttribute("href") || ""));
    const conversationId = article.getAttribute("data-conversation-id");
    result.push({ ...post, notificationKind: 'direct', directedToOwn: true,
      notificationType: replyTarget || REPLY_EVENT.test(label) ? "reply" : "mention",
      ...(conversationId && /^\d+$/.test(conversationId) ? { conversationId } : {}) }); seen.add(post.tweetId);
    if (result.length >= limit) return result;
  }
  // Some direct notifications are cards rather than tweet articles. Resolve only
  // a single unambiguous permalink, then read the real post after clicking it.
  for (const cell of root.querySelectorAll('[data-testid="cellInnerDiv"], [data-testid="notification"]')) {
    if (cell.querySelector('article[data-testid="tweet"]') || cell.closest('[aria-hidden="true"]') || !isRoughlyVisible(cell)) continue;
    const label = outsidePostText(cell);
    if (EXCLUDED_EVENT.test(label) || !DIRECT_EVENT.test(label)) continue;
    const links = [...new Set([...cell.querySelectorAll('a[href*="/status/"]')].map(a => {
      try { return sanitizeTweetUrl(new URL(a.getAttribute('href') || '', 'https://x.com').href); } catch { return null; }
    }).filter((v): v is string => !!v))];
    if (links.length !== 1) continue;
    const tweetUrl = links[0], tweetId = tweetIdFromTweetUrl(tweetUrl), authorHandle = handleFromTweetUrl(tweetUrl);
    if (!tweetId || !authorHandle || authorHandle.toLowerCase() === own || seen.has(tweetId)) continue;
    result.push({ tweetId, tweetUrl, authorHandle, text: null, alreadyLiked: false, promoted: false,
      notificationKind: 'direct', directedToOwn: true, notificationType: REPLY_EVENT.test(label) ? "reply" : "mention" }); seen.add(tweetId);
    if (result.length >= limit) break;
  }
  return result;
}
