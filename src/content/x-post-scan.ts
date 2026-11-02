/**
 * Quét bài trên trang profile X — port logic từ x-ai-extenstion/content/posts.js
 * Dùng cho tab SMM (tự đặt đơn khi thiếu view/like).
 */

export interface PostScanThresholds {
  views: number;
  likes: number;
  reposts: number;
  replies: number;
}

export interface ScannedPostPayload {
  id: string;
  username: string;
  url: string;
  views: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  below: string[];
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

export function parseCompactNumber(value: unknown): number | null {
  const match = String(value || "")
    .trim()
    .match(/^([\d.,]+)\s*([KMB])?$/i);
  if (!match) return null;
  const suffix = (match[2] || "").toUpperCase();
  let numberText = match[1];
  if (suffix) {
    const lastSeparator = Math.max(numberText.lastIndexOf("."), numberText.lastIndexOf(","));
    numberText =
      lastSeparator >= 0
        ? `${numberText.slice(0, lastSeparator).replace(/[.,]/g, "")}.${numberText.slice(lastSeparator + 1)}`
        : numberText;
  } else {
    numberText = numberText.replace(/[.,]/g, "");
  }
  const number = Number(numberText);
  if (!Number.isFinite(number)) return null;
  const mult = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1;
  return Math.round(number * mult);
}

function readMetricText(text: string, words: string[]): number | null {
  const source = String(text || "");
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = source.match(new RegExp(`([\\d.,]+\\s*[KMB]?)\\s+${escaped}`, "i"));
    const after = source.match(new RegExp(`${escaped}[^\\d]*([\\d.,]+\\s*[KMB]?)`, "i"));
    const value = parseCompactNumber((before || after)?.[1]);
    if (value !== null) return value;
  }
  return parseCompactNumber(source.trim());
}

function readPostMetric(
  article: Element,
  testId: string,
  words: string[],
): number | null {
  const alternate = ({ like: "unlike", retweet: "unretweet" } as Record<string, string>)[
    testId
  ];
  const element =
    article.querySelector(`[data-testid="${testId}"]`) ||
    (alternate ? article.querySelector(`[data-testid="${alternate}"]`) : null);
  if (!element) return null;
  const aria = element.getAttribute("aria-label") || "";
  const text = textOf(element);
  const value = readMetricText(aria, words) ?? readMetricText(text, words);
  if (value !== null) return value;
  return /\d/.test(`${aria} ${text}`) ? null : 0;
}

function readViewMetric(article: Element): number | null {
  const analytics = article.querySelector('a[href*="/analytics"]');
  const direct = readMetricText(
    `${analytics?.getAttribute("aria-label") || ""} ${textOf(analytics)}`,
    ["view", "lượt xem"],
  );
  if (direct !== null) return direct;
  const group = article.querySelector('[role="group"][aria-label]');
  return readMetricText(group?.getAttribute("aria-label") || "", ["view", "lượt xem"]);
}

function findPostIdentity(
  article: Element,
): { username: string; id: string; url: string } | null {
  for (const link of article.querySelectorAll('a[href*="/status/"]')) {
    try {
      const pathname = new URL((link as HTMLAnchorElement).href, location.origin).pathname;
      const match = pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
      if (match) {
        return {
          username: match[1],
          id: match[2],
          url: `${location.origin}/${match[1]}/status/${match[2]}`,
        };
      }
    } catch {
      /* ignore bad href */
    }
  }
  return null;
}

function metricReasons(
  metrics: Record<string, number | null>,
  thresholds: PostScanThresholds,
): string[] {
  return (Object.keys(thresholds) as Array<keyof PostScanThresholds>).filter(
    (key) =>
      thresholds[key] > 0 && metrics[key] !== null && (metrics[key] as number) < thresholds[key],
  );
}

/** Thu thập bài đang hiện trên profile (primaryColumn). */
export function collectVisibleProfilePosts(
  username: string,
  thresholds: PostScanThresholds,
  existing: Map<string, ScannedPostPayload> = new Map(),
  targetCount = 500,
): Map<string, ScannedPostPayload> {
  const column =
    document.querySelector('[data-testid="primaryColumn"]') ||
    document.querySelector('main[role="main"]') ||
    document.body;
  if (!column) return existing;

  for (const article of column.querySelectorAll('article[data-testid="tweet"]')) {
    const identity = findPostIdentity(article);
    if (!identity || identity.username.toLowerCase() !== username.toLowerCase()) continue;
    if (!existing.has(identity.id) && existing.size >= targetCount) continue;
    const metrics = {
      replies: readPostMetric(article, "reply", ["repl", "trả lời"]),
      reposts: readPostMetric(article, "retweet", ["repost", "retweet", "đăng lại"]),
      likes: readPostMetric(article, "like", ["like", "thích"]),
      views: readViewMetric(article),
    };
    existing.set(identity.id, {
      ...identity,
      ...metrics,
      below: metricReasons(metrics, thresholds),
    });
  }
  return existing;
}

export function scrollProfileBurst(distancePx = 0): number {
  const dy = distancePx > 0 ? distancePx : Math.max(window.innerHeight * 0.85, 650);
  const before = window.scrollY || document.documentElement.scrollTop || 0;
  window.scrollBy({ top: dy, behavior: "auto" });
  const after = window.scrollY || document.documentElement.scrollTop || 0;
  return Math.abs(after - before);
}
