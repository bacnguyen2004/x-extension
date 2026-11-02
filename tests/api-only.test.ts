import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createInitialState } from "../src/domain/types.ts";
import { snapshotFromFeedBody } from "../src/api/feed-client.ts";
import { applyPogoFeedRefresh } from "../src/background/pogo-state-access.ts";
import { loadPogoRetweetPower } from "../src/background/pogo-retweet-store.ts";
import { loadPogoSettlementClock } from "../src/background/pogo-settlement-store.ts";
import { syncPogoFeedMeta } from "../src/background/pogo-feed-meta.ts";

test("extension injects only into X with an early navigation guard and API-only Pogo access", () => {
 const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
 assert.equal(manifest.permissions.includes("webNavigation"), false);
 assert.ok(manifest.host_permissions.includes("https://pogo.social/*"), "keep access to the Pogo API");
 assert.equal(manifest.permissions.includes("debugger"), false);
 assert.equal(manifest.content_scripts.length, 2);
 const guard = manifest.content_scripts.find((script: { world?: string }) => script.world === "MAIN");
 assert.deepEqual(guard.js, ["content/x-navigation-guard.js"]);
 assert.equal(guard.run_at, "document_start");
 assert.ok(manifest.content_scripts.some((script: { js: string[] }) => script.js.includes("content/x-content.js")));
 for (const script of manifest.content_scripts) assert.ok(script.matches.every((url: string) => /^https:\/\/(x|twitter)\.com\//.test(url)));
 const build = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
 assert.equal((build.match(/entryPoints:/g) ?? []).length, 4);
});

test("API feed alone supplies tasks, 25% RT allowance and the payout clock", async t => {
 const disk: Record<string, unknown> = { "pogoTaskReader.state": createInitialState() };
 const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
 Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
   get: async (key: string) => ({ [key]: structuredClone(disk[key]) }),
   set: async (patch: object) => Object.assign(disk, structuredClone(patch)),
 } } } });
 t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
 const now = Date.now();
 const snapshot = snapshotFromFeedBody({ linked_handle: "api_user", campaigns: [
   { tweet_id: "2112057695247180169", author_handle: "author", follows_author: true, locked_points: 0 },
 ], retweet_power: { used: 12, full: 10, reduced: 10, reduced_pct: 25 },
 polling: { last_swept_at: new Date(now - 440000).toISOString(), interval_seconds: 600 } }, now);
 const campaigns = await applyPogoFeedRefresh(snapshot);
 await syncPogoFeedMeta(snapshot);
 assert.equal(campaigns.length, 1);
 const power = await loadPogoRetweetPower("api_user");
 assert.equal(power.used, 12);
 assert.equal(power.limit, 20);
 assert.equal(power.limit! - power.used, 8);
 assert.ok(power.observedAt);
 assert.equal((await loadPogoSettlementClock("api_user"))!.nextScanAt, now + 160000);
});
