import { pogoRetweetWindow, POGO_RETWEET_LIMIT, POGO_RETWEET_EARNING_LIMIT, type PogoRetweetPower } from "../domain/pogo-retweet.ts";
import type { AgentJob } from "../domain/agent-queue.ts";
import type { XActionResult } from "./x-bridge.ts";

const KEY = "xContentCreator.pogoRetweetPower.v1";
/** API feed observation stays "synced" this long (SW sleep không mất disk observedAt). */
const OBSERVED_FRESH_MS = 30 * 60 * 1000;
type Ledger = {
  windowStart: number;
  observedAt?: number;
  observedUsed?: number;
  observedItems?: number;
  /** Last API/UI remaining; used to recover from a false 0 reading. */
  lastRemaining?: number;
  lastEarningRemaining?: number;
  limit?: number;
  items: { tweetId: string; state: "reserved" | "submitted" | "uncertain" }[];
};
function used(ledger: Ledger): number {
  return Math.max(ledger.items.length, (ledger.observedUsed ?? 0) + ledger.items.length - (ledger.observedItems ?? 0));
}
/**
 * Prefer API (or UI) remaining, but keep tool clicks durable.
 * Same or lower remaining stays monotonic (stale reading cannot refill).
 * Higher remaining can correct a false exhaustion, never below items.length.
 */
export function observePogoRetweetPower(account: string, remaining: unknown, earningRemaining?: unknown): Promise<void> {
  const result = tail.then(async () => {
    if (accountKey(account) === "unknown" || typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0 || remaining > 10) return;
    if (earningRemaining != null && (typeof earningRemaining !== "number" || !Number.isInteger(earningRemaining) || earningRemaining < 0 || earningRemaining > 20 || Math.max(0, earningRemaining - 10) !== remaining)) return;
    const ledger = await load(account);
    const fromUi = typeof earningRemaining === "number" ? POGO_RETWEET_EARNING_LIMIT - earningRemaining : POGO_RETWEET_LIMIT - remaining;
    const current = used(ledger);
    // Only unwind a false empty reading. Stale same/lower remaining stays monotonic.
    const recoverFalseEmpty = ledger.lastRemaining === 0 && remaining > 0 && ledger.lastEarningRemaining == null;
    ledger.observedUsed = recoverFalseEmpty
      ? Math.max(ledger.items.length, fromUi)
      : Math.max(current, fromUi);
    ledger.observedItems = ledger.items.length;
    ledger.lastRemaining = remaining;
    if (typeof earningRemaining === "number") {
      ledger.lastEarningRemaining = earningRemaining;
      ledger.limit = POGO_RETWEET_EARNING_LIMIT;
    }
    ledger.observedAt = Date.now();
    await save(account, ledger);
  });
  tail = result.catch(() => {});
  return result;
}
let tail: Promise<unknown> = Promise.resolve();
function accountKey(account: string): string { return account.replace(/^@/, "").trim().toLowerCase() || "unknown"; }
async function load(account: string): Promise<Ledger> {
  const key = `${KEY}.${accountKey(account)}`, { windowStart } = pogoRetweetWindow();
  const saved = (await chrome.storage.local.get(key))[key] as Ledger | undefined;
  if (saved) return saved.windowStart === windowStart ? saved : { windowStart, items: [] };
  if (accountKey(account) === "unknown") return { windowStart, items: [] };
  const stats = (await chrome.storage.local.get("xContentCreator.agentStats.v1"))["xContentCreator.agentStats.v1"] as { account?: string } | undefined;
  const queue = (await chrome.storage.local.get("xContentCreator.agentQueue.v1"))["xContentCreator.agentQueue.v1"] as { jobs?: AgentJob[] } | undefined;
  const seen = new Set<string>();
  const items = (stats?.account === accountKey(account) ? queue?.jobs ?? [] : []).filter(job => job.source === "pogo" && job.kind === "retweet" && job.tweetId && job.updatedAt >= windowStart &&
    (job.status === "done" || job.status === "running" || ["submitted", "uncertain", "x_confirmed", "pogo_recorded"].includes(job.verification ?? "")))
    .filter(job => { if (seen.has(job.tweetId!)) return false; seen.add(job.tweetId!); return true; })
    .map(job => ({ tweetId: job.tweetId!, state: "uncertain" as const }));
  const ledger = { windowStart, items };
  await save(account, ledger);
  return ledger;
}
async function save(account: string, ledger: Ledger): Promise<void> {
  await chrome.storage.local.set({ [`${KEY}.${accountKey(account)}`]: ledger });
}
export async function loadPogoRetweetPower(account: string): Promise<PogoRetweetPower> {
  const result = tail.then(async () => {
    const ledger = await load(account);
    const at = ledger.observedAt;
    const fresh = at != null && Date.now() - at < OBSERVED_FRESH_MS;
    return { ...pogoRetweetWindow(), used: used(ledger), ...(ledger.limit ? { limit: ledger.limit } : {}), ...(fresh ? { observedAt: at } : {}) };
  });
  tail = result.catch(() => {});
  return result;
}
export function guardedPogoRetweet(job: AgentJob, account: string, cancelled: () => boolean, action: () => Promise<XActionResult>): Promise<XActionResult> {
  const run = async (): Promise<XActionResult> => {
    if (job.source !== "pogo") return { ok: false, error: "retweet_pogo_only" };
    if (accountKey(account) === "unknown" || !job.tweetId) return { ok: false, error: "retweet_identity_missing" };
    const ledger = await load(account);
    if (ledger.items.some(item => item.tweetId === job.tweetId)) return { ok: false, error: "pogo_retweet_already_attempted" };
    if (used(ledger) >= (ledger.limit ?? POGO_RETWEET_LIMIT)) return { ok: false, error: "pogo_retweet_window_full" };
    if (cancelled()) return { ok: false, error: "stopped" };
    const item: Ledger["items"][number] = { tweetId: job.tweetId, state: "reserved" };
    ledger.items.push(item); await save(account, ledger);
    if (cancelled()) { ledger.items.pop(); await save(account, ledger); return { ok: false, error: "stopped" }; }
    let result: XActionResult;
    try { result = await action(); } catch { result = { ok: false, error: "retweet_submission_uncertain" }; }
    const noClick = result.detail === "already_retweeted" || (!result.ok &&
      (/navigat/.test(result.error ?? "") || ["no_x_tab", "busy", "tweet_not_found", "tweet_unavailable", "retweet_btn_missing", "retweet_click_failed", "retweet_confirm_missing"].includes(result.error ?? "")));
    if (noClick) ledger.items = ledger.items.filter(entry => entry !== item);
    else item.state = result.ok ? "submitted" : "uncertain";
    await save(account, ledger);
    return result;
  };
  const result = tail.then(run, run); tail = result.catch(() => {}); return result;
}
