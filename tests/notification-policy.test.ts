import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { readNotificationBadge } from "../src/x/notification-badge.ts";
import { collectNotificationTweets } from "../src/x/notification-feed.ts";
import { observeNotificationBatch, startNotificationBatch, finishNotificationBatch, notificationBatchCanOpen } from "../src/domain/notification-batch.ts";
import { selectNotificationDrafts } from "../src/agent/notification-selection.ts";
import { createDefaultAgentSettings, createEmptyDailyStats } from "../src/domain/agent-settings.ts";
import { planNextAction } from "../src/agent/planner.ts";
import type { TimelineTweet } from "../src/x/timeline.ts";
import { notificationNavigationBlocked } from "../src/x/notification-position.ts";

const now = 1800000000000;
const doc = (html: string) => parseHTML(html).document as unknown as Document;
function post(author: string, id: string, text: string, extra = '') {
  return `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${author}">${author}</a></div><a href="/${author}/status/${id}"><time></time></a>${extra}<div data-testid="tweetText">${text}</div></article>`;
}
function candidate(i: number, kind: 'direct' | 'post' = 'direct'): TimelineTweet {
  const tweetId = String(2112057695247180100n + BigInt(i));
  return { tweetId, tweetUrl: `https://x.com/alice/status/${tweetId}`, authorHandle: 'alice', text: `A real post ${i}`, notificationKind: kind, directedToOwn: kind === 'direct', promoted: false, alreadyLiked: false };
}

test("Notifications reads only its numeric badge, not tweet/like counts or unrelated navigation badges", () => {
  assert.equal(readNotificationBadge(doc('<nav><a data-testid="AppTabBar_Notifications_Link" aria-label="Notifications (4 unread notifications)"></a></nav><main>999 likes</main>')), 4);
  assert.equal(readNotificationBadge(doc('<a data-testid="AppTabBar_Notifications_Link"><span>Thông báo</span><span aria-hidden="true">2</span></a>')), 2);
  assert.equal(readNotificationBadge(doc('<a data-testid="AppTabBar_Notifications_Link"><span>99+</span></a>')), 99);
  assert.equal(readNotificationBadge(doc('<a data-testid="AppTabBar_Notifications_Link">Notifications</a><a href="/messages">18</a>')), 0);
  assert.equal(readNotificationBadge(doc('<a data-testid="AppTabBar_Notifications_Link"><span aria-label="New unread items"></span></a>')), null);
  assert.equal(readNotificationBadge(doc('<main>5 notifications and 300 likes</main>')), null);
});

test("Notifications checks every sixty minutes by default regardless of badge count", () => {
  const hour = 60 * 60000;
  let batch = observeNotificationBatch(undefined, 'owner', 1, now);
  assert.equal(notificationBatchCanOpen(batch, 1, now), false);
  assert.equal(notificationBatchCanOpen(batch, 2, now + 299999), false);
  assert.equal(notificationBatchCanOpen(batch, 1, now + 300000), false);
  assert.equal(notificationBatchCanOpen(batch, 3, now), false);
  assert.equal(notificationBatchCanOpen(batch, 0, now + 300000), false);
  assert.equal(notificationBatchCanOpen(batch, null, now + 300000), false);
  for (const badge of [0, 1, 3, null]) assert.equal(notificationBatchCanOpen(batch, badge, now + hour), true);
  batch = observeNotificationBatch(batch, 'owner', 0, now + 300000);
  batch = observeNotificationBatch(batch, 'owner', 1, now + 300001);
  assert.equal(notificationBatchCanOpen(batch, 1, now + 300001), false, 'a cleared badge starts a fresh accumulation window');
});

