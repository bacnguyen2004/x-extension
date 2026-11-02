import assert from "node:assert/strict";
import test from "node:test";
import { adaptiveErrorDelay, idlePogoDelay, periodicRest, readAdaptiveRest, recordActiveWork, restProfile, waitForRest } from "../src/domain/adaptive-rest.ts";

const minute = 60000;
test("adaptive profiles respond to backlog and actual work volume", () => {
  assert.deepEqual(restProfile(20, 0), { reason: "high_load", workMs: 30 * minute, restMs: 20 * minute });
  assert.deepEqual(restProfile(5, 0), { reason: "normal_load", workMs: 45 * minute, restMs: 15 * minute });
  assert.deepEqual(restProfile(1, 0), { reason: "low_load", workMs: 60 * minute, restMs: 10 * minute });
  assert.equal(restProfile(0, 30).reason, "high_load");
});
test("productive gaps are credited once, without counting browser downtime or idle time", () => {
  const saved = recordActiveWork(readAdaptiveRest(undefined, 0), 5000, 25000, 5000);
  const woke = readAdaptiveRest(JSON.parse(JSON.stringify(saved)), 3600000);
  assert.equal(woke.activeMs, 30000);
  assert.equal(readAdaptiveRest(woke, 7200000).activeMs, 30000);
  const idle = waitForRest(woke, "no_tasks", 7200000 + 5 * minute, 7200000);
  assert.equal(readAdaptiveRest(idle, 7200000 + minute).activeMs, 30000);
});
test("periodic rest persists its deadline, resets after recovery, and never stacks on natural waits", () => {
  const now = 10000000;
  const active = { ...readAdaptiveRest(undefined, now), activeMs: 30 * minute };
  const rest = periodicRest(active, 20, now);
  assert.equal(rest.resumeAt, now + 20 * minute);
  assert.equal(periodicRest(rest, 20, now + minute).resumeAt, rest.resumeAt);
  assert.equal(readAdaptiveRest(JSON.parse(JSON.stringify(rest)), now + minute).resumeAt, rest.resumeAt);
  assert.equal(readAdaptiveRest(rest, rest.resumeAt!).activeMs, 0);
  const idle = waitForRest(active, "no_tasks", now + 10 * minute, now);
  assert.equal(periodicRest(idle, 20, now + minute).resumeAt, idle.resumeAt);
  const daily = waitForRest(rest, "daily_goal", now + 60 * minute, now + minute);
  assert.equal(daily.resumeAt, now + 60 * minute, "replace deadline rather than adding both waits");
});
test("successive idle checks count as recovery rather than restarting the rest clock", () => {
  const state = { ...readAdaptiveRest(undefined, 0), activeMs: 1800000, workCount: 0 };
  const first = waitForRest(state, "no_tasks", 5 * minute, 0);
  const next = waitForRest(readAdaptiveRest(first, 5 * minute), "no_tasks", 10 * minute, 5 * minute);
  assert.equal(readAdaptiveRest(next, 10 * minute).activeMs, 0);
});
test("network backoff and empty-feed polling are bounded", () => {
  assert.deepEqual([1, 2, 3, 4, 20].map(adaptiveErrorDelay), [1, 2, 5, 15, 15].map(n => n * minute));
  assert.equal(idlePogoDelay(1000, 0), 5 * minute);
  assert.equal(idlePogoDelay(null, 0), 10 * minute);
  assert.equal(idlePogoDelay(50 * minute, 0), 10 * minute);
});
