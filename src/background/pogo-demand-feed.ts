import { fetchPogoFeed } from "../api/feed-client.ts";
import { getApiSessionRevision, getApiSessionTokenAsync } from "./api-session.ts";
import { applyPogoFeedRefresh, reportPogoFeedError } from "./pogo-state-access.ts";
import { maybeAutoJoinPogoBounties } from "./pogo-bounty-store.ts";
import type { Campaign } from "../domain/types.ts";
import { adaptiveErrorDelay, idlePogoDelay } from "../domain/adaptive-rest.ts";

const KEY = "pogoDemandPullAfter";
export type PogoPull = { kind: "updated" | "waiting" | "no_token" | "login_required" | "failed"; campaigns?: Campaign[]; retryAt?: number; waitReason?: "errors" | "no_tasks" };
let nextAt = 0, failures = 0;
let inFlight: Promise<PogoPull> | null = null;
/** A verification refresh already fetched the same feed for this tick. */
export async function deferPogoDemandPull(ms = 30000): Promise<void> {
  nextAt = Math.max(nextAt, Date.now() + ms);
  await persist();
}
export async function resetPogoDemandPull(): Promise<void> {
  nextAt = 0; failures = 0;
  try { await chrome.storage.local.remove(KEY); } catch { /* Memory fallback. */ }
}
export function pullPogoWhenEmpty(cancelled: () => boolean): Promise<PogoPull> {
  if (inFlight) return inFlight;
  const request = pull(cancelled).finally(() => { if (inFlight === request) inFlight = null; });
  inFlight = request; return request;
}
async function pull(cancelled: () => boolean): Promise<PogoPull> {
  try {
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    if (saved?.nextAt > nextAt) { nextAt = saved.nextAt; failures = saved.failures || 0; }
  } catch { /* Memory fallback. */ }
  const token = await getApiSessionTokenAsync();
  if (!token) return { kind: "no_token" };
  const state = (await chrome.storage.local.get("pogoTaskReader.state"))["pogoTaskReader.state"];
  if (state?.login_required) return { kind: "login_required" };
  if (cancelled() || Date.now() < nextAt) return { kind: "waiting", retryAt: nextAt, waitReason: failures > 0 ? "errors" : "no_tasks" };
  const revision = getApiSessionRevision();
  // Reserve before fetching so sleeping workers don't pull repeatedly.
  nextAt = Date.now() + 30000;
  await persist();
  const result = await fetchPogoFeed(token, { resolveIdentity: false });
  if (cancelled() || revision !== getApiSessionRevision()) return { kind: "waiting" };
  if (!result.ok) {
    failures++;
    nextAt = Date.now() + adaptiveErrorDelay(failures);
    await persist();
    await reportPogoFeedError(result.login_required, result.httpStatus);
    return { kind: result.login_required ? "login_required" : "failed", retryAt: nextAt, waitReason: "errors" };
  }
  failures = 0;
  nextAt = Date.now() + idlePogoDelay(result.snapshot.polling_next_scan_at, Date.now());
  await persist();
  const campaigns = await applyPogoFeedRefresh(result.snapshot);
  void maybeAutoJoinPogoBounties();
  return { kind: "updated", campaigns, retryAt: nextAt, waitReason: "no_tasks" };
}
async function persist(): Promise<void> {
  try { await chrome.storage.local.set({ [KEY]: { nextAt, failures } }); } catch { /* Memory fallback. */ }
}
