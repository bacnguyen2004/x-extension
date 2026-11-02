import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultFollowSettings,
  evaluateFollowCandidate,
  normalizeFollowHandle,
  parseFollowersCount,
  parseHandleList,
  sanitizeFollowSettings,
} from "../src/domain/follow-settings.ts";

test("normalizeFollowHandle accepts @ user and profile URL", () => {
  assert.equal(normalizeFollowHandle("@Alice_1"), "alice_1");
  assert.equal(normalizeFollowHandle("https://x.com/Bob"), "bob");
  assert.equal(normalizeFollowHandle("home"), null);
});

test("parseHandleList dedupes", () => {
  assert.deepEqual(parseHandleList("@a a https://x.com/b"), ["a", "b"]);
});

test("parseFollowersCount handles K/M and locales", () => {
  assert.equal(parseFollowersCount("1.2K Followers"), 1200);
  assert.equal(parseFollowersCount("12,345 Followers"), 12345);
  assert.equal(parseFollowersCount("3.4M followers"), 3_400_000);
  assert.equal(parseFollowersCount("1,2K Followers"), 1200);
  assert.equal(parseFollowersCount("12.345 người theo dõi"), 12345);
  assert.equal(parseFollowersCount("1.234,5K Followers"), 1234500);
  assert.equal(parseFollowersCount("1,234.5K Followers"), 1234500);
  assert.equal(parseFollowersCount("nope"), null);
});

test("partial Follow settings retain the Sorsa default and explicit null turns it off", () => {
  assert.deepEqual(sanitizeFollowSettings({}), createDefaultFollowSettings());
  assert.equal(sanitizeFollowSettings({ filters: { sorsaMin: null }, sorsaMin: 999 }).filters.sorsaMin, null);
});

test("sanitizeFollowSettings clamps pace and filters", () => {
  const s = sanitizeFollowSettings({
    sourceMode: "kol_followers",
    kolHandle: "@VitalikButerin",
    sorsaMin: "200",
    verified: "require",
    delaySecMin: 10,
    delaySecMax: 5,
    blacklist: "@spam, good",
  });
  assert.equal(s.sourceMode, "kol_followers");
  assert.equal(s.kolHandle, "vitalikbuterin");
  assert.equal(s.filters.sorsaMin, 200);
  assert.equal(s.filters.verified, "require");
  assert.equal(s.pace.delaySecMax, 10);
  assert.deepEqual(s.filters.blacklist, ["spam", "good"]);
});

test("evaluateFollowCandidate skip matrix", () => {
  const base = createDefaultFollowSettings().filters;
  const c = {
    handle: "alice",
    verified: false,
    followers: 5000,
    sorsa: 150,
  };
  assert.equal(evaluateFollowCandidate(c, base).ok, false);
  assert.equal(
    (evaluateFollowCandidate(c, base) as { reason: string }).reason,
    "sorsa_low",
  );

  assert.equal(
    evaluateFollowCandidate(
      { ...c, sorsa: 300, alreadyFollowing: true },
      base,
    ).ok,
    false,
  );

  assert.equal(
    (evaluateFollowCandidate(
      { ...c, sorsa: 300 },
      { ...base, verified: "require" },
    ) as { reason: string }).reason,
    "verified_required",
  );

  assert.equal(
    (evaluateFollowCandidate(
      { ...c, sorsa: 300, followers: 100 },
      { ...base, followersMin: 1000 },
    ) as { reason: string }).reason,
    "followers_low",
  );

  assert.equal(
    (evaluateFollowCandidate(
      { ...c, sorsa: null },
      { ...base, allowMissingSorsa: false },
    ) as { reason: string }).reason,
    "sorsa_missing",
  );

  assert.equal(
    evaluateFollowCandidate(
      { ...c, sorsa: null, verified: true, followers: 2000 },
      { ...base, allowMissingSorsa: true, sorsaMin: 200 },
    ).ok,
    true,
  );

  assert.equal(
    (evaluateFollowCandidate(
      { ...c, sorsa: 400 },
      { ...base, blacklist: ["alice"] },
    ) as { reason: string }).reason,
    "blacklist",
  );

  assert.equal(
    (evaluateFollowCandidate(
      { ...c, sorsa: 400 },
      { ...base, whitelist: ["bob"] },
    ) as { reason: string }).reason,
    "not_in_whitelist",
  );
});
