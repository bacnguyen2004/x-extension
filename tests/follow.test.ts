import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { followAuthor } from "../src/x/actions/engage.ts";
import { beginAction, stopActions } from "../src/x/action-control.ts";
import { buildCampaignJobs, followRetryLimitReached } from "../src/agent/planner.ts";
import { createDefaultAgentSettings } from "../src/domain/agent-settings.ts";
import { createEmptyQueue, makeJob } from "../src/domain/agent-queue.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";

function page(t: TestContext, path: string, html: string) {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
  const globals = { document, window, HTMLElement: window.HTMLElement, location: { pathname: path, href: `https://x.com${path}` } };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
    clock += ms;
    queueMicrotask(callback);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  beginAction();
  t.after(stopActions);
  return { document, window, now: () => clock };
}

const opts = { authorHandle: "jabosiswanto94", tweetUrl: "https://x.com/jabosiswanto94/status/2104963988278947893" };

test("tweet URL under the author's handle navigates to the actual profile before finding follow", async (t) => {
  const { document, now } = page(t, "/jabosiswanto94/status/2104963988278947893", '<aside data-testid="sidebarColumn"><button>Following</button></aside>');
  let clicks = 0;
  document.querySelector("button")!.addEventListener("click", () => clicks++);
  assert.deepEqual(await followAuthor(opts), { ok: false, error: "need_navigate_profile", detail: "https://x.com/jabosiswanto94" });
  assert.equal(clicks, 0);
  assert.equal(now(), 0);
});

test("already following on the target profile succeeds without clicking suggestions", async (t) => {
  const { document } = page(t, "/jabosiswanto94/", '<main role="main"><div data-testid="primaryColumn"><button data-testid="42-unfollow">Following</button><div data-testid="UserCell"><button data-testid="99-follow">Follow</button></div></div></main>');
  let clicks = 0;
  for (const button of document.querySelectorAll("button")) button.addEventListener("click", () => clicks++);
  assert.deepEqual(await followAuthor(opts), { ok: true, detail: "already_following" });
  assert.equal(clicks, 0);
});

test("native profile Follow button without role or test ID is supported and confirmed", async (t) => {
  const { document } = page(t, "/jabosiswanto94", '<main role="main"><button>Follow</button></main>');
  const button = document.querySelector("button")!;
  let clicks = 0;
  button.addEventListener("click", () => { clicks++; button.textContent = "Following"; });
  assert.deepEqual(await followAuthor(opts), { ok: true, detail: "follow_confirmed" });
  assert.equal(clicks, 1);
});

test("follow controls in tweets or recommendation cards are never used as profile controls", async (t) => {
  const { document } = page(t, "/jabosiswanto94", '<main role="main"><article data-testid="tweet"><button data-testid="2-follow">Follow</button></article><div data-testid="UserCell"><button data-testid="3-follow">Follow</button></div></main>');
  let clicks = 0;
  for (const button of document.querySelectorAll("button")) button.addEventListener("click", () => clicks++);
  assert.deepEqual(await followAuthor(opts), { ok: false, error: "follow_btn_missing" });
  assert.equal(clicks, 0);
});

test("unconfirmed click is reported as a failure instead of a successful follow", async (t) => {
  page(t, "/jabosiswanto94", '<main role="main"><button data-testid="42-follow">Follow</button></main>');
  assert.deepEqual(await followAuthor(opts), { ok: false, error: "follow_not_confirmed" });
});

test("a pending private-account follow request is not clicked again", async (t) => {
  page(t, "/jabosiswanto94", '<main role="main"><button>Requested</button></main>');
  assert.deepEqual(await followAuthor(opts), { ok: true, detail: "follow_requested" });
});

test("a local follow failure or skip stops repeated attempts for that author across tweets", () => {
  const campaign = normalizeApiCampaign({ tweet_id: "2104963988278947893", author_handle: "jabosiswanto94", text: "Post", follows_author: false, locked_points: 0 })!;
  const settings = createDefaultAgentSettings();
  for (const status of ["failed", "skipped"] as const) {
    const queue = { jobs: [makeJob({ kind: "follow", status, tweetId: "2104963988278947894",
      authorHandle: "@Jabosiswanto94", tweetUrl: campaign.tweet_url, tweetText: "Post", source: "pogo", error: "follow_btn_missing" })] };
    assert.equal(followRetryLimitReached(queue, "jabosiswanto94"), true);
    assert.equal(followRetryLimitReached(queue, "someone_else"), false);
    const jobs = buildCampaignJobs({ campaign, settings, queue, executeActions: true, hasApiKey: false });
    assert.ok(!jobs.some((j) => j.kind === "follow"));
    // Like chỉ đi kèm Reply — không có reply work thì không Like lẻ.
    assert.ok(!jobs.some((j) => j.kind === "like"));
  }
  assert.ok(buildCampaignJobs({ campaign, settings, queue: createEmptyQueue(), executeActions: true, hasApiKey: false }).some((j) => j.kind === "follow"));
});
