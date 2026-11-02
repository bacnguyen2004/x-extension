const KEY = "xContentCreator.xPageHealth.v1";
type PageHealth = { failures: number; retryAt: number };

export async function xPageRetryDelay(): Promise<number> {
  const saved = (await chrome.storage.local.get(KEY))[KEY] as PageHealth | undefined;
  return saved && Number.isFinite(saved.retryAt) ? Math.max(0, saved.retryAt - Date.now()) : 0;
}

export async function noteXPageReady(ready: boolean): Promise<void> {
  const saved = (await chrome.storage.local.get(KEY))[KEY] as PageHealth | undefined;
  const failures = ready ? 0 : Math.min(3, Math.max(0, Number(saved?.failures) || 0) + 1);
  await chrome.storage.local.set({ [KEY]: { failures, retryAt: failures >= 3 ? Date.now() + 120000 : 0 } });
}
