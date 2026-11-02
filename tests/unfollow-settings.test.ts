import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultUnfollowSettings,
  evaluateUnfollowCandidate,
  sanitizeUnfollowSettings,
  prioritizeUnfollowCandidates,
} from "../src/domain/unfollow-settings.ts";

test("missing settings preserve defaults while explicit null disables a threshold", () => {
  assert.deepEqual(sanitizeUnfollowSettings({}), createDefaultUnfollowSettings());
  assert.equal(sanitizeUnfollowSettings({ protect: { sorsaMin: null }, sorsaProtectMin: 900 }).protect.sorsaMin, null);
  assert.equal(sanitizeUnfollowSettings({ targets: { verified: "any" } }).targets.verified, "any");
});

test("priority never overrides protection or any target filter", () => {
  const settings = createDefaultUnfollowSettings();
  settings.targets.blacklist = ["alice"];
  const base = { handle: "alice", verified: false, following: true, followsYou: false, followers: 100, sorsa: 50 };
  const decide = (candidate = base) => evaluateUnfollowCandidate(candidate, settings);
  assert.equal(decide().action, "unfollow");
  assert.equal(decide({ ...base, followsYou: true }).action, "protect");
  assert.equal(evaluateUnfollowCandidate({ ...base, followsYou: null }, settings).reason, "follows_you_unknown");
  assert.equal(decide({ ...base, verified: true }).action, "skip");
  assert.equal(decide({ ...base, sorsa: 800 }).action, "protect");
  assert.equal(evaluateUnfollowCandidate({ ...base, sorsa: null }, settings).action, "protect");
  settings.targets.followersMax = 99;
  assert.equal(decide().reason, "followers_high");
  assert.equal(evaluateUnfollowCandidate({ ...base, followers: null }, settings).reason, "followers_unknown");
  settings.targets.followersMax = null;
  settings.targets.sorsaMax = 50;
  assert.equal(decide().reason, "sorsa_above_target");
  settings.protect.whitelist = ["alice"];
  assert.equal(decide().reason, "whitelist");
});

test("unknown score cannot bypass an active keep threshold", () => {
  const settings = createDefaultUnfollowSettings();
  settings.protect.protectMissingSorsa = false;
  const candidate = { handle: "alice", verified: false, following: true, followsYou: false, followers: 100, sorsa: null };
  assert.equal(evaluateUnfollowCandidate(candidate, settings).action, "skip");
  settings.protect.sorsaMin = null;
  assert.equal(evaluateUnfollowCandidate(candidate, settings).action, "unfollow");
});

test("priority orders only supplied candidates and preserves each group's order", () => {
  const settings = createDefaultUnfollowSettings();
  settings.targets.blacklist = ["bob", "carol", "outside"];
  const handles = ["alice", "@Carol", "dave", "bob"];
  assert.deepEqual(prioritizeUnfollowCandidates(handles, h => h, settings), ["@Carol", "bob", "alice", "dave"]);
  assert.deepEqual(handles, ["alice", "@Carol", "dave", "bob"]);
});

test("sanitizeUnfollowSettings defaults and whitelist", () => {
  const s = sanitizeUnfollowSettings({
    whitelist: "@keep, other",
    sorsaProtectMin: 500,
    verified: "exclude",
  });
  assert.deepEqual(s.protect.whitelist, ["keep", "other"]);
  assert.equal(s.protect.sorsaMin, 500);
  assert.equal(s.targets.verified, "exclude");
  assert.equal(s.targets.onlyNotFollowBack, true);
});

test("sanitizeUnfollowSettings onlyNotFollowBack override", () => {
  const off = sanitizeUnfollowSettings({
    targets: { onlyNotFollowBack: false },
  });
  assert.equal(off.targets.onlyNotFollowBack, false);
  const on = sanitizeUnfollowSettings({
    onlyNotFollowBack: true,
  });
  assert.equal(on.targets.onlyNotFollowBack, true);
});

test("evaluateUnfollowCandidate protect and unfollow matrix", () => {
  const settings = createDefaultUnfollowSettings();
  const base = {
    handle: "alice",
    verified: false,
    followers: 1000,
    sorsa: 100,
    following: true,
    followsYou: false as boolean | null,
  };

  assert.equal(evaluateUnfollowCandidate(base, settings).action, "unfollow");

  assert.equal(
    evaluateUnfollowCandidate(
      { ...base, sorsa: 800 },
      settings,
    ).action,
    "protect",
  );

  assert.equal(
    evaluateUnfollowCandidate(
      { ...base, handle: "vip" },
      { ...settings, protect: { ...settings.protect, whitelist: ["vip"] } },
    ).action,
    "protect",
  );

  assert.equal(
    evaluateUnfollowCandidate(
      { ...base, verified: true },
      settings,
    ).action,
    "skip",
  );

  assert.equal(
    evaluateUnfollowCandidate(
      { ...base, following: false },
      settings,
    ).action,
    "skip",
  );

  assert.equal(
    evaluateUnfollowCandidate(
      { ...base, sorsa: null },
      settings,
    ).action,
    "protect",
  );
});

test("evaluateUnfollowCandidate onlyNotFollowBack", () => {
  const settings = createDefaultUnfollowSettings();
  assert.equal(settings.targets.onlyNotFollowBack, true);

  const base = {
    handle: "bob",
    verified: false,
    followers: 500,
    sorsa: 50,
    following: true,
    followsYou: false as boolean | null,
  };

  // Không FL back → được unfollow
  const noBack = evaluateUnfollowCandidate(base, settings);
  assert.equal(noBack.action, "unfollow");

  // Có FL back → protect
  const backs = evaluateUnfollowCandidate({ ...base, followsYou: true }, settings);
  assert.equal(backs.action, "protect");
  assert.equal(backs.reason, "follows_you");

  // Chưa rõ → skip
  const unknown = evaluateUnfollowCandidate({ ...base, followsYou: null }, settings);
  assert.equal(unknown.action, "skip");
  assert.equal(unknown.reason, "follows_you_unknown");

  // Tắt tùy chọn → vẫn unfollow dù họ FL back
  const off = {
    ...settings,
    targets: { ...settings.targets, onlyNotFollowBack: false },
  };
  assert.equal(
    evaluateUnfollowCandidate({ ...base, followsYou: true }, off).action,
    "unfollow",
  );
});