test("a visit survives clearing its badge, then waits the configured cooldown and deduplicates saved tweet IDs", () => {
  const cooldown = 15 * 60000;
  let batch = startNotificationBatch(observeNotificationBatch(undefined, 'owner', 3, now, cooldown), now);
  assert.equal(notificationBatchCanOpen(batch, 0, now + 1000), true, 'finishing the authorized visit must not require a badge that cleared on entry');
  batch = finishNotificationBatch(batch, [candidate(1).tweetId], now + 1000, cooldown);
  batch = { ...batch, needsExit: false };
  assert.equal(notificationBatchCanOpen(batch, 3, now + 3600000), true, 'periodic checks do not depend on badge changes');
  batch = observeNotificationBatch(batch, 'owner', 0, now + 2000, cooldown);
  batch = observeNotificationBatch(batch, 'owner', 3, now + 3000, cooldown);
  assert.equal(notificationBatchCanOpen(batch, 3, now + 900999), false);
  assert.equal(notificationBatchCanOpen(batch, 3, now + 901000), true);
  assert.deepEqual(JSON.parse(JSON.stringify(batch)).seenIds, [candidate(1).tweetId]);
  const other = observeNotificationBatch(batch, 'other', 1, now + 901000, cooldown);
  assert.equal(other.active, false); assert.equal(other.seenIds.length, 0);
});

test("expired notification navigation ends the visit rather than reopening repeatedly", () => {
  let batch = startNotificationBatch(observeNotificationBatch(undefined, 'owner', 3, now), now);
  batch = observeNotificationBatch(batch, 'owner', 3, now + 300001);
  assert.equal(batch.active, false); assert.equal(batch.needsExit, true);
  assert.equal(notificationBatchCanOpen(batch, 3, now + 300001), false);
});

test("All collects direct mentions and excludes KOL new-post, like, RT, follow and recommendation events", () => {
  const html = `<main data-testid="primaryColumn">
    <div data-testid="cellInnerDiv">Alice mentioned you${post('alice', candidate(1).tweetId, 'Hi @owner')}</div>
    <div data-testid="cellInnerDiv">Bob posted${post('bob', candidate(2).tweetId, 'New release details')}</div>
    <div data-testid="cellInnerDiv">Carol liked your post${post('carol', candidate(3).tweetId, 'A quoted liked post')}</div>
    <div data-testid="cellInnerDiv">Dave reposted${post('dave', candidate(4).tweetId, 'Repost event')}</div>
    <div data-testid="cellInnerDiv">Eve followed you${post('eve', candidate(5).tweetId, 'Follow event')}</div>
    <div data-testid="cellInnerDiv">You might like${post('frank', candidate(6).tweetId, 'Recommended post')}</div>
    <div data-testid="cellInnerDiv">New post from Grace<a href="/grace/status/${candidate(7).tweetId}">View post</a></div>
  </main><aside>${post('sidebar', candidate(8).tweetId, 'Sidebar post')}</aside>`;
  const posts = collectNotificationTweets(doc(html), 'owner');
  assert.deepEqual(posts.map(p => [p.authorHandle, p.notificationKind]), [['alice', 'direct']]);
  assert.deepEqual(collectNotificationTweets(doc(html), ''), []);
});

test("batch selection handles direct replies without feed percentages and caps each visit at three", () => {
  const settings = createDefaultAgentSettings(); settings.humanize.replyPct = 100;
  const candidates = Array.from({ length: 12 }, (_, i) => candidate(i, i % 2 ? 'direct' : 'post'));
  const input = { settings, candidates, queue: { jobs: [] }, seenIds: [], account: 'owner', batchId: 'one', rng: () => 0.5 };
  const selected = selectNotificationDrafts(input);
  assert.equal(selected.length, 3);
  assert.ok(selected.every(j => j.kind === 'draft_reply' && j.expectedAccount === 'owner' && j.notificationBatchId === 'one'));
  settings.humanize.replyPct = 0;
  assert.equal(selectNotificationDrafts(input).length, 3);
  settings.humanize.replyPct = 35;
  assert.equal(selectNotificationDrafts({ ...input, rng: () => 0.9 }).length, 3);
  assert.ok(selected.every(j => j.notificationKind === 'direct'));
  const batch = finishNotificationBatch(observeNotificationBatch(undefined, 'owner', 3, now), selected.map(p => p.tweetId!), now);
  settings.humanize.replyPct = 100;
  assert.equal(selectNotificationDrafts({ ...input, seenIds: batch.seenIds }).length, 3, 'unselected conversations remain available in later visits');
});

