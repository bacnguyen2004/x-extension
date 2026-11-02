import { findTweetArticle, sleep } from "./dom-utils.ts";

export function readingDuration(text: string, minMs: number, maxMs: number): number {
  const min = Math.max(8000, Math.min(60000, Number.isFinite(minMs) ? minMs : 8000));
  const max = Math.max(min, Math.min(60000, Number.isFinite(maxMs) ? maxMs : 18000));
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(min, Math.min(max, words * 250));
}

/** Bring the actual target into view, allow reading time, then reveal its actions. */
export async function readTweet(tweetId: string, minMs: number, maxMs: number): Promise<boolean> {
  const article = findTweetArticle(tweetId);
  if (!article) return false;
  article.scrollIntoView?.({ behavior: "smooth", block: "start" });
  await sleep(800);
  const text = article.querySelector('[data-testid="tweetText"]')?.textContent || article.textContent || "";
  await sleep(readingDuration(text, minMs, maxMs));
  const action = article.querySelector('[data-testid="reply"], [data-testid="like"], [data-testid="unlike"]');
  action?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  await sleep(800);
  return true;
}
