import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { buildBrowseJobs } from "../src/agent/planner.ts";
import { createDefaultAgentSettings } from "../src/domain/agent-settings.ts";
import { makeJob } from "../src/domain/agent-queue.ts";
import { handleXCommand } from "../src/content/x-commands.ts";
import {
  collectVisibleTimelineTweets,
  sanitizeTimelineTweets,
} from "../src/x/timeline.ts";

test("collectVisibleTimelineTweets reads id/handle/text from articles", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice">Alice</a><span>@alice</span></div>
      <a href="/alice/status/2112057695247180169">sep 12</a>
      <div data-testid="tweetText">Hello from home timeline</div>
      <button data-testid="like"></button>
    </article>
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/bob">Bob</a></div>
      <a href="/bob/status/2112057695247180170">sep 12</a>
      <div data-testid="tweetText">Second post</div>
      <button data-testid="unlike"></button>
    </article>
  </body></html>`);

  const tweets = collectVisibleTimelineTweets(document as unknown as Document, 12);
  assert.equal(tweets.length, 2);
  assert.equal(tweets[0]?.tweetId, "2112057695247180169");
  assert.equal(tweets[0]?.authorHandle, "alice");
  assert.equal(tweets[0]?.tweetUrl, "https://x.com/alice/status/2112057695247180169");
  assert.equal(tweets[0]?.alreadyLiked, false);
  assert.equal(tweets[1]?.alreadyLiked, true);
  assert.match(tweets[0]?.text ?? "", /Hello from home/);
});

test("sanitizeTimelineTweets drops bad payloads", () => {
  const tweets = sanitizeTimelineTweets([
    {
      tweetId: "2112057695247180169",
      authorHandle: "alice",
      tweetUrl: "https://x.com/alice/status/2112057695247180169",
      text: "ok",
      alreadyLiked: false,
      promoted: false,
    },
    { tweetId: "bad", authorHandle: "alice" },
    null,
  ]);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0]?.authorHandle, "alice");
});

function scanPost(body: string, extra = "", name = "Alice") {
  const { document } = parseHTML(`<article data-testid="tweet">
    <div data-testid="User-Name"><a href="/alice">${name}</a></div>
    <a href="/alice/status/2112057695247180169">date</a>
    ${extra}<div data-testid="tweetText">${body}</div><button data-testid="like"></button>
  </article>`);
  return collectVisibleTimelineTweets(document)[0]!;
}

test("normal post words and advertising discussions do not count as promoted labels", () => {
  for (const body of ["This leads to better results. Read the threads.", "I work on ads.", "<span>Promoted</span>", "<span>Ad</span>", "<span>Được tài trợ</span>"]) {
    assert.equal(scanPost(body).promoted, false, body);
  }
  assert.equal(scanPost("A normal post", "", "<span>Ads</span>").promoted, false);
});

test("standalone advertisement labels outside the post content are detected", () => {
  for (const label of ["Ad", "Ads", "Promoted", "Sponsored", "Được tài trợ", "Quảng cáo"]) {
    assert.equal(scanPost("A normal post", `<span>${label}</span>`).promoted, true, label);
  }
  assert.equal(scanPost("A normal post", '<div data-testid="socialContext">Promoted</div>').promoted, true);
});

test("a promoted label in a quoted article does not mark the outer post", () => {
  const quote = '<article data-testid="tweet"><span>Promoted</span><div data-testid="tweetText">An embedded advertisement</div></article>';
  assert.equal(scanPost("My own comment", quote).promoted, false);
});

test("canonical timestamp wins over links in post text, and quotes are never scanned as separate candidates", () => {
  const { document } = parseHTML(`<article data-testid="tweet">
    <div data-testid="User-Name"><a href="/alice">Alice</a></div>
    <div data-testid="tweetText"><a href="/alice/status/2112057695247180199">An earlier post</a>My own text</div>
    <article data-testid="tweet"><div data-testid="User-Name"><a href="/bob">Bob</a></div><a href="/bob/status/2112057695247180188"><time></time></a><div data-testid="tweetText">Quoted text</div></article>
    <a href="/alice/status/2112057695247180169"><time></time></a>
    <button data-testid="unretweet"></button><button data-testid="alice-unfollow"></button>
  </article>`);
  const tweets = collectVisibleTimelineTweets(document);
  assert.equal(tweets.length, 1); assert.equal(tweets[0].tweetId, "2112057695247180169");
  assert.equal(tweets[0].text, "An earlier postMy own text");
  assert.equal(tweets[0].alreadyRetweeted, true); assert.equal(tweets[0].alreadyFollowing, true);
});

test("a wrapper without its own status link cannot borrow its quoted post ID", () => {
  const { document } = parseHTML(`<article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a></div>
    <article data-testid="tweet"><div data-testid="User-Name"><a href="/bob">Bob</a></div><a href="/bob/status/2112057695247180188">Quoted post</a></article></article>`);
  assert.deepEqual(collectVisibleTimelineTweets(document), []);
});

test("Home skips observed repost/follow states and remembered follows across different posts", () => {
  const candidate = scanPost("A normal post");
  const settings = createDefaultAgentSettings();
  settings.actions = { like: false, reply: false, retweet: true, follow: true, quote: false };
  const input = { settings, queue: { jobs: [] }, executeActions: true, hasApiKey: false,
    rolls: { engage: true, like: false, reply: false, retweet: true, follow: true } };
  assert.deepEqual(buildBrowseJobs({ ...input, candidate: { ...candidate, alreadyRetweeted: true, alreadyFollowing: true } }), []);
  const followed = makeJob({ kind: "follow", source: "browse", status: "done", tweetId: "2112057695247180199", authorHandle: "ALICE", tweetUrl: null, tweetText: null });
  const jobs = buildBrowseJobs({ ...input, candidate, queue: { jobs: [followed] } });
  assert.deepEqual(jobs.map((j) => j.kind), [], "RT is Pogo-only");
});

test("real X anchors with role=link survive scan, message sanitization and interaction selection", async (t) => {
  const { document, window } = parseHTML(`<html><body>
    <main data-testid="primaryColumn"><div role="tab" aria-selected="true">For you</div>
    <article data-testid="tweet" role="article"><div data-testid="User-Name"><a role="link" href="/alice">Alice</a><a role="link" href="/alice">@alice</a></div>
      <a role="link" href="/alice/status/2112057695247180169"><time datetime="2026-10-22">Now</time></a>
      <div data-testid="tweetText">A normal post in the Home feed.</div><button data-testid="like"></button>
      <div role="link"><div data-testid="User-Name"><a role="link" href="/bob">Bob</a></div><a role="link" href="/bob/status/2112057695247180199"><time>Quoted</time></a><div data-testid="tweetText">Quoted content</div></div>
    </article></main></body></html>`);
  for (const [key, value] of Object.entries({ document, window, location: { href: "https://x.com/home", pathname: "/home" } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  const messages: Array<{ type?: string; tweets?: unknown }> = [];
  await handleXCommand({ postMessage(message) { messages.push(message); } }, { type: "x_timeline_scan", requestId: "scan-real-anchors" });
  const candidates = sanitizeTimelineTweets(messages.find((m) => m.type === "x_timeline_scan_result")?.tweets);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].tweetId, "2112057695247180169");
  assert.equal(candidates[0].authorHandle, "alice");
  assert.equal(candidates[0].text, "A normal post in the Home feed.");
  const settings = createDefaultAgentSettings(); settings.actions = { like: true, reply: false, follow: false, retweet: false, quote: false };
  const jobs = buildBrowseJobs({ candidate: candidates[0], settings, queue: { jobs: [] }, executeActions: true, hasApiKey: false,
    rolls: { engage: true, like: true, reply: false, retweet: false, follow: false } });
  assert.deepEqual(jobs.map((j) => j.kind), ["like"]);
});
