import assert from "node:assert/strict";
import test from "node:test";
import { priceKey, readTokenUsage, summarizeUsage, usageCost, usageDay, usageEndpoint } from "../src/domain/ai-usage.ts";
import { getAiUsage, recordAiUsage, saveAiPrices } from "../src/background/ai-usage-store.ts";
import { generateDraft, generateWithChatCompletions } from "../src/agent/ai-client.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";

test("token accounting counts cached input once and reasoning as part of completion, without guessing missing usage", () => {
  const tokens = readTokenUsage({ usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 300 } } });
  assert.deepEqual(tokens, { input: 1000, cached: 200, output: 500 });
  assert.equal(usageCost(tokens!, { input: 1, cached: 0.5, output: 2 }), 0.0019);
  assert.equal(usageCost(tokens!), null);
  assert.equal(readTokenUsage({}), null);
  assert.equal(readTokenUsage({ usage: { prompt_tokens: -1, completion_tokens: 100 } }), null);
  assert.equal(usageEndpoint("https://user:password@proxy.test/v1/?api_key=secret#secret"), "https://proxy.test/v1");
  assert.equal(usageDay(Date.parse("2026-10-31T17:00:00Z")), "2026-11-01");
});

test("records each paid pass, skipped output, incomplete output, uncertain retries and concurrent calls; saves prices separately", async t => {
  const disk: Record<string, any> = {};
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: structuredClone(disk[key]) }),
    set: async (patch: object) => { Object.assign(disk, structuredClone(patch)); },
  } } } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const settings = { ...createDefaultAiSettings(), apiKey: "fake-private-key", baseUrl: "https://proxy.test/v1?secret=hidden", model: "test-model" };
  const replies: Array<{ text?: string; length?: boolean; error?: boolean }> = [
    { text: "SKIP_REPLY" }, { text: "unfinished", length: true },
    { text: "Lower withdrawal fees make small transfers less costly." },
    { error: true }, { text: "A completed response." },
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const next = replies.shift(); assert.ok(next, "unexpected extra call");
    if (next.error) return Response.json({ error: { message: "temperature unsupported" } }, { status: 400 });
    return Response.json({ usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 300 } }, choices: [{ finish_reason: next.length ? "length" : "stop", message: { content: next.text } }] });
  });
  const vars = { author: "alice", text: "Withdrawal fees fell from $5 to $1.", tweet_url: "https://x.com/alice/status/2112057695247180169", tweet_id: "2112057695247180169" };
  assert.equal((await generateDraft(settings, "mention_reply", vars)).ok, true);
  assert.equal((await generateDraft(settings, "quote", vars)).ok, false);
  assert.equal((await generateDraft(settings, "browse_reply", vars)).ok, true);
  assert.equal((await generateWithChatCompletions(settings, "system", "user")).ok, true);
  await Promise.all(Array.from({ length: 30 }, () => recordAiUsage(settings.baseUrl, settings.model, "reply", { usage: { prompt_tokens: 10, completion_tokens: 5 } })));
  let data = await getAiUsage();
  let summary = summarizeUsage(data, "today");
  assert.equal(summary.calls, 35);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.unpriced, 34);
  assert.equal(summary.input, 4300);
  assert.equal(summary.output, 2150);
  assert.equal(data.buckets.find(b => b.kind === "browse_reply")!.calls, 1);
  assert.equal(data.buckets.find(b => b.kind === "quote")!.output, 500, "incomplete generations still consume output tokens");
  assert.ok(!JSON.stringify(disk).includes("private-key"));
  assert.ok(!JSON.stringify(disk).includes("Withdrawal"));
  assert.ok(!JSON.stringify(disk).includes("hidden"));
  data = await saveAiPrices([{ endpoint: settings.baseUrl, model: settings.model, price: { input: 1, cached: 0.5, output: 2 } }]);
  summary = summarizeUsage(data, "all");
  assert.equal(summary.unpriced, 0);
  assert.ok(Math.abs(summary.cost - 0.0082) < 1e-12);
  await assert.rejects(saveAiPrices([{ endpoint: settings.baseUrl, model: settings.model, price: { input: -1, cached: 0, output: 2 } }]));
  await saveAiPrices([{ endpoint: settings.baseUrl, model: settings.model, price: { input: 0, cached: 0, output: 0 } }]);
  assert.equal(summarizeUsage(await getAiUsage(), "all").cost, 0);
  await saveAiPrices([{ endpoint: settings.baseUrl, model: settings.model, price: null }]);
  assert.equal((await getAiUsage()).prices[priceKey(usageEndpoint(settings.baseUrl), settings.model)], undefined);
});

test("month and today summaries follow Vietnam midnight, and never reset the lifetime history", () => {
  const at = Date.parse("2026-10-31T17:00:00Z");
  const row = { endpoint: "https://proxy.test/v1", model: "test", kind: "reply" as const, calls: 1, unknown: 0, input: 100, cached: 0, output: 20 };
  const data = { startedAt: at, prices: {}, buckets: [{ ...row, day: "2026-10-31" }, { ...row, day: "2026-11-01" }] };
  assert.equal(summarizeUsage(data, "today", at).calls, 1);
  assert.equal(summarizeUsage(data, "month", at).calls, 1);
  assert.equal(summarizeUsage(data, "all", at).calls, 2);
});
