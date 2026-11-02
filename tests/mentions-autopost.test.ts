import assert from "node:assert/strict";
import test from "node:test";
import { makeJob, sanitizeQueue, findReadyDraft } from "../src/domain/agent-queue.ts";
import { createDefaultAgentSettings, sanitizeAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { planNextAction } from "../src/agent/planner.ts";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";

function fixture() {
  const settings = sanitizeAgentSettings({ ...createDefaultAgentSettings(), autoPostDrafts: false });
  settings.priority = "browse_only"; settings.ownHandle = "owner"; settings.adaptiveRest = false;
  settings.modules = { ...settings.modules, pogoTasks: false, homeScroll: false, notifications: true };
  settings.actions = { reply: true, like: false, retweet: false, quote: false, follow: false };
  const ownerPost = { author: "owner", tweetId: "2112057695247180188", text: "Withdrawal fees are $1.", relationship: "parent" as const };
  const draft = makeJob({ kind: "draft_reply", source: "browse", browseSurface: "mentions", expectedAccount: "owner",
    tweetId: "2112057695247180190", tweetUrl: "https://x.com/alice/status/2112057695247180190", authorHandle: "alice",
    tweetText: "What is the withdrawal fee?", status: "done", draftText: "The withdrawal fee is $1.", ownerPost,
    notificationKind: "direct", conversationContext: "@owner: Withdrawal fees are $1." });
  const queue = sanitizeQueue({ jobs: [{ ...draft, replyReview: "pending" }] });
  const plan = () => planNextAction({ settings, stats: createEmptyDailyStats(), queue, campaigns: [], executeActions: settings.executeActions, ownHandle: settings.ownHandle, hasApiKey: false });
  return { settings, draft, queue, plan };
}

test("old waiting drafts automatically become posting jobs with account and conversation metadata", () => {
  const { settings, queue, plan, draft } = fixture();
  assert.ok(!("autoPostDrafts" in settings));
  assert.ok(!("replyReview" in queue.jobs[0]));
  assert.equal(findReadyDraft(queue, "draft_reply")?.id, draft.id);
  const action = plan();
  assert.equal(action.type, "job");
  if (action.type !== "job") return;
  assert.equal(action.job.kind, "post_reply");
  assert.equal(action.job.expectedAccount, "owner");
  assert.equal(action.job.draftText, draft.draftText);
  assert.deepEqual(action.job.ownerPost, draft.ownerPost);
  assert.equal(action.job.conversationContext, draft.conversationContext);
  queue.jobs.push({ ...action.job, status: "done" });
  assert.equal(findReadyDraft(queue, "draft_reply"), null, "a sent draft must not be posted again");
});

for (const disabled of ["account", "source", "reply", "execute"] as const) test(`automatic drafts still respect ${disabled}`, () => {
  const { settings, plan } = fixture();
  if (disabled === "account") settings.ownHandle = "other";
  if (disabled === "source") settings.modules.notifications = false;
  if (disabled === "reply") settings.actions.reply = false;
  if (disabled === "execute") settings.executeActions = false;
  const action = plan();
  assert.ok(action.type !== "job" || action.job.kind !== "post_reply");
});

test("restored waiting draft is sent without review or regenerating its text", async t => {
  const { settings, queue, draft } = fixture();
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get: async () => ({}), set: async () => {} } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  const listeners = new Set<(m: unknown) => void>(), disconnects = new Set<() => void>();
  const emit = (message: object) => { for (const fn of [...listeners]) fn(message); };
  const sent: string[] = [];
  const port = { sender: { id: "no-review", url: "https://x.com/notifications", frameId: 0, tab: { id: 212 } },
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) }, disconnect() {},
    postMessage(m: { type: string; requestId?: string; text?: string }) {
      if (m.type === "x_ping") emit({ type: "x_hello", handle: "owner", notificationCount: 0 });
      if (m.type === "x_prepare_tweet") emit({ type: "x_prepare_tweet_result", requestId: m.requestId, ok: true, tweetText: draft.tweetText });
      if (m.type === "x_reply") { sent.push(m.text!); emit({ type: "x_reply_result", requestId: m.requestId, ok: true, detail: "reply_confirmed" }); }
      if (m.type === "x_back_to_browse") emit({ type: "x_back_to_browse_result", requestId: m.requestId, ok: true });
    } };
  attachXPort(port as unknown as chrome.runtime.Port, "no-review");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("completed drafts must not call AI again"); });
  const result = await runAgentTick({ settings, queue, runtime: createInitialRuntime(), stats: createEmptyDailyStats(), extensionId: "no-review",
    appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {}, waitForDelay: async () => {} });
  assert.deepEqual(sent, [draft.draftText]);
  assert.equal(result.stats.reply, 1);
});
