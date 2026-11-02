/**
 * Đồng bộ retweet_power + polling từ snapshot API vào ledger / settlement clock.
 * Cùng thứ tự account với Agent UI (X tab → own → linked).
 */

import type { ScanSnapshot } from "../domain/types.ts";
import { getXConnection } from "./x-bridge.ts";
import { observePogoRetweetPower } from "./pogo-retweet-store.ts";
import { observePogoSettlementClock } from "./pogo-settlement-store.ts";

async function resolveAccount(linkedHandle?: string | null, ownHandle?: string | null): Promise<string> {
  const normalize = (v: string | null | undefined) => (v ?? "").replace(/^@/, "").trim().toLowerCase();
  const x = normalize(getXConnection().handle);
  if (x) return x;
  const own = normalize(ownHandle);
  if (own) return own;
  const linked = normalize(linkedHandle);
  if (linked) return linked;
  try {
    const raw = (await chrome.storage.local.get("pogoTaskReader.state"))["pogoTaskReader.state"] as
      | { linked_account?: { handle?: string } }
      | undefined;
    const fromState = normalize(raw?.linked_account?.handle);
    if (fromState) return fromState;
  } catch { /* ignore */ }
  return "unknown";
}

export async function syncPogoFeedMeta(
  snapshot: ScanSnapshot,
  opts?: { ownHandle?: string | null; publish?: () => void },
): Promise<void> {
  const account = await resolveAccount(snapshot.linked_account?.handle, opts?.ownHandle);
  if (account === "unknown") return;

  let changed = false;
  const remaining = snapshot.retweet_remaining;
  const earning = snapshot.retweet_earning_remaining;
  if (typeof remaining === "number") {
    await observePogoRetweetPower(account, remaining, typeof earning === "number" ? earning : undefined);
    changed = true;
  }
  const nextScan = snapshot.polling_next_scan_at;
  if (typeof nextScan === "number" && (await observePogoSettlementClock(account, nextScan))) {
    changed = true;
  }
  if (changed) opts?.publish?.();
}
