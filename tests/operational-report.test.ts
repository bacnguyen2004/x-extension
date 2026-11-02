import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime, todayKey, type AgentPublicState } from "../src/domain/agent-settings.ts";
import { acknowledgeReports, pendingDailyReports, recordReportRuntime, recordReportStats, recordReportReceipts } from "../src/background/operational-report.ts";
import { agentHeartbeatHealthy } from "../src/background/telegram-ops.ts";
import { makeJob } from "../src/domain/agent-queue.ts";

test("daily reports split rest at Vietnam midnight, count action deltas across resets and deduplicate receipts", async t => {
  const start = Date.parse("2026-10-24T16:59:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const disk: Record<string, unknown> = {};
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: structuredClone(disk[key]) }), set: async (p: object) => Object.assign(disk, structuredClone(p)),
  } } } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const stats = { ...createEmptyDailyStats(), account: "viewer", reply: 5 };
  await recordReportStats(stats);
  await recordReportStats(stats);
  await recordReportStats({ ...stats, reply: 0 });
  await recordReportStats({ ...stats, reply: 2 });
  const runtime = { ...createInitialRuntime(), status: "waiting" as const, adaptiveRest: { activeMs: 100, workCount: 1, reason: "high_load" as const, resumeAt: start + 600000, waitStartedAt: start, creditFrom: null, creditUntil: null } };
  await recordReportRuntime(runtime, "viewer");
  const job = makeJob({ kind: "retweet", source: "pogo", tweetId: "2112057695247180169", authorHandle: "author", tweetUrl: null, tweetText: "Post", verification: "pogo_recorded" });
  await recordReportReceipts("viewer", { jobs: [job, job] });
  t.mock.timers.tick(120000);
  await recordReportRuntime(runtime, "viewer");
  await recordReportReceipts("viewer", { jobs: [{ ...job, updatedAt: Date.now() }] });
  const reports = await pendingDailyReports();
  assert.equal(todayKey(), "2026-10-25");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].counts.reply, 7);
  assert.equal(reports[0].restMs, 60000);
  assert.equal(reports[0].receipts.length, 1);
  await acknowledgeReports([reports[0].id]);
  assert.equal((await pendingDailyReports()).length, 0);
});

test("heartbeat respects scheduled rest and manual pause while detecting overdue work", () => {
  const now = Date.now();
  const agent = { settings: createDefaultAgentSettings(), runtime: { ...createInitialRuntime(), status: "waiting", nextActionAt: now + 20 * 60000 }, today: createEmptyDailyStats() } as AgentPublicState;
  assert.equal(agentHeartbeatHealthy(agent, now), true);
  agent.runtime.nextActionAt = now - 11 * 60000;
  assert.equal(agentHeartbeatHealthy(agent, now), false);
  agent.runtime.status = "paused";
  assert.equal(agentHeartbeatHealthy(agent, now), true);
});
