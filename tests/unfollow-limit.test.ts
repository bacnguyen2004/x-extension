import assert from "node:assert/strict";
import test from "node:test";
import { canUnfollowNow, countInWindow, createInitialUnfollowRuntime, noteUnfollowSuccess, toUnfollowPublic } from "../src/background/unfollow-store.ts";
import { createDefaultUnfollowSettings } from "../src/domain/unfollow-settings.ts";

const windowMs = 30 * 60 * 1000;

test("30 minute limit blocks at the cap and releases exactly at expiry", () => {
  const settings = createDefaultUnfollowSettings();
  settings.pace.maxPer30Min = 2;
  const now = Date.now();
  const rt = { ...createInitialUnfollowRuntime(), unfollowTimestamps: [now - windowMs + 100, now - 1000] };
  const blocked = canUnfollowNow(rt, settings, now);
  assert.equal(blocked.ok, false);
  assert.equal(canUnfollowNow(rt, settings, now + 99).ok, false);
  assert.equal(canUnfollowNow(rt, settings, now + 100).ok, true);
  assert.equal(countInWindow([now - windowMs, now - 1, now + 1, NaN, Infinity], now), 1);
});

test("lowered limit waits until enough prior actions expire", () => {
  const settings = createDefaultUnfollowSettings();
  settings.pace.maxPer30Min = 1;
  const now = Date.now();
  const rt = { ...createInitialUnfollowRuntime(), unfollowTimestamps: [now - 3000, now - 2000, now - 1000] };
  const blocked = canUnfollowNow(rt, settings, now);
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.waitMs, windowMs - 1000 + 500);
});

test("midnight resets daily count but preserves the rolling 30 minute limit", t => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const settings = createDefaultUnfollowSettings();
  settings.pace.maxPer30Min = 1;
  const rt = { ...createInitialUnfollowRuntime(), day: "2000-01-01", unfollowedToday: 999,
    unfollowTimestamps: [now - 1000] };
  assert.equal(canUnfollowNow(rt, settings).ok, false);
  const state = toUnfollowPublic(rt, settings);
  assert.equal(state.unfollowedToday, 0);
  assert.equal(state.unfollowedInWindow, 1);
  const after = noteUnfollowSuccess(rt);
  assert.equal(after.unfollowedToday, 1);
  assert.equal(after.unfollowTimestamps.length, 2);
});
