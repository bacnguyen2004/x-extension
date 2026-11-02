import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { initAiUsagePanel } from "../src/sidepanel/ai-usage-panel.ts";
import { createDefaultAiSettings, toPublicAiSettings } from "../src/domain/ai-settings.ts";
import { usageDay } from "../src/domain/ai-usage.ts";

test("usage panel shows requests, input, output and cache separately for each task including Post", async t => {
  const { document } = parseHTML('<section id="ai-usage"><div id="ai-usage-summary"></div><div id="ai-usage-details"></div><div id="ai-usage-prices"></div><p id="ai-usage-msg"></p><input id="ai-usage-period" value="all"><button id="btn-ai-usage-refresh"></button><button id="btn-ai-prices-save"></button></section>');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "document", descriptor) : Reflect.deleteProperty(globalThis, "document"));
  const row = { day: usageDay(), endpoint: "https://api.openai.com/v1", model: "test-model", calls: 2, unknown: 0, input: 1000, cached: 700, output: 50 };
  const panel = initAiUsagePanel(async type => type === "get_ai_settings"
    ? { ok: true, settings: toPublicAiSettings(createDefaultAiSettings()) }
    : { ok: true, usage: { startedAt: Date.now(), prices: {}, buckets: [{ ...row, kind: "browse_reply" }, { ...row, kind: "mention_reply" }, { ...row, kind: "post" }] } });
  await panel.load();
  const details = document.getElementById("ai-usage-details")!;
  assert.equal(details.children.length, 3);
  for (const item of details.children) {
    assert.ok(item.textContent?.includes("2 API requests"));
    assert.ok(item.textContent?.includes("1.000 input"));
    assert.ok(item.textContent?.includes("50 output"));
    assert.ok(item.textContent?.includes("700 cached tokens"));
  }
  assert.ok(details.textContent?.includes("Post"));
  assert.ok(document.getElementById("ai-usage-summary")?.textContent?.includes("6 lần gọi"));
});
