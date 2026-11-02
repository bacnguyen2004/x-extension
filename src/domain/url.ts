const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID_RE = /^\d{8,22}$/;

export function isTweetId(value: string | null | undefined): value is string {
  return typeof value === "string" && TWEET_ID_RE.test(value);
}

export function isHandle(value: string | null | undefined): value is string {
  return typeof value === "string" && HANDLE_RE.test(value);
}

export function constructTweetUrl(handle: string, tweetId: string): string | null {
  if (!isHandle(handle) || !isTweetId(tweetId)) return null;
  return `https://x.com/${handle}/status/${tweetId}`;
}

/** Chỉ chấp nhận HTTPS x.com / twitter.com status URL. */
export function sanitizeTweetUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "x.com" && host !== "www.x.com" && host !== "twitter.com" && host !== "www.twitter.com") {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const handle = parts[0];
  if (parts[1].toLowerCase() !== "status") return null;
  const id = parts[2];
  if (!isHandle(handle) || !isTweetId(id)) return null;
  return `https://x.com/${handle}/status/${id}`;
}

/** Parse handle từ URL status đã sanitize. */
export function handleFromTweetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const handle = parts[0];
    return isHandle(handle) ? handle : null;
  } catch {
    return null;
  }
}

/** Parse tweet id từ URL status đã sanitize. */
export function tweetIdFromTweetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const id = parts[2];
    return isTweetId(id) ? id : null;
  } catch {
    return null;
  }
}

const MAX_LINK_LIST = 200;

/** Bỏ dấu ẩn / isolate / zero-width thường gặp khi copy từ Telegram/chat. */
export function stripInvisibleUrlNoise(text: string): string {
  return String(text || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/[\u00A0\u202F]/g, " ");
}

/**
 * Tìm mọi URL status x.com|twitter.com trong text lộn xộn
 * (chat Telegram, reply quote, timestamp, emoji…).
 */
const STATUS_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{8,22}/gi;

/**
 * Chuẩn hóa list link từ text dán.
 * Bóc URL status dù nằm giữa chat log; bỏ trùng theo tweet id.
 */
export function parseTweetUrlList(text: string, limit = MAX_LINK_LIST): string[] {
  const cleaned = stripInvisibleUrlNoise(text);
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string): boolean => {
    let candidate = raw.trim().replace(/^[<(["'`]+/, "").replace(/[>)\]"'`,.;!?]+$/, "");
    if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
    const safe = sanitizeTweetUrl(candidate);
    if (!safe) return false;
    const id = tweetIdFromTweetUrl(safe);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    out.push(safe);
    return out.length >= limit;
  };

  for (const match of cleaned.matchAll(STATUS_URL_RE)) {
    if (push(match[0]!)) return out;
  }

  // Fallback: token tách khoảng trắng (list sạch / copy từng dòng).
  if (!out.length) {
    for (const part of cleaned.split(/[\s,;]+/)) {
      if (!part) continue;
      if (push(part)) return out;
    }
  }

  return out;
}

export { MAX_LINK_LIST };
