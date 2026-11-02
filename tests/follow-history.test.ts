import assert from "node:assert/strict";
import test from "node:test";
import { loadFollowHistory, loadFollowHistoryEntries, readFollowHistoryView, rememberFollow } from "../src/background/follow-history.ts";
import { attachXPort, requestFollow, requestFollowProfileMeta, requestUnfollowProfile } from "../src/background/x-bridge.ts";
import { saveFollowSettings, loadFollowSettings } from "../src/background/follow-store.ts";
import { createDefaultFollowSettings } from "../src/domain/follow-settings.ts";

test("follow history persists across days, isolates accounts and merges concurrent writes", async context => {
  const disk: Record<string, unknown> = {};
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string | null) => key === null ? { ...disk } : ({ [key]: disk[key] }),
    set: async (values: object) => { Object.assign(disk, JSON.parse(JSON.stringify(values))); },
  } } } });
  context.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  await Promise.all([rememberFollow("@Me", "@Alice"), rememberFollow("me", "Bob")]);
  assert.deepEqual([...(await loadFollowHistory("ME"))].sort(), ["alice", "bob"]);
  const offline = await readFollowHistoryView("");
  assert.equal(offline.account, "me");
  assert.equal(offline.connectedAccount, false);
  assert.equal(offline.entries.length, 2);
  const other = await readFollowHistoryView("another");
  assert.equal(other.account, "another");
  assert.equal(other.connectedAccount, true);
  assert.equal(other.entries.length, 0);
  context.mock.method(Date, "now", () => 2000000000000);
  assert.equal((await loadFollowHistory("me")).has("alice"), true);
  assert.equal((await loadFollowHistory("another")).size, 0);
  await rememberFollow("me", "alice", true, { verified: true, followsYou: false, sorsa: 0 });
  await rememberFollow("me", "alice");
  let alice = (await loadFollowHistoryEntries("me")).find(entry => entry.handle === "alice")!;
  assert.equal(alice.verified, true);
  assert.equal(alice.followsYou, false);
  assert.equal(alice.sorsa, 0);
  disk["xContentCreator.followHistory.v1.legacy"] = ["@Carol", "bad handle"];
  const legacy = await loadFollowHistoryEntries("legacy");
  assert.equal(legacy[0].handle, "carol");
  assert.equal(legacy[0].verified, null);
  assert.equal(legacy[0].followsYou, null);
  assert.equal(legacy[0].updatedAt, null);
  disk["xContentCreator.sorsaCache.v1"] = { alice: { score: 1160.38, at: Date.now() } };
  alice = (await loadFollowHistoryEntries("me")).find(entry => entry.handle === "alice")!;
  assert.equal(alice.sorsa, 1160.38);
  await rememberFollow("me", "alice", false);
  assert.deepEqual([...(await loadFollowHistory("me"))], ["bob"]);
  await rememberFollow("unknown", "alice");
  assert.equal((await loadFollowHistory("unknown")).size, 0);
});

test("X evidence automatically remembers existing, confirmed and requested follows, and removes confirmed unfollows", async context => {
  const settings = { ...createDefaultFollowSettings(), usernameList: "@Alice\nBOB, https://x.com/carol\n@untouched" };
  const disk: Record<string, unknown> = { "xContentCreator.follow.v1": settings };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: disk[key] }),
    set: async (values: object) => { Object.assign(disk, values); },
  } } } });
  context.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  let detail = "follow_confirmed";
  const listeners = new Set<(message: unknown) => void>();
  const disconnects = new Set<() => void>();
  const emit = (message: object) => { for (const listener of listeners) listener(message); };
  const port = {
    sender: { id: "history-test", url: "https://x.com/home", tab: { id: 102 }, frameId: 0 },
    onMessage: { addListener: (listener: (message: unknown) => void) => listeners.add(listener), removeListener: (listener: (message: unknown) => void) => listeners.delete(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnects.add(listener), removeListener: (listener: () => void) => disconnects.delete(listener) },
    postMessage(message: { type: string; requestId?: string }) {
      if (message.type === "x_ping") { emit({ type: "x_hello", handle: "me", onHome: true }); return; }
      emit({ type: `${message.type}_result`, requestId: message.requestId, ok: true, detail,
        meta: { onProfile: true, alreadyFollowing: true } });
    },
    disconnect() {},
  };
  attachXPort(port as unknown as chrome.runtime.Port, "history-test");
  context.after(() => { for (const listener of disconnects) listener(); });
  await requestFollow({ authorHandle: "alice", tweetUrl: null });
  assert.equal((await loadFollowSettings()).usernameList, "@bob\n@carol\n@untouched");
  detail = "follow_requested";
  await requestFollow({ authorHandle: "bob", tweetUrl: null });
  await requestFollowProfileMeta("carol");
  assert.equal((await loadFollowSettings()).usernameList, "@untouched");
  const savedAgain = await saveFollowSettings(settings);
  assert.equal(savedAgain.usernameList, "@untouched", "pasting the original list cannot requeue completed handles");
  assert.deepEqual(savedAgain.filters, settings.filters);
  assert.equal((await loadFollowHistoryEntries("me")).find(entry => entry.handle === "bob")?.status, "requested");
  detail = "own_profile";
  await requestFollow({ authorHandle: "ignored", tweetUrl: null });
  assert.deepEqual([...(await loadFollowHistory("me"))].sort(), ["alice", "bob", "carol"]);
  detail = "unfollow_confirmed";
  await requestUnfollowProfile("alice");
  assert.equal((await loadFollowSettings()).usernameList, "@untouched", "unfollow does not reinsert into the source list");
  assert.deepEqual([...(await loadFollowHistory("me"))].sort(), ["bob", "carol"]);
});
