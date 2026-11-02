import { todayKey, type AgentDailyStats, type AgentRuntime } from "../domain/agent-settings.ts";
import type { AgentQueueState } from "../domain/agent-queue.ts";

const KEY = "xContentCreator.operationalReport.v1";
const METRICS = ["reply", "quote", "retweet", "follow", "like"] as const;
type Counts = Record<typeof METRICS[number], number>;
export interface DailyReport {
  id: string; date: string; account: string; counts: Counts; errors: number; warnings: number; restMs: number;
  receipts: string[]; delivered?: boolean;
}
interface Ledger {
  days: Record<string, DailyReport>;
  baselines: Record<string, { date: string; counts: Counts }>;
  lastRuntime?: { at: number; account: string; restingUntil: number | null };
}
let tail: Promise<unknown> = Promise.resolve();
const normalize = (s: string) => s.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 15) || "unknown";
function row(ledger: Ledger, account: string, date: string): DailyReport {
  const id = `${normalize(account)}:${date}`;
  return ledger.days[id] ??= { id, account: normalize(account), date, counts: { reply: 0, quote: 0, retweet: 0, follow: 0, like: 0 }, errors: 0, warnings: 0, restMs: 0, receipts: [] };
}
function update(fn: (ledger: Ledger) => void): Promise<void> {
  const result = tail.then(async () => {
    const saved = (await chrome.storage.local.get(KEY))[KEY] as Ledger | undefined;
    const ledger = saved?.days && saved?.baselines ? saved : { days: {}, baselines: {} };
    fn(ledger);
    const cutoff = Date.now() - 8 * 86400000;
    for (const [id, report] of Object.entries(ledger.days)) if (Date.parse(`${report.date}T00:00:00+07:00`) < cutoff) delete ledger.days[id];
    await chrome.storage.local.set({ [KEY]: ledger });
  }).catch(() => {});
  tail = result; return result;
}
export function recordReportStats(stats: AgentDailyStats): Promise<void> {
  return update(ledger => {
    const account = normalize(stats.account || "unknown");
    const report = row(ledger, account, stats.date);
    const previous = ledger.baselines[account];
    const counts = Object.fromEntries(METRICS.map(k => [k, Math.max(0, Number(stats[k]) || 0)])) as Counts;
    for (const key of METRICS) report.counts[key] += Math.max(0, counts[key] - (previous?.date === stats.date ? previous.counts[key] : 0));
    ledger.baselines[account] = { date: stats.date, counts };
  });
}
export function recordReportRuntime(runtime: AgentRuntime, account: string): Promise<void> {
  return update(ledger => {
    const now = Date.now(), previous = ledger.lastRuntime;
    // Do not invent uptime/rest while Chrome was offline or the worker was stalled.
    if (previous?.restingUntil && now - previous.at <= 5 * 60000 && now >= previous.at) {
      let at = previous.at;
      const end = Math.min(now, previous.restingUntil);
      while (at < end) {
        const date = todayKey(new Date(at));
        const boundary = Date.parse(`${date}T00:00:00+07:00`) + 86400000;
        const until = Math.min(end, boundary);
        row(ledger, previous.account, date).restMs += until - at;
        at = until;
      }
    }
    ledger.lastRuntime = { at: now, account: normalize(account), restingUntil: runtime.status === "waiting" && !runtime.killSwitch ? runtime.adaptiveRest?.resumeAt ?? null : null };
  });
}
export function recordReportIssue(account: string, level: "warn" | "error"): Promise<void> {
  return update(ledger => { const report = row(ledger, account, todayKey()); report[level === "error" ? "errors" : "warnings"]++; });
}
export function recordReportReceipts(account: string, queue: AgentQueueState): Promise<void> {
  return update(ledger => {
    for (const job of queue.jobs) {
      if (job.source !== "pogo" || job.verification !== "pogo_recorded" || !job.tweetId || !["post_reply", "post_quote", "retweet"].includes(job.kind)) continue;
      const date = todayKey(new Date(job.updatedAt));
      const key = `${job.tweetId}:${job.kind}`;
      if (Object.values(ledger.days).some(r => r.account === normalize(account) && r.receipts.includes(key))) continue;
      const report = row(ledger, account, date);
      if (!report.receipts.includes(key) && report.receipts.length < 10000) report.receipts.push(key);
    }
  });
}
export async function pendingDailyReports(): Promise<DailyReport[]> {
  await tail;
  const ledger = (await chrome.storage.local.get(KEY))[KEY] as Ledger | undefined;
  return Object.values(ledger?.days || {}).filter(r => r.date < todayKey() && !r.delivered &&
    (Object.values(r.counts).some(n => n > 0) || r.errors || r.warnings || r.restMs || r.receipts.length))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 1);
}
export function acknowledgeReports(ids: string[]): Promise<void> {
  return update(ledger => { for (const id of ids) if (ledger.days[id]) ledger.days[id].delivered = true; });
}
