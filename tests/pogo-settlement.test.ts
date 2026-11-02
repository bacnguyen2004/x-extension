import assert from "node:assert/strict";
import test from "node:test";
import { pogoSettlementCheckAt } from "../src/domain/pogo-settlement.ts";
import { loadPogoSettlementClock, observePogoSettlementClock } from "../src/background/pogo-settlement-store.ts";


test("payout clocks survive worker restarts and stay isolated by account", async t => {
 const disk: Record<string, unknown> = {};
 const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
 Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
   get: async (key: string) => ({ [key]: structuredClone(disk[key]) }),
   set: async (patch: object) => Object.assign(disk, structuredClone(patch)),
 } } } });
 t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
 const next = Date.now() + 160000;
 assert.equal(await observePogoSettlementClock("@Alice", next), true);
 assert.equal((await loadPogoSettlementClock("alice"))!.nextScanAt, next);
 assert.equal(await loadPogoSettlementClock("bob"), null);
 assert.equal(await observePogoSettlementClock("alice", next), false);
 assert.equal(await observePogoSettlementClock("unknown", next), false);
 assert.equal(await observePogoSettlementClock("bob", Date.now() + 86400000), false);
});

test("API scan boundaries retain the grace period when polling rolls forward", () => {
 const now=Date.parse("2026-10-23T09:33:47.196Z"),at=Date.parse("2026-10-23T09:36:27.196Z");
 assert.equal(pogoSettlementCheckAt(now,{nextScanAt:at,observedAt:now}),at+20000);
 assert.equal(pogoSettlementCheckAt(at+1,{nextScanAt:at,observedAt:now}),at+620000);
 assert.equal(pogoSettlementCheckAt(now,{nextScanAt:at+600000,observedAt:now}),at+20000);
});
