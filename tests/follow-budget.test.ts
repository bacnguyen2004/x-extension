import assert from "node:assert/strict";
import test from "node:test";
import { guardedFollow, loadFollowUsage } from "../src/background/follow-budget.ts";
import { createDefaultAgentSettings, todayKey } from "../src/domain/agent-settings.ts";

test("both runners share an atomic daily Follow budget, migrate counts and isolate accounts", async t => {
  const disk: Record<string, unknown> = {
    "xContentCreator.agentStats.v1": { date: todayKey(), account: "alice", follow: 1 },
    "xContentCreator.followRuntime.v1": { day: todayKey(), followedToday: 1, followTimestamps: [] },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); },
  } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const settings = createDefaultAgentSettings(); settings.dailyTargets!.ranges.follow = { min: 3, max: 3 };
  disk["xContentCreator.agentSettings.v1"] = settings;
  assert.equal((await loadFollowUsage("unknown")).count, 0);
  assert.equal((await loadFollowUsage("alice")).count, 2);
  let clicks = 0;
  const action = async () => { clicks++; return { ok: true, detail: "follow_confirmed" }; };
  const results = await Promise.all(["agent", "follow"].map(origin => guardedFollow({ account: () => "alice", cancelled: () => false,
    origin: origin as "agent" | "follow", action })));
  assert.equal(clicks, 1); assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal((await loadFollowUsage("alice")).count, 3);
  assert.equal((await loadFollowUsage("bob")).count, 0);
  await guardedFollow({ account: () => "bob", cancelled: () => false, origin: "agent", action: async () => ({ ok: true, detail: "already_following" }) });
  assert.equal((await loadFollowUsage("bob")).count, 0);
  await guardedFollow({ account: () => "bob", cancelled: () => false, origin: "follow", action: async () => ({ ok: false, error: "follow_not_confirmed" }) });
  assert.equal((await loadFollowUsage("bob")).count, 0);
  await guardedFollow({ account: () => "bob", cancelled: () => false, origin: "follow", action: async () => ({ ok: true, detail: "follow_requested" }) });
  assert.equal((await loadFollowUsage("bob")).count, 1);
  const key = "xContentCreator.sharedFollow.v1.bob";
  disk[key] = { account: "bob", day: todayKey(), count: 1, timestamps: Array(14).fill(Date.now()) };
  const limited = await guardedFollow({ account: () => "bob", cancelled: () => false, origin: "agent", action });
  assert.equal("error" in limited && limited.error, "follow_rate_30m"); assert.equal(clicks, 1);
  disk[key] = { account: "bob", day: "2000-01-01", count: 999, timestamps: [] };
  assert.equal((await loadFollowUsage("bob")).count, 0);
});

test("shared Follow budget retains the 30 minute window across midnight", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const disk: Record<string, unknown> = {
    "xContentCreator.sharedFollow.v1.me": { account: "me", day: "2000-01-01", count: 999, timestamps: [now - 1000] },
    "xContentCreator.follow.v1": { pace: { maxPer30Min: 1 } },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => Object.assign(disk, patch),
  } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  let clicks = 0;
  const options = { account: () => "me", cancelled: () => false, origin: "follow" as const,
    action: async () => { clicks++; return { ok: true, detail: "follow_confirmed" }; } };
  const usage = await loadFollowUsage("me");
  assert.equal(usage.count, 0);
  assert.equal(usage.timestamps.length, 1);
  assert.equal((await guardedFollow(options)).ok, false);
  assert.equal(clicks, 0);
  now += 1800000;
  assert.equal((await guardedFollow(options)).ok, true);
  assert.equal(clicks, 1);
  assert.equal((await loadFollowUsage("me")).count, 1);
});