test("direct replies outrank mentions, with conversation and cross-tab duplicate protection", () => {
  const mention = { ...candidate(1), notificationType: 'mention' as const, text: 'How does this work?' };
  const reply = { ...candidate(2), notificationType: 'reply' as const, conversationId: '123' };
  const sameThread = { ...candidate(3), notificationType: 'reply' as const, conversationId: '123' };
  const secondThread = { ...candidate(4), notificationType: 'reply' as const, conversationId: '456' };
  const selected = selectNotificationDrafts({ candidates: [mention, reply, sameThread, reply, secondThread, { ...candidate(5), text: 'gm bro!' }], settings: createDefaultAgentSettings(), queue: { jobs: [] }, seenIds: [], account: 'owner', batchId: 'priority' });
  assert.deepEqual(selected.map(j => j.tweetId), [reply.tweetId, secondThread.tweetId, mention.tweetId]);
});

test("reply notification cards recognize replies to a user's post or comment", () => {
  for (const label of ['Alice replied to your post', 'Alice replied to your reply', 'Alice đã trả lời bình luận của bạn']) {
    const posts = collectNotificationTweets(doc(`<main><div data-testid="notification">${label}<a href="/alice/status/${candidate(1).tweetId}">View</a></div></main>`), 'owner');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].notificationType, 'reply');
  }
});

test("notification navigation waits for a composer but permits an empty inline composer", () => {
  assert.equal(notificationNavigationBlocked(doc('<div data-testid="tweetTextarea_0"></div>')), false);
  assert.equal(notificationNavigationBlocked(doc('<div data-testid="tweetTextarea_0">unfinished reply</div>')), true);
  assert.equal(notificationNavigationBlocked(doc('<div role="dialog"><div data-testid="tweetTextarea_0"></div></div>')), true);
  assert.equal(notificationNavigationBlocked(doc('<div hidden><div data-testid="tweetTextarea_0">hidden draft</div></div>')), false);
});

test("planner does not navigate to Notifications without an authorized batch", () => {
  const settings = createDefaultAgentSettings(); settings.priority = 'browse_only';
  settings.modules = { ...settings.modules, pogoTasks: false, homeScroll: false, followingFeed: false, lists: false, notifications: true };
  const input = { settings, stats: createEmptyDailyStats(), queue: { jobs: [] }, campaigns: [], executeActions: true, ownHandle: 'owner', hasApiKey: true };
  assert.deepEqual(planNextAction(input), { type: 'idle', reason: 'notifications_waiting_for_unread' });
  const allowed = planNextAction({ ...input, notificationsAllowed: true });
  assert.equal(allowed.type === 'job' ? allowed.job.browseSurface : allowed.type, 'mentions');
  const homeAndNotifications = planNextAction({ ...input, notificationsAllowed: true, settings: { ...settings, modules: { ...settings.modules, homeScroll: true }, browseWeights: { home: 100, following: 0, lists: 0, mentions: 0 } } });
  assert.equal(homeAndNotifications.type === 'job' ? homeAndNotifications.job.browseSurface : homeAndNotifications.type, 'mentions', 'new notifications are processed regardless of their old weight');
  const jobs = selectNotificationDrafts({ candidates: [candidate(1)], settings: { ...settings, humanize: { ...settings.humanize, replyPct: 100 } }, queue: { jobs: [] }, seenIds: [], account: 'owner', batchId: 'authorized', rng: () => 0 });
  const pending = planNextAction({ ...input, queue: { jobs } });
  assert.equal(pending.type === 'job' ? pending.job.id : pending.type, jobs[0].id, 'selected draft survives badge clearing');
});
