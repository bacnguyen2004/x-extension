import type { AgentJob } from "./agent-queue.ts";
export const POGO_RETWEET_LIMIT = 10;
export const POGO_RETWEET_EARNING_LIMIT = 20;
const HOUR = 3600000;
export type PogoRetweetPower = { windowStart: number; nextResetAt: number; used: number; observedAt?: number; limit?: number };
/** Fixed Vietnam windows: 01, 07, 13, 19; the 19–01 window crosses midnight. */
export function pogoRetweetWindow(now = Date.now()): { windowStart: number; nextResetAt: number } {
  const windowStart = Math.floor((now + 6 * HOUR) / (6 * HOUR)) * 6 * HOUR - 6 * HOUR;
  return { windowStart, nextResetAt: windowStart + 6 * HOUR };
}
export function pogoRetweetFull(power?: PogoRetweetPower, now = Date.now()): boolean {
  return !!power && power.windowStart === pogoRetweetWindow(now).windowStart && power.used >= (power.limit ?? POGO_RETWEET_LIMIT);
}
export function retweetPolicyError(job: Pick<AgentJob, "kind" | "source">, power?: PogoRetweetPower, homeRetweet = false): string | null {
  if (job.kind !== "retweet") return null;
  if (job.source === "browse") return homeRetweet ? null : "home_retweet_disabled";
  if (job.source !== "pogo") return "retweet_pogo_only";
  return pogoRetweetFull(power) ? "pogo_retweet_window_full" : null;
}
