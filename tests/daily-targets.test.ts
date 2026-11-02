import assert from "node:assert/strict";
import test from "node:test";
import { allDailyTargetsReached, dailyActionReached, dailyTarget, withDailyTargets } from "../src/domain/daily-targets.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, defaultDailyTargets, sanitizeAgentSettings, todayKey } from "../src/domain/agent-settings.ts";
import { makeJob } from "../src/domain/agent-queue.ts";
import { planNextAction } from "../src/agent/planner.ts";

test("daily targets use the exact entered number across days and restarts", () => {
  const s = createDefaultAgentSettings(), stats = { ...createEmptyDailyStats(), account: "alice" };
  const picked = dailyTarget(s, stats, "reply");
  assert.equal(picked, 500);
  assert.equal(dailyTarget(JSON.parse(JSON.stringify(s)), JSON.parse(JSON.stringify(stats)), "reply"), picked);
  assert.equal(dailyTarget({ ...s, delaySecMin: 99 }, stats, "reply"), picked);
  const days = new Set(Array.from({ length: 20 }, (_, i) => dailyTarget(s, { ...stats, date: `2026-10-${i + 1}` }, "reply")));
  assert.equal(days.size, 1);
  s.dailyTargets!.ranges.reply = { min: 400, max: 500 };
  assert.equal(dailyTarget(s, stats, "reply"), 500, "legacy ranges use the upper value");
  assert.equal(dailyTarget(s, stats, "follow"), 200);
  assert.equal(dailyTarget(s, stats, "like"), 0);
});

test("legacy ranges migrate to a fixed goal and zero disables the cap", () => {
  const s = sanitizeAgentSettings({ dailyTargets: { ranges: { reply: { min: 500, max: 400 }, like: { min: 0, max: 10 }, follow: { min: 200, max: 0 } } } });
  assert.deepEqual(s.dailyTargets!.ranges.reply, { min: 400, max: 400 });
  assert.deepEqual(s.dailyTargets!.ranges.like, { min: 10, max: 10 });
  assert.deepEqual(s.dailyTargets!.ranges.follow, { min: 0, max: 0 });
  assert.equal(dailyTarget(s, createEmptyDailyStats(), "follow"), 0);
});

test("only the reached action stops; Like total covers feed and opened-post likes", () => {
  const s = createDefaultAgentSettings(), stats = createEmptyDailyStats();
  s.actions.retweet = false; s.actions.quote = false;
  s.dailyTargets!.ranges.like = { min: 20, max: 20 };
  stats.reply = dailyTarget(s, stats, "reply"); stats.like = 20;
  assert.equal(dailyActionReached(s, stats, "post_reply"), true);
  assert.equal(dailyActionReached(s, stats, "draft_reply"), true);
  assert.equal(dailyActionReached(s, stats, "like"), true);
  const effective = withDailyTargets(s, stats);
  assert.equal(effective.actions.reply, false); assert.equal(effective.actions.like, false);
  assert.equal(effective.actions.follow, true); assert.equal(s.actions.reply, true);
  assert.equal(allDailyTargetsReached(s, stats), false);
  stats.follow = 200;
  assert.equal(allDailyTargetsReached(s, stats), true);
  s.dailyTargets!.ranges.like = { min: 0, max: 0 };
  assert.equal(allDailyTargetsReached(s, stats), false, "an enabled unlimited action keeps running");
  s.dailyTargets!.enabled = false;
  assert.equal(allDailyTargetsReached(s, stats), false);
});

test("Vietnam midnight resets the date independently of the host timezone", () => {
  assert.equal(todayKey(new Date("2026-10-21T16:59:59Z")), "2026-10-21");
  assert.equal(todayKey(new Date("2026-10-21T17:00:00Z")), "2026-10-22");
  const stats = { ...createEmptyDailyStats("2000-01-01"), reply: 9999 };
  assert.equal(dailyActionReached(createDefaultAgentSettings(), stats, "post_reply"), false);
});

test("a capped pending reply cannot block an available Home follow", () => {
  const s = createDefaultAgentSettings(), stats = createEmptyDailyStats();
  s.modules.pogoTasks = false; s.priority = "browse_only";
  stats.reply = dailyTarget(s, stats, "reply");
  const base = { source: "browse" as const, authorHandle: "alice", tweetId: "2112057695247180169", tweetUrl: "https://x.com/alice/status/2112057695247180169", tweetText: "Post" };
  const reply = makeJob({ ...base, kind: "post_reply", draftText: "Ready", error: "navigating_tweet" });
  const follow = makeJob({ ...base, kind: "follow", error: "navigating_profile" });
  const p = planNextAction({ settings: s, stats, queue: { jobs: [reply, follow] }, campaigns: [], executeActions: true, ownHandle: "me" });
  assert.equal(p.type, "job"); if (p.type === "job") assert.equal(p.job.kind, "follow");
});

test("day reset makes a goal-blocked pending action resumable", () => {
  const s = createDefaultAgentSettings(); s.modules.pogoTasks = false; s.priority = "browse_only";
  const reply = makeJob({ source: "browse", kind: "post_reply", authorHandle: "alice", tweetId: "2112057695247180169", tweetUrl: "https://x.com/alice/status/2112057695247180169", tweetText: "Post", draftText: "Ready", error: "daily_target_reached" });
  const p = planNextAction({ settings: s, stats: createEmptyDailyStats(), queue: { jobs: [reply] }, campaigns: [], executeActions: true, ownHandle: "me" });
  assert.equal(p.type, "job"); if (p.type === "job") assert.equal(p.job.id, reply.id);
  assert.equal(defaultDailyTargets().ranges.reply.min, 500);
});
