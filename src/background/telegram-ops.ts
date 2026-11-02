import type { AgentPublicState } from "../domain/agent-settings.ts";
import { restReasonLabel } from "../domain/adaptive-rest.ts";
import { acknowledgeReports, pendingDailyReports, recordReportRuntime, recordReportStats } from "./operational-report.ts";

export const TELEGRAM_OPS_ALARM = "telegram-ops-minute";
let running = false;
export function agentHeartbeatHealthy(agent: AgentPublicState, now = Date.now()): boolean {
  if (!["running", "waiting"].includes(agent.runtime.status) || agent.runtime.killSwitch) return true;
  const due = agent.runtime.nextActionAt ?? agent.runtime.startedAt;
  return due != null && now - due < 10 * 60000;
}
export async function runTelegramOps(agent: AgentPublicState, pogo: { present: boolean; loginRequired: boolean; authError?: string | null }): Promise<void> {
  if (running) return;
  running = true;
  try {
    const account = agent.x.handle || agent.settings.ownHandle || agent.today.account || "unknown";
    await recordReportStats({ ...agent.today, account });
    await recordReportRuntime(agent.runtime, account);
    const reports = await pendingDailyReports();
    const rest = agent.runtime.adaptiveRest;
    const message = { action: "telemetry", snapshot: {
      account, status: agent.runtime.status, killSwitch: agent.runtime.killSwitch, connected: agent.x.connected,
      resumeAt: agent.runtime.status === "waiting" ? rest?.resumeAt ?? agent.runtime.nextActionAt : null,
      restReason: rest?.reason ? restReasonLabel(rest.reason) : null,
      pogoReady: pogo.present && !pogo.loginRequired && !pogo.authError,
      counters: Object.fromEntries(["reply", "quote", "retweet", "follow", "like"].map(k => [k, agent.today[k as "reply"]])),
      rtRemaining: agent.today.pogoRetweets ? Math.max(0, agent.today.pogoRetweets.limit! - agent.today.pogoRetweets.used) : null,
      pendingReceipts: agent.pogoSettlement?.pendingCount ?? 0,
      healthy: agentHeartbeatHealthy(agent),
    }, reports: reports.map(r => ({ id: r.id, account: r.account, date: r.date, counters: r.counts,
      errors: r.errors, warnings: r.warnings, restMinutes: Math.floor(r.restMs / 60000), pogoRecorded: r.receipts.length })) };
    const reply = await new Promise<{ reported?: string[] }>(resolve => {
      const timer = setTimeout(() => resolve({}), 55000);
      Promise.resolve().then(() => chrome.runtime.sendNativeMessage("com.xcontentcreator.pogo_auth", message))
        .then(value => { clearTimeout(timer); resolve(value || {}); }, () => { clearTimeout(timer); resolve({}); });
    });
    if (Array.isArray(reply.reported)) await acknowledgeReports(reply.reported.filter(id => reports.some(r => r.id === id)));
  } catch { /* Monitoring must not block the agent. */ }
  finally { running = false; }
}
