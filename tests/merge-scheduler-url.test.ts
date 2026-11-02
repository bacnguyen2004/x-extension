import assert from "node:assert/strict";
import test from "node:test";
import { applyScan, clearCampaignCache, filterCampaigns } from "../src/domain/merge.ts";
import { createInitialState, emptyActions, type Campaign, type ScanSnapshot } from "../src/domain/types.ts";
import {
  constructTweetUrl,
  parseTweetUrlList,
  sanitizeTweetUrl,
  tweetIdFromTweetUrl,
} from "../src/domain/url.ts";
import { alarmActionForMode, deriveUiStatus } from "../src/domain/status.ts";
import { isExtensionPageSender } from "../src/messages/validate.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { extractCampaignArray, extractLinkedAccount, snapshotFromFeedBody, fetchPogoFeed } from "../src/api/feed-client.ts";

test("an authoritative empty API feed retires cached tasks while an empty DOM scan preserves them", () => {
  const c = normalizeApiCampaign({ tweet_id: "2112057695247180169", author_handle: "alice" })!;
  const before = { ...createInitialState(), campaigns: { [c.tweet_id]: c } };
  const api = applyScan(before, snapshotFromFeedBody({ campaigns: [] }));
  assert.equal(api.campaigns[c.tweet_id].stale, true);
  const dom = applyScan(before, { ...snapshotFromFeedBody({ campaigns: [] }), feed_present: false });
  assert.equal(dom.campaigns[c.tweet_id].stale, false);
});

test("changing linked accounts cannot inherit Pogo receipts or old tasks", () => {
  const raw = { tweet_id: "2112057695247180169", author_handle: "alice", my_interactions: ["reply"] };
  const first = applyScan(createInitialState(), snapshotFromFeedBody({ linked_handle: "account_a", campaigns: [raw] }));
  const next = applyScan(first, snapshotFromFeedBody({ linked_handle: "account_b", campaigns: [{ ...raw, my_interactions: [] }] }));
  assert.equal(next.campaigns[raw.tweet_id].actions.reply.status, "not_recorded");
  assert.equal(next.campaigns[raw.tweet_id].actions.reply.local, undefined);
  const empty = applyScan(first, snapshotFromFeedBody({ linked_handle: "account_b", campaigns: [] }));
  assert.deepEqual(empty.campaigns, {});
});

test("malformed HTTP 200 feed is not accepted as an empty task list", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "temporarily unavailable" }));
  assert.equal((await fetchPogoFeed("test-token")).ok, false);
});

function camp(partial: Partial<Campaign> & Pick<Campaign, "tweet_id">): Campaign {
  return {
    author_handle: "u",
    tweet_url: null,
    tweet_url_source: "unknown",
    text: "t",
    actions: emptyActions(),
    follows_author: null,
    author_tier: null,
    author_division: null,
    pinned: false,
    boosted: false,
    bonus_label: null,
    last_observed_at: 1,
    source: "dom",
    stale: false,
    ...partial,
  };
}

test("same id updates without duplicate", () => {
  let state = createInitialState();
  const first: ScanSnapshot = {
    campaigns: [camp({ tweet_id: "2112057695247180169", text: "a" })],
    scanned_at: 10,
    frame_url: "https://pogo.social/app",
    feed_present: true,
    login_required: false,
    linked_account: null,
  };
  state = applyScan(state, first);
  state = applyScan(state, {
    ...first,
    scanned_at: 20,
    campaigns: [camp({ tweet_id: "2112057695247180169", text: "b" })],
  });
  assert.equal(Object.keys(state.campaigns).length, 1);
  assert.equal(state.campaigns["2112057695247180169"].text, "b");
  assert.equal(state.last_data_change_at, 20);
});

test("missing from later non-empty scan => stale, actions unchanged", () => {
  let state = createInitialState();
  const recorded = emptyActions();
  recorded.reply = { status: "not_recorded", displayedPoints: 30 };
  state = applyScan(state, {
    campaigns: [camp({ tweet_id: "1", actions: recorded })],
    scanned_at: 1,
    frame_url: "https://pogo.social/app",
    feed_present: true,
    login_required: false,
    linked_account: null,
  });
  state = applyScan(state, {
    campaigns: [camp({ tweet_id: "2" })],
    scanned_at: 2,
    frame_url: "https://pogo.social/app",
    feed_present: true,
    login_required: false,
    linked_account: null,
  });
  assert.equal(state.campaigns["1"].stale, true);
  assert.equal(state.campaigns["1"].actions.reply.status, "not_recorded");
  assert.equal(state.campaigns["2"].stale, false);
});

test("empty scan does not mark all stale or complete", () => {
  let state = createInitialState();
  state = applyScan(state, {
    campaigns: [camp({ tweet_id: "1" })],
    scanned_at: 1,
    frame_url: "https://pogo.social/app",
    feed_present: true,
    login_required: false,
    linked_account: null,
  });
  state = applyScan(state, {
    campaigns: [],
    scanned_at: 2,
    frame_url: "https://pogo.social/app",
    feed_present: false,
    login_required: false,
    linked_account: null,
  });
  assert.equal(state.campaigns["1"].stale, false);
});


