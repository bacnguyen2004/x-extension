import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { initSmmPanel } from "../src/sidepanel/smm-panel.ts";
import { createDefaultSmmSettings, createEmptyScanSnapshot, toPublicSmmSettings, type SmmPublicState } from "../src/domain/smm-settings.ts";

test("SMM progress keeps Stop enabled and blocks scan/retry until ordering ends", (t) => {
  const { document } = parseHTML(readFileSync(new URL("../src/sidepanel/sidepanel.html", import.meta.url), "utf8"));
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => original ? Object.defineProperty(globalThis, "document", original) : Reflect.deleteProperty(globalThis, "document"));
  const panel = initSmmPanel(async () => ({ ok: true }));
  const smm: SmmPublicState = {
    settings: toPublicSmmSettings(createDefaultSmmSettings()), balance: null, currency: null,
    servicesLoaded: 0, recentOrders: [], scan: { ...createEmptyScanSnapshot(), scanning: true, status: "Đã đặt 1 đơn…" },
  };
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
  panel.onMessage({ type: "smm_state", smm });
  assert.equal(button("smm-btn-scan-stop").disabled, false);
  assert.equal(button("smm-btn-scan").disabled, true);
  assert.equal(button("smm-btn-retry").disabled, true);
  panel.onMessage({ type: "smm_state", smm: { ...smm, scan: { ...smm.scan, scanning: false } } });
  assert.equal(button("smm-btn-scan-stop").disabled, true);
  assert.equal(button("smm-btn-scan").disabled, false);
  assert.equal(button("smm-btn-retry").disabled, false);
});
