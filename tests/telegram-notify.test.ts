import assert from "node:assert/strict";
import test from "node:test";
import { notifyTelegram, queueBountyTelegram, flushBountyNotifications } from "../src/background/telegram-notify.ts";

test("notifications coalesce, survive worker retries, whitelist counters, and tolerate native host failures", async t => {
  const disk: Record<string, unknown> = {};
  const calls: Record<string, unknown>[] = [];
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { sendNativeMessage: async (_host: string, message: Record<string, unknown>) => { calls.push(message); throw Error("private host detail"); } },
    storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => Object.assign(disk, patch) } },
  } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  await Promise.all(Array.from({ length: 10 }, () => notifyTelegram("agent_error", { account: "viewer" })));
  await notifyTelegram("agent_error", { account: "viewer" });
  assert.equal(calls.length, 1);
  await notifyTelegram("hourly_summary", { account: "viewer", status: "waiting", stats: { date: "2026-10-24", reply: 4, follow: 5, like: 6, retweet: 7, quote: 0, scrollSessions: 9, pogoRetweets: { secret: "do not forward" } as never } });
  assert.deepEqual(calls[1].stats, { reply: 4, follow: 5, retweet: 7, like: 6, quote: 0 });
  assert.equal(JSON.stringify(calls).includes("secret"), false);
  await notifyTelegram("pogo_bounty", { bounty: { kind: "joined", id: 99, title: "Open bounty\nsecret", fee: 0, slots: 3 } });
  await notifyTelegram("pogo_bounty", { bounty: { kind: "joined", id: 99, title: "Open bounty", fee: 0, slots: 3 } });
  await notifyTelegram("pogo_bounty", { bounty: { kind: "new", id: 100, title: "Next", fee: 10, slots: 2 } });
  assert.equal(calls.filter((c) => c.event === "pogo_bounty").length, 2);
  assert.deepEqual(calls[2].bounty, { kind: "joined", id: 99, title: "Open bounty secret", fee: 0, slots: 3 });
  assert.deepEqual(calls[3].bounty, { kind: "new", id: 100, title: "Next", fee: 10, slots: 2 });
});

test("bounty delivery failures stay on disk and retry after worker reload without losing other notices", async t => {
  const disk: Record<string, unknown> = {};
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let now = Date.now(), calls = 0, available = false;
  t.mock.method(Date, "now", () => now);
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: {sendNativeMessage: async () => {calls++; return {ok: available};}},
    storage: {local: {
      get: async (key: string) => ({[key]: structuredClone(disk[key])}),
      set: async (patch: object) => Object.assign(disk, structuredClone(patch)),
    }},
  }});
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const bounty = {kind: "new" as const, id: 501, title: "FCFS", fee: 0, slots: 2};
  await Promise.all([queueBountyTelegram({bounty,scope:"A"}),queueBountyTelegram({bounty,scope:"B"})]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 2, "the same bounty on distinct accounts must get distinct alerts");
  await flushBountyNotifications(); assert.equal(calls, 2, "a failed send has a short retry cooldown");
  const reloadPath = "../src/background/telegram-notify.ts?bounty-worker-reload";
  const reloaded = await import(reloadPath) as typeof import("../src/background/telegram-notify.ts");
  now += 31000; available = true;
  await reloaded.flushBountyNotifications(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 4);
  now += 31000; await reloaded.flushBountyNotifications();
  assert.equal(calls, 4, "only confirmed delivery suppresses retries");
  const entries = disk["xContentCreator.bountyNotifications.v1"] as Array<{delivered: boolean}>;
  assert.equal(entries.length, 2); assert.ok(entries.every(n => n.delivered));
});