test("url helpers", () => {
  assert.equal(
    constructTweetUrl("evrendag1284", "2112057695247180169"),
    "https://x.com/evrendag1284/status/2112057695247180169",
  );
  assert.equal(sanitizeTweetUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeTweetUrl("https://evil.com/x"), null);
  assert.equal(
    sanitizeTweetUrl("https://twitter.com/evrendag1284/status/2112057695247180169"),
    "https://x.com/evrendag1284/status/2112057695247180169",
  );
});

test("parseTweetUrlList dedupes and keeps only status URLs", () => {
  const urls = parseTweetUrlList(`
    https://x.com/alice/status/2112057695247180169
    https://twitter.com/alice/status/2112057695247180169
    not-a-url
    https://x.com/bob/status/2112057695247180170
    https://evil.com/status/1
  `);
  assert.equal(urls.length, 2);
  assert.equal(tweetIdFromTweetUrl(urls[0]!), "2112057695247180169");
  assert.equal(urls[0], "https://x.com/alice/status/2112057695247180169");
  assert.equal(urls[1], "https://x.com/bob/status/2112057695247180170");
});

test("parseTweetUrlList normalizes messy Telegram chat paste", () => {
  const messy = `[9/12/2026 12:55 PM] Boss Mon: https://x.com/BossMon_02/status/2098635253787292056

2
[9/12/2026 1:03 PM] Vitalis ❤️: https://x.com/yubbie_ox/status/2098495765526331864
[9/12/2026 1:03 PM] Duck in reply to Vitalis ❤️:
> \u200E\u2068https://x.com/yubbie_ox/status/2098495765526331864\u2069
https://x.com/L0cCapital/status/2098562484215153008
Engage from duc_daily
[9/12/2026 1:04 PM] Deleted Account: https://x.com/ubong_27/status/2098511214053892317`;
  const urls = parseTweetUrlList(messy);
  assert.deepEqual(urls, [
    "https://x.com/BossMon_02/status/2098635253787292056",
    "https://x.com/yubbie_ox/status/2098495765526331864",
    "https://x.com/L0cCapital/status/2098562484215153008",
    "https://x.com/ubong_27/status/2098511214053892317",
  ]);
});



test("status + alarm restore intent", () => {
  assert.equal(alarmActionForMode("watching"), "create");
  assert.equal(alarmActionForMode("paused"), "clear");
  const state = createInitialState();
  assert.equal(state.data_source, "api");
  state.mode = "watching";
  state.feed_visible = true;
  assert.equal(deriveUiStatus(state, { connected: false, apiTokenPresent: false }), "no_token");
  assert.equal(deriveUiStatus(state, { connected: true, apiTokenPresent: true }), "watching");
});

test("api status: no token / watching without frame", () => {
  const state = createInitialState();
  state.data_source = "api";
  assert.equal(deriveUiStatus(state, { connected: false, apiTokenPresent: false }), "no_token");
  state.mode = "watching";
  state.feed_visible = true;
  assert.equal(deriveUiStatus(state, { connected: true, apiTokenPresent: true }), "watching");
});

test("applyScan keeps api source", () => {
  let state = createInitialState();
  state = applyScan(state, {
    campaigns: [camp({ tweet_id: "9", source: "api", text: "from-api" })],
    scanned_at: 5,
    frame_url: "https://pogo.social/api/feed",
    feed_present: true,
    login_required: false,
    linked_account: null,
  });
  assert.equal(state.campaigns["9"].source, "api");
});

test("feed client unwraps envelopes and linked account", () => {
  assert.equal(extractCampaignArray([{ tweet_id: "1" }]).length, 1);
  assert.equal(extractCampaignArray({ data: [{ tweet_id: "1" }] }).length, 1);
  assert.equal(extractCampaignArray({ campaigns: [{ tweet_id: "1" }] }).length, 1);
  assert.equal(extractLinkedAccount({ linked_account: { handle: "evrendag1284" } })?.handle, "evrendag1284");
  const snap = snapshotFromFeedBody({
    data: [
      {
        tweet_id: "2112057695247180169",
        author_handle: "evrendag1284",
        my_interactions: ["reply"],
        earned_points: { reply: 30 },
        follows_author: true,
        pinned: true,
        boosted: true,
        author_division: { number: 3 },
      },
    ],
    user: { handle: "myhandle1" },
  });
  assert.equal(snap.campaigns.length, 1);
  assert.equal(snap.campaigns[0].source, "api");
  assert.equal(snap.campaigns[0].actions.reply.status, "recorded");
  assert.equal(snap.campaigns[0].author_division, 3);
  assert.equal(snap.linked_account?.handle, "myhandle1");
});

