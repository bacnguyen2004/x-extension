import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";
import type { AgentQueueState } from "../src/domain/agent-queue.ts";
import type { TimelineTweet } from "../src/x/timeline.ts";

test("Notifications checks periodically, reads Mentions before All, skips KOL posts and auto replies without duplicates", async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const settings = createDefaultAgentSettings(); settings.priority = 'browse_only'; settings.ownHandle = 'owner'; settings.adaptiveRest = false;
  settings.notificationCooldownMin = 15;
  settings.modules = { ...settings.modules, pogoTasks: false, homeScroll: false, followingFeed: false, lists: false, notifications: true };
  settings.humanize.replyPct = 100;
  settings.actions = { reply: true, like: false, quote: false, retweet: false, follow: false };
  const ai = createDefaultAiSettings(); ai.apiKey = 'fake-key'; ai.mentionReply.systemPrompt = 'DIRECTPROMPT'; ai.browseReply.systemPrompt = 'POSTPROMPT';
  const disk: Record<string, any> = { 'pogoTaskReader.aiSettings.v1': ai };
  const old = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { id: 'notify-test', sendMessage: async () => {} }, storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, structuredClone(patch)); } } } } });
  t.after(() => old ? Object.defineProperty(globalThis, 'chrome', old) : Reflect.deleteProperty(globalThis, 'chrome'));
  const candidates: TimelineTweet[] = Array.from({ length: 4 }, (_, i) => {
    const tweetId = String(2112057695247180100n + BigInt(i));
    return { tweetId, authorHandle: 'alice', tweetUrl: `https://x.com/alice/status/${tweetId}`, text: i % 2 ? null : 'An incoming direct message', notificationKind: i % 2 ? 'post' : 'direct', directedToOwn: i % 2 === 0, alreadyLiked: false, promoted: false };
  });
  const listeners = new Set<(m: any) => void>(), disconnects = new Set<() => void>();
  const emit = (m: object) => { for (const fn of [...listeners]) fn(m); };
  let badge: number | null = null, scans = 0;
  const commands: any[] = [], aiPrompts: string[] = [];
  let activeKind: string | undefined;
  const port = { sender: { id: 'notify-test', url: 'https://x.com/home', frameId: 0, tab: { id: 177 } }, onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) }, onDisconnect: { addListener: (fn: any) => disconnects.add(fn), removeListener: (fn: any) => disconnects.delete(fn) }, disconnect() {}, postMessage(m: any) {
    commands.push(m);
    if (m.type === 'x_ping') emit({ type: 'x_hello', handle: 'owner', onHome: true, href: 'https://x.com/home', notificationCount: badge });
    if (m.type === 'x_back_to_browse') emit({ type: 'x_back_to_browse_result', requestId: m.requestId, ok: true, href: 'https://x.com/notifications', notificationCount: badge });
    if (m.type === 'x_timeline_scan') {
      assert.equal(m.browseSurface, 'mentions'); scans++; badge = 0;
      emit({ type: 'x_timeline_scan_result', requestId: m.requestId, ok: true, tweets: candidates, notificationCount: 0, href: 'https://x.com/notifications' });
    }
    if (m.type === 'x_prepare_tweet') {
      const post = candidates.find(c => c.tweetId === m.tweetId)!; activeKind = post.notificationKind;
      emit({ type: 'x_prepare_tweet_result', requestId: m.requestId, ok: true, tweetText: post.notificationKind === 'post' ? 'Fresh release notes are available for the new version.' : 'Thanks @owner for the release notes.', notificationKind: post.notificationKind, notificationCount: badge, href: post.tweetUrl });
    }
    if (m.type === 'x_scroll_burst') emit({ type: 'x_scroll_result', requestId: m.requestId, ok: true, notificationCount: badge, href: 'https://x.com/home', onHome: true });
    if (m.type === 'x_reply') emit({ type: 'x_reply_result', requestId: m.requestId, ok: true, detail: 'reply_confirmed' });
  } };
  attachXPort(port as any, 'notify-test'); t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(Math, 'random', () => 0);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); aiPrompts.push(body.messages[0].content);
    assert.match(body.messages[0].content, activeKind === 'post' ? /POSTPROMPT/ : /DIRECTPROMPT/);
    assert.match(body.messages[1].content, activeKind === 'post' ? /Fresh release notes/ : /Thanks @owner/);
    return Response.json({ choices: [{ message: { content: 'The release notes should make the changes easier to follow.' }, finish_reason: 'stop' }] });
  });
  let runtime = createInitialRuntime(), queue: AgentQueueState = { jobs: [] }, stats = createEmptyDailyStats();
  const tick = async () => {
    const result = await runAgentTick({ settings, runtime, queue, stats, extensionId: 'notify-test', appendActivity: async () => {}, persistQueue: async q => { disk.queue = structuredClone(q); }, persistStats: async () => {}, waitForDelay: async () => {} });
    runtime = result.runtime; queue = result.queue; stats = result.stats;
  };
  const setBadge = (count: number | null) => { badge = count; emit({ type: 'x_hello', handle: 'owner', notificationCount: badge }); };
  await tick(); setBadge(0); await tick(); setBadge(1); await tick();
  assert.equal(scans, 0);
  now += 15 * 60000; await tick();
  assert.equal(scans, 1);
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(queue.jobs.filter(j => j.kind === 'draft_reply' && j.status === 'done').length, 2);
  assert.equal(commands.filter(m => m.type === 'x_reply').length, 2);
  assert.equal(aiPrompts.length, 2);
  assert.ok(aiPrompts.every(p => p.includes('DIRECTPROMPT')));
  assert.deepEqual(commands.filter(m => m.type === 'x_timeline_scan').map(m => m.notificationTab), ['mentions', 'mentions', 'all']);
  await tick();
  assert.ok(commands.some(m => m.type === 'x_scroll_burst' && m.browseSurface === 'home' && m.restoreNotificationPosition));
  const exitAt = now;
  assert.ok(runtime.notificationBatch!.nextEligibleAt >= exitAt + 15 * 60000);
  setBadge(1); now += 60000; await tick();
  assert.equal(scans, 3, 'one fresh badge must not bounce the worker back into Notifications');
  now += 16 * 60000;
  const extra = { ...candidates[0], tweetId: '2112057695247180199', tweetUrl: 'https://x.com/alice/status/2112057695247180199' };
  candidates.push(extra); await tick();
  assert.equal(scans, 4);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(queue.jobs.filter(j => j.kind === 'draft_reply').length, 3, 'old direct replies and KOL posts must not be selected again');
  assert.ok(!commands.some(m => m.type === 'x_like' || m.type === 'x_retweet'));
});
