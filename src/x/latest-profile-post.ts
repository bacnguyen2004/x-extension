import { collectVisibleTimelineTweets, type TimelineTweet } from "./timeline.ts";

/** Snowflake order avoids mistaking an older pinned post for the latest post. */
export function latestProfilePost(doc: Document, handle: string): TimelineTweet | null {
  const own = handle.replace(/^@/, "").toLowerCase();
  const posts = collectVisibleTimelineTweets(doc, 100, false).filter(post => {
    if (post.authorHandle.toLowerCase() !== own || post.promoted) return false;
    const article = [...doc.querySelectorAll('article[data-testid="tweet"]')].find(el =>
      !el.parentElement?.closest('article[data-testid="tweet"]') &&
      [...el.querySelectorAll('a[href*="/status/"]')].some(a => a.closest('article[data-testid="tweet"]') === el &&
        new RegExp(`/status/${post.tweetId}(?:[/?#]|$)`).test(a.getAttribute("href") || "")));
    if (!article || article.closest('[hidden], [aria-hidden="true"]') || article.querySelector('[data-testid="replyingTo"]')) return false;
    const context = article.querySelector('[data-testid="socialContext"]')?.textContent || "";
    return !/reposted|retweeted|đã đăng lại|đã trả lời|replied/i.test(context);
  });
  posts.sort((a, b) => BigInt(a.tweetId) > BigInt(b.tweetId) ? -1 : BigInt(a.tweetId) < BigInt(b.tweetId) ? 1 : 0);
  return posts[0] ?? null;
}
