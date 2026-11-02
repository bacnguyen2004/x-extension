import assert from "node:assert/strict";
import test from "node:test";
import { extractPollingNextScanAt, extractRetweetPower } from "../src/api/feed-meta.ts";
import { snapshotFromFeedBody } from "../src/api/feed-client.ts";

const sampleBody = {
  campaigns: [],
  retweet_power: {
    mode: "enforce",
    window_start: "2026-10-23T12:00:00Z",
    window_end: "2026-10-23T18:00:00Z",
    used: 21,
    full: 10,
    reduced: 10,
    reduced_pct: 25,
    power_pct: 0,
    next_retweet_hops: 0,
  },
  polling: {
    last_swept_at: "2026-10-23T12:56:21.598969+00:00",
    interval_seconds: 600,
  },
};

test("extractRetweetPower maps used over cap to zero remaining", () => {
  const power = extractRetweetPower(sampleBody);
  assert.deepEqual(power, {
    used: 21,
    full: 10,
    reduced: 10,
    remaining: 0,
    earningRemaining: 0,
  });
});

test("extractRetweetPower keeps full and reduced bands", () => {
  assert.deepEqual(extractRetweetPower({
    retweet_power: { used: 5, full: 10, reduced: 10 },
  }), { used: 5, full: 10, reduced: 10, remaining: 5, earningRemaining: 15 });
  assert.deepEqual(extractRetweetPower({
    retweet_power: { used: 12, full: 10, reduced: 10 },
  }), { used: 12, full: 10, reduced: 10, remaining: 0, earningRemaining: 8 });
  assert.equal(extractRetweetPower({ campaigns: [] }), null);
  assert.equal(extractRetweetPower({ retweet_power: { used: -1 } }), null);
});

test("extractPollingNextScanAt advances overdue sweeps", () => {
  const last = Date.parse("2026-10-23T12:56:21.598969+00:00");
  const now = last + 50_000; // still within first interval
  assert.equal(extractPollingNextScanAt(sampleBody, now), last + 600_000);

  const overdue = last + 700_000; // one cycle past
  assert.equal(extractPollingNextScanAt(sampleBody, overdue), last + 1_200_000);
});

test("snapshotFromFeedBody carries API meta", () => {
  const snap = snapshotFromFeedBody(sampleBody, Date.parse("2026-10-23T12:57:00Z"));
  assert.equal(snap.retweet_remaining, 0);
  assert.equal(snap.retweet_earning_remaining, 0);
  assert.equal(snap.polling_next_scan_at, Date.parse("2026-10-23T12:56:21.598969+00:00") + 600_000);
  assert.equal(snap.feed_present, true);
});
