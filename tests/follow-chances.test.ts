import assert from "node:assert/strict";
import test from "node:test";
import { defaultBrowseRolls, planNextAction } from "../src/agent/planner.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, sanitizeAgentSettings } from "../src/domain/agent-settings.ts";
import { makeJob, type AgentJob } from "../src/domain/agent-queue.ts";

const post = { tweetId: "2112057695247180190", authorHandle: "writer", tweetUrl: "https://x.com/writer/status/2112057695247180190", text: "The release notes explain the changes.", alreadyLiked: false, promoted: false };
function setup() {
  const settings = createDefaultAgentSettings();
  settings.priority = "browse_only"; settings.modules.pogoTasks = false; settings.modules.following = true;
  settings.randomAuthorFollow = true;
  settings.actions = { like: true, reply: false, follow: true, retweet: false, quote: false };
  settings.humanize.likePct = 100;
  return settings;
}
function plan(settings = setup(), jobs: AgentJob[] = [], surface: "home" | "following" | "lists" = "home") {
  return planNextAction({ settings, stats: createEmptyDailyStats(), queue: { jobs }, campaigns: [],
    browseCandidates: [post], browseSurface: surface, followListHandles: ["list_one", "list_two"],
    browseRolls: defaultBrowseRolls(settings, () => 0.5), executeActions: true, ownHandle: "owner", hasApiKey: true });
}
test("old shared percentage migrates to both independent fields without losing zero", () => {
  for (const pct of [0, 20, 100]) {
    const s = sanitizeAgentSettings({ humanize: { followPct: pct } });
    assert.equal(s.humanize.followPct, pct); assert.equal(s.humanize.listFollowPct, pct);
  }
  const separate = sanitizeAgentSettings({ humanize: { followPct: 80, listFollowPct: 0 } });
  assert.equal(separate.humanize.followPct, 80); assert.equal(separate.humanize.listFollowPct, 0);
  assert.equal(sanitizeAgentSettings({ humanize: { listFollowPct: 120 } }).humanize.listFollowPct, 100);
});
test("author and username list chances use independent random draws", () => {
  const s = setup(); s.humanize.followPct = 20; s.humanize.listFollowPct = 20;
  const draws = [0, 0, 0, 0.1, 0.9];
  const rolls = defaultBrowseRolls(s, () => draws.shift()!);
  assert.equal(rolls.follow, true); assert.equal(rolls.listFollow, false);
});
test("zero list chance does not block author Follow while the list is enabled", () => {
  const s = setup(); s.humanize.followPct = 100; s.humanize.listFollowPct = 0;
  const p = plan(s); assert.equal(p.type, "bundle");
  if (p.type === "bundle") assert.ok(p.jobs.some(j => j.authorFollow && j.authorHandle === "writer"));
});
test("zero author chance does not block username-list Follow while author mode is enabled", () => {
  const s = setup(); s.humanize.followPct = 0; s.humanize.listFollowPct = 100;
  const p = plan(s); assert.equal(p.type, "job");
  if (p.type === "job") assert.equal(p.job.authorHandle, "list_one");
});
test("both 100% execute list and post work on successive plans without starving either", () => {
  const s = setup(); s.humanize.followPct = 100; s.humanize.listFollowPct = 100;
  const first = plan(s); assert.equal(first.type, "job"); if (first.type !== "job") return;
  const done = { ...first.job, status: "done" as const, updatedAt: 100 };
  const second = plan(s, [done]); assert.equal(second.type, "bundle"); if (second.type !== "bundle") return;
  assert.ok(second.jobs.some(j => j.authorFollow && j.authorHandle === "writer"));
  const completed = second.jobs.map(j => ({ ...j, status: "done" as const, updatedAt: 200 }));
  const third = plan(s, [...completed, done]); assert.equal(third.type, "job");
  if (third.type === "job") assert.equal(third.job.authorHandle, "list_two");
});
test("disabling list source leaves author Follow available", () => {
  const s = setup(); s.modules.following = false; s.humanize.followPct = 100; s.humanize.listFollowPct = 100;
  const p = plan(s); assert.equal(p.type, "bundle");
  if (p.type === "bundle") assert.ok(p.jobs.every(j => j.authorHandle === "writer"));
});
test("list chance never starts username-list Follow on Lists", () => {
  const s = setup(); s.modules.lists = true; s.listUrlOrName = "https://x.com/i/lists/123";
  s.humanize.followPct = 100; s.humanize.listFollowPct = 100;
  const p = plan(s, [], "lists"); assert.equal(p.type, "bundle");
  if (p.type === "bundle") assert.ok(p.jobs.every(j => j.authorHandle === "writer"));
});
