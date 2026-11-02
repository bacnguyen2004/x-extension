/**
 * Bearer Pogo — memory + chrome.storage.session (sống trong phiên trình duyệt,
 * sống sót khi SW MV3 ngủ/dậy). Không ghi local/disk lâu dài.
 */

const SESSION_KEY = "pogoApiBearerSession";

let apiToken: string | null = null;
let hydratePromise: Promise<void> | null = null;
let revision = 0;
let automaticProvider: ((current: string | null) => Promise<void>) | null = null;
export function setApiSessionProvider(provider: (current: string | null) => Promise<void>): void {
  automaticProvider = provider;
}
export function getApiSessionRevision(): number { return revision; }

async function hydrateFromSession(): Promise<void> {
  if (apiToken) return;
  const before = revision;
  try {
    const raw = await chrome.storage.session.get(SESSION_KEY);
    const v = raw[SESSION_KEY];
    if (revision === before && typeof v === "string" && v.trim()) apiToken = v.trim();
  } catch {
    // storage.session có thể thiếu trên bản Chrome rất cũ.
  }
}

export async function ensureApiSessionHydrated(): Promise<void> {
  if (!hydratePromise) hydratePromise = hydrateFromSession().finally(() => {
    hydratePromise = null;
  });
  await hydratePromise;
}

export function getApiSessionToken(): string | null {
  return apiToken;
}

/** Đồng bộ: đọc memory; nếu trống thì caller nên await ensureApiSessionHydrated trước. */
export async function getApiSessionTokenAsync(): Promise<string | null> {
  await ensureApiSessionHydrated();
  await automaticProvider?.(apiToken);
  return apiToken;
}

export async function setApiSessionToken(token: string | null): Promise<void> {
  revision++;
  apiToken = token && token.trim() ? token.trim() : null;
  try {
    if (apiToken) await chrome.storage.session.set({ [SESSION_KEY]: apiToken });
    else await chrome.storage.session.remove(SESSION_KEY);
  } catch {
    // ignore
  }
}

export async function clearApiSessionToken(): Promise<void> {
  revision++;
  apiToken = null;
  try {
    await chrome.storage.session.remove(SESSION_KEY);
  } catch {
    // ignore
  }
}
