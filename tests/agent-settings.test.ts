import assert from "node:assert/strict";
import test from "node:test";
import {
  applySpeedPreset,
  createDefaultAgentSettings,
  sanitizeAgentSettings,
  statusLabel,
} from "../src/domain/agent-settings.ts";

test("default agent settings are safe-first", () => {
  const s = createDefaultAgentSettings();
  assert.equal(s.speedPreset, "safe");
  assert.equal(s.modules.pogoTasks, true);
  assert.equal(s.modules.linkList, false);
  assert.equal(s.modules.homeScroll, true);
  assert.equal(s.priority, "pogo_then_browse");
  assert.equal(typeof s.humanize.replyPct, "number");
  assert.equal(typeof s.humanize.followPct, "number");
  assert.equal(typeof s.humanize.retweetPct, "number");
  assert.ok(s.delaySecMin <= s.delaySecMax);
  assert.equal(s.notificationCooldownMin, 60);
  assert.equal(s.browseSchedule?.homeSec, 600);
  assert.equal(s.browseSchedule?.followingSec, 600);
  assert.equal(s.browseSchedule?.listsSec, 300);
  assert.equal(s.browseSchedule?.earlySwitchOnEmpty, true);
  assert.equal(s.browseSchedule?.keepSourceOnResume, true);
});

test("notification cooldown minutes sanitize to 5–180 and default to 60", () => {
  assert.equal(sanitizeAgentSettings({}).notificationCooldownMin, 60);
  assert.equal(sanitizeAgentSettings({ notificationCooldownMin: 15 }).notificationCooldownMin, 15);
  assert.equal(sanitizeAgentSettings({ notificationCooldownMin: 60 }).notificationCooldownMin, 60);
  assert.equal(sanitizeAgentSettings({ notificationCooldownMin: 1 }).notificationCooldownMin, 5);
  assert.equal(sanitizeAgentSettings({ notificationCooldownMin: 999 }).notificationCooldownMin, 180);
  assert.equal(sanitizeAgentSettings({ notificationCooldownMin: NaN }).notificationCooldownMin, 60);
});

test("feed Follow Sorsa threshold defaults to 500 and survives settings restoration", () => {
  assert.equal(createDefaultAgentSettings().randomAuthorFollowSorsaMin, 500);
  assert.equal(sanitizeAgentSettings({}).randomAuthorFollowSorsaMin, 500);
  for (const threshold of [0, 500, 1000, 2500]) {
    const saved = sanitizeAgentSettings({ randomAuthorFollow: true, randomAuthorFollowSorsaMin: threshold });
    assert.equal(sanitizeAgentSettings(JSON.parse(JSON.stringify(saved))).randomAuthorFollowSorsaMin, threshold);
  }
  assert.equal(sanitizeAgentSettings({ randomAuthorFollowSorsaMin: -10 }).randomAuthorFollowSorsaMin, 0);
  assert.equal(sanitizeAgentSettings({ randomAuthorFollowSorsaMin: NaN }).randomAuthorFollowSorsaMin, 500);
});

test("sanitize migrates missing browseSchedule to defaults", () => {
  const s = sanitizeAgentSettings({ browseWeights: { home: 90, following: 5, lists: 5 } });
  assert.equal(s.browseSchedule?.homeSec, 600);
  assert.equal(s.browseWeights?.home, 90);
});

test("sanitize raises sessionLimit to at least maxLoops", () => {
  const s = sanitizeAgentSettings({ maxLoops: 200, sessionLimit: 80 });
  assert.equal(s.maxLoops, 200);
  assert.equal(s.sessionLimit, 200);
});

test("sanitize clamps delay and rejects bad handle", () => {
  const s = sanitizeAgentSettings({
    ownHandle: "@Bad Handle!",
    delaySecMin: 200,
    delaySecMax: 50,
    dailyQuota: { reply: 9999 },
  });
  assert.equal(s.ownHandle, "");
  assert.equal(s.delaySecMax, s.delaySecMin);
  assert.equal(s.dailyQuota.reply, 9999);
  assert.equal(typeof s.actions.like, "boolean");
});

test("speed preset fast shortens delays", () => {
  const fast = applySpeedPreset(createDefaultAgentSettings(), "fast");
  assert.equal(fast.speedPreset, "fast");
  assert.ok(fast.delaySecMax < createDefaultAgentSettings().delaySecMax);
});

test("post-task delay accepts low values and clamps invalid ranges", () => {
  assert.equal(sanitizeAgentSettings({ delaySecMin: 1, delaySecMax: 3 }).delaySecMin, 1);
  assert.equal(sanitizeAgentSettings({ delaySecMin: 1, delaySecMax: 3 }).delaySecMax, 3);
  assert.equal(sanitizeAgentSettings({ delaySecMin: 0, delaySecMax: -5 }).delaySecMin, 1);
  assert.equal(sanitizeAgentSettings({ delaySecMin: 0, delaySecMax: -5 }).delaySecMax, 1);
  assert.equal(sanitizeAgentSettings({ delaySecMin: 3, delaySecMax: 1 }).delaySecMax, 3);
});

test("status labels", () => {
  assert.equal(statusLabel("idle"), "Chưa chạy");
  assert.equal(statusLabel("waiting"), "Đang chờ delay");
});
