import { pogoSettlementCheckAt, type PogoSettlementClock } from "../domain/pogo-settlement.ts";

const KEY = "xContentCreator.pogoSettlementClock.v1";
const accountKey = (account: string) => account.replace(/^@/, "").trim().toLowerCase() || "unknown";

export async function loadPogoSettlementClock(account: string): Promise<PogoSettlementClock | null> {
  const key = `${KEY}.${accountKey(account)}`;
  const saved = (await chrome.storage.local.get(key))[key] as PogoSettlementClock | undefined;
  return saved && Number.isFinite(saved.nextScanAt) && Number.isFinite(saved.observedAt) && Date.now() - saved.observedAt < 86400000 ? saved : null;
}

export async function observePogoSettlementClock(account: string, nextScanAt: unknown): Promise<boolean> {
  if (accountKey(account) === "unknown" || typeof nextScanAt !== "number" || !Number.isFinite(nextScanAt) ||
      nextScanAt < Date.now() - 60000 || nextScanAt > Date.now() + 660000) return false;
  const previous = await loadPogoSettlementClock(account);
  if (previous?.nextScanAt === nextScanAt && Date.now() - previous.observedAt < 30000) return false;
  await chrome.storage.local.set({ [`${KEY}.${accountKey(account)}`]: { nextScanAt, observedAt: Date.now() } });
  return true;
}

export async function nextPogoSettlementCheck(account: string, submittedAt = Date.now()): Promise<number> {
  return pogoSettlementCheckAt(submittedAt, await loadPogoSettlementClock(account));
}
