/**
 * Fetch + cache điểm Sorsa (public API, giống X68 — không cần ApiKey).
 */

const CACHE_KEY = "xContentCreator.sorsaCache.v1";
/** Key cũ lưu ApiKey — dọn khi SW chạy. */
const LEGACY_SETTINGS_KEY = "xContentCreator.sorsa.v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_CACHE = 500;

interface CacheEntry {
  score: number | null;
  at: number;
  error?: string;
}

type CacheMap = Record<string, CacheEntry>;

async function loadCache(): Promise<CacheMap> {
  const raw = await chrome.storage.local.get(CACHE_KEY);
  const c = raw[CACHE_KEY];
  if (!c || typeof c !== "object") return {};
  return c as CacheMap;
}

async function saveCache(map: CacheMap): Promise<void> {
  const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at);
  const trimmed: CacheMap = {};
  for (const [k, v] of entries.slice(0, MAX_CACHE)) trimmed[k] = v;
  await chrome.storage.local.set({ [CACHE_KEY]: trimmed });
}

let legacyCleared = false;
async function clearLegacyApiKeyStorage(): Promise<void> {
  if (legacyCleared) return;
  legacyCleared = true;
  try {
    await chrome.storage.local.remove(LEGACY_SETTINGS_KEY);
  } catch {
    /* ignore */
  }
}

const memoryCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<{ ok: boolean; score?: number | null; error?: string }>>();

function normalizeHandle(username: string): string {
  return username.replace(/^@/, "").trim().toLowerCase();
}

function rememberScore(
  handle: string,
  score: number | null,
  disk: CacheMap,
): { ok: true; score: number | null } {
  const entry: CacheEntry = { score, at: Date.now() };
  memoryCache.set(handle, entry);
  disk[handle] = entry;
  void saveCache(disk);
  return { ok: true, score };
}

type PublicAccountHit = {
  screen_name?: string;
  score_value?: number;
  score?: number;
};

/**
 * Public API (không cần ApiKey) — đúng cách X68/CHEOX68:
 * GET /v1/accounts/search?query={handle}&type=twitter → score_value
 * 400 = not_indexed.
 */
async function fetchScorePublicV1(
  handle: string,
  disk: CacheMap,
): Promise<{ ok: boolean; score?: number | null; error?: string }> {
  try {
    const url = `https://api.sorsa.io/v1/accounts/search?query=${encodeURIComponent(handle)}&type=twitter`;
    const controller = new AbortController();
    // Check nhanh — 15s làm Unfollow/Follow kẹt từng acc.
    const timer = setTimeout(() => controller.abort(), 3_500);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) return { ok: false, error: "rate_limited" };
    if (res.status === 400) return rememberScore(handle, null, disk);
    if (!res.ok) return { ok: false, error: `public_search_${res.status}` };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: "bad_json" };
    }

    const list: PublicAccountHit[] = Array.isArray(body)
      ? (body as PublicAccountHit[])
      : Array.isArray((body as { data?: unknown })?.data)
        ? (body as { data: PublicAccountHit[] }).data
        : body
          ? [body as PublicAccountHit]
          : [];

    const wanted = handle.toLowerCase();
    const match =
      list.find(
        (a) => typeof a?.screen_name === "string" && a.screen_name.toLowerCase() === wanted,
      ) || (list.length === 1 && typeof list[0]?.screen_name !== "string" ? list[0] : undefined);

    const raw = Number(match?.score_value ?? match?.score ?? NaN);
    if (!Number.isFinite(raw) || raw <= 0) {
      return rememberScore(handle, null, disk);
    }
    const score = Math.round(raw * 100) / 100;
    return rememberScore(handle, score, disk);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Cache null khi timeout/lỗi mạng — tránh gọi lại 3.5s mỗi lần check cùng handle.
    if (/abort/i.test(msg)) return rememberScore(handle, null, disk);
    return rememberScore(handle, null, disk);
  }
}

/** Lấy Sorsa Score qua public search (giống X68). */
export async function fetchSorsaScore(
  username: string,
): Promise<{ ok: boolean; score?: number | null; error?: string; cached?: boolean }> {
  void clearLegacyApiKeyStorage();

  const handle = normalizeHandle(username);
  if (!handle || !/^[a-z0-9_]{1,15}$/i.test(handle)) {
    return { ok: false, error: "bad_username" };
  }

  const mem = memoryCache.get(handle);
  if (mem && Date.now() - mem.at < CACHE_TTL_MS) {
    if (mem.error && mem.score == null) return { ok: false, error: mem.error, cached: true };
    return { ok: true, score: mem.score, cached: true };
  }

  const disk = await loadCache();
  const diskEntry = disk[handle];
  if (diskEntry && Date.now() - diskEntry.at < CACHE_TTL_MS) {
    memoryCache.set(handle, diskEntry);
    if (diskEntry.error && diskEntry.score == null) {
      return { ok: false, error: diskEntry.error, cached: true };
    }
    return { ok: true, score: diskEntry.score, cached: true };
  }

  const existing = inflight.get(handle);
  if (existing) return existing;

  const job = (async () => {
    try {
      const publicHit = await fetchScorePublicV1(handle, disk);
      return publicHit.ok ? publicHit : { ok: false, error: publicHit.error || "unavailable" };
    } finally {
      inflight.delete(handle);
    }
  })();

  inflight.set(handle, job);
  return job;
}

const BATCH_CONCURRENCY = 12;

/** Batch lookup — cache hit trả ngay, fetch song song phần thiếu. */
export async function fetchSorsaScoresBatch(usernames: string[]): Promise<{
  ok: boolean;
  scores: Record<string, { score: number | null } | { error: string }>;
  error?: string;
}> {
  void clearLegacyApiKeyStorage();

  const scores: Record<string, { score: number | null } | { error: string }> = {};
  const unique = [
    ...new Set(
      usernames
        .map((u) => normalizeHandle(u))
        .filter((h) => h && /^[a-z0-9_]{1,15}$/i.test(h)),
    ),
  ];
  if (unique.length === 0) return { ok: true, scores };

  const disk = await loadCache();
  const now = Date.now();
  const needFetch: string[] = [];

  for (const handle of unique) {
    const mem = memoryCache.get(handle);
    if (mem && now - mem.at < CACHE_TTL_MS) {
      if (mem.error && mem.score == null) scores[handle] = { error: mem.error };
      else scores[handle] = { score: mem.score };
      continue;
    }
    const diskEntry = disk[handle];
    if (diskEntry && now - diskEntry.at < CACHE_TTL_MS) {
      memoryCache.set(handle, diskEntry);
      if (diskEntry.error && diskEntry.score == null) scores[handle] = { error: diskEntry.error };
      else scores[handle] = { score: diskEntry.score };
      continue;
    }
    needFetch.push(handle);
  }

  let i = 0;
  async function worker(): Promise<void> {
    while (i < needFetch.length) {
      const handle = needFetch[i++]!;
      const existing = inflight.get(handle);
      const result = existing ? await existing : await fetchSorsaScore(handle);
      if (result.ok) {
        scores[handle] = { score: result.score ?? null };
      } else {
        scores[handle] = { error: result.error || "error" };
      }
    }
  }

  if (needFetch.length > 0) {
    const workers = Array.from(
      { length: Math.min(BATCH_CONCURRENCY, needFetch.length) },
      () => worker(),
    );
    await Promise.all(workers);
  }

  return { ok: true, scores };
}