test("clear cache keeps mode", () => {
  let state = createInitialState();
  state.mode = "watching";
  state = applyScan(state, {
    campaigns: [camp({ tweet_id: "1" })],
    scanned_at: 1,
    frame_url: "https://pogo.social/app",
    feed_present: true,
    login_required: false,
    linked_account: null,
  });
  state = clearCampaignCache(state);
  assert.equal(state.mode, "watching");
  assert.equal(Object.keys(state.campaigns).length, 0);
});

test("filter reply open", () => {
  const a = camp({
    tweet_id: "1",
    actions: {
      reply: { status: "not_recorded", displayedPoints: 1 },
      retweet: { status: "recorded", displayedPoints: 1 },
      quote: { status: "unknown", displayedPoints: null },
    },
  });
  const b = camp({
    tweet_id: "2",
    actions: {
      reply: { status: "recorded", displayedPoints: 1 },
      retweet: { status: "not_recorded", displayedPoints: 1 },
      quote: { status: "not_recorded", displayedPoints: 1 },
    },
  });
  assert.deepEqual(
    filterCampaigns([a, b], "reply_open", "").map((c) => c.tweet_id),
    ["1"],
  );
});

test("filter todo hides reply recorded", () => {
  const open = camp({
    tweet_id: "1",
    actions: {
      reply: { status: "not_recorded", displayedPoints: 1 },
      retweet: { status: "not_recorded", displayedPoints: 1 },
      quote: { status: "unknown", displayedPoints: null },
    },
  });
  const done = camp({
    tweet_id: "2",
    actions: {
      reply: { status: "recorded", displayedPoints: 1 },
      retweet: { status: "not_recorded", displayedPoints: 1 },
      quote: { status: "not_recorded", displayedPoints: 1 },
    },
  });
  assert.deepEqual(
    filterCampaigns([open, done], "todo", "").map((c) => c.tweet_id),
    ["1"],
  );
  assert.deepEqual(
    filterCampaigns([open, done], "all", "").map((c) => c.tweet_id).sort(),
    ["1", "2"],
  );
});

test("applyScan migrates legacy local recorded replies into uncertain evidence, without claiming Pogo points", () => {
  let state = createInitialState();
  state = applyScan(state, {
    campaigns: [
      camp({
        tweet_id: "1",
        actions: {
          reply: { status: "not_recorded", displayedPoints: 10 },
          retweet: { status: "not_recorded", displayedPoints: 5 },
          quote: { status: "unknown", displayedPoints: null },
        },
        follows_author: false,
      }),
    ],
    scanned_at: 1,
    frame_url: "https://pogo.social/api/feed",
    feed_present: true,
    login_required: false,
    linked_account: null,
  });
  // Agent đánh dấu done local (giống markPogoProgress).
  state = {
    ...state,
    campaigns: {
      "1": {
        ...state.campaigns["1"],
        actions: {
          ...state.campaigns["1"].actions,
          reply: { status: "recorded", displayedPoints: 10 },
        },
        follows_author: true,
      },
    },
  };
  state = applyScan(state, {
    campaigns: [
      camp({
        tweet_id: "1",
        text: "updated copy",
        actions: {
          reply: { status: "not_recorded", displayedPoints: 10 },
          retweet: { status: "not_recorded", displayedPoints: 5 },
          quote: { status: "unknown", displayedPoints: null },
        },
        follows_author: false,
      }),
    ],
    scanned_at: 2,
    frame_url: "https://pogo.social/api/feed",
    feed_present: true,
    login_required: false,
    linked_account: null,
  });
  assert.equal(state.campaigns["1"].actions.reply.status, "not_recorded");
  assert.equal(state.campaigns["1"].actions.reply.local?.state, "uncertain");
  assert.equal(state.campaigns["1"].follows_author, true);
  assert.equal(state.campaigns["1"].text, "updated copy");
});

test("api adapter: verified reply/retweet only; quote unknown; tweet_id must be string", () => {
  const c = normalizeApiCampaign({
    tweet_id: "2112057695247180169",
    author_handle: "evrendag1284",
    text: "x",
    my_interactions: ["reply", "retweet", "quote"],
    earned_points: { reply: 30, retweet: 90 },
    follows_author: true,
  });
  assert.ok(c);
  assert.equal(c!.actions.reply.status, "recorded");
  assert.equal(c!.actions.retweet.status, "recorded");
  assert.equal(c!.actions.quote.status, "unknown");
  assert.equal(normalizeApiCampaign({ tweet_id: 2112057695247180169 }), null);
});

test("only extension pages can issue panel commands",()=>{
 assert.equal(isExtensionPageSender({id:"abc",url:"chrome-extension://abc/sidepanel/sidepanel.html"},"abc"),true);
 assert.equal(isExtensionPageSender({id:"abc",url:"https://pogo.social/app"},"abc"),false);
 assert.equal(isExtensionPageSender({id:"other",url:"chrome-extension://abc/sidepanel/sidepanel.html"},"abc"),false);
});
