export const POGO_SETTLEMENT_INTERVAL_MS = 10 * 60 * 1000;
export const POGO_SETTLEMENT_GRACE_MS = 20 * 1000;
export type PogoSettlementClock = { nextScanAt: number; observedAt: number };

/** Use the observed scan boundary; submissions after it belong to the next scan. */
export function pogoSettlementCheckAt(submittedAt: number, clock: PogoSettlementClock | null): number {
  if (!clock) return submittedAt + POGO_SETTLEMENT_INTERVAL_MS + POGO_SETTLEMENT_GRACE_MS;
  const cycles = Math.floor((submittedAt - clock.nextScanAt) / POGO_SETTLEMENT_INTERVAL_MS) + 1;
  return clock.nextScanAt + cycles * POGO_SETTLEMENT_INTERVAL_MS + POGO_SETTLEMENT_GRACE_MS;
}
