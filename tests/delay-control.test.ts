import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { initAgentPanel } from "../src/sidepanel/agent-panel.ts";
import { createDefaultAgentSettings, createInitialRuntime, createEmptyDailyStats, type AgentPublicState } from "../src/domain/agent-settings.ts";
import { getXConnection } from "../src/background/x-bridge.ts";
import { saveAgentSettings, startMockAgent, pauseMockAgent, getAgentPublicState } from "../src/background/agent-store.ts";

test("editing delay survives agent broadcasts and saves the entered low range", async (t) => {
  const { document, window } = parseHTML(readFileSync(new URL("../src/sidepanel/sidepanel.html", import.meta.url), "utf8"));
  for (const select of document.querySelectorAll("select")) Object.defineProperty(select, "value", { configurable: true, writable: true, value: "" });
  const globals = { document, window, chrome: { runtime: { onMessage: { addListener() {} } } } };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  let state: AgentPublicState = { settings: createDefaultAgentSettings(), runtime: createInitialRuntime(), today: createEmptyDailyStats(), activity: [], recentJobs: [], x: getXConnection() };
  const saved = new Promise<void>((resolve) => {
    const panel = initAgentPanel(async (type, extra) => {
      assert.equal(type, "save_agent_settings");
      const settings = extra!.settings as AgentPublicState["settings"];
      assert.equal(settings.delaySecMin, 2);
      assert.equal(settings.delaySecMax, 5);
      state = { ...state, settings };
      resolve();
      return { ok: true, agent: state };
    });
    panel.showAgentData(state);
    const min = document.getElementById("ag-delay-min") as HTMLInputElement;
    const max = document.getElementById("ag-delay-max") as HTMLInputElement;
    min.value = "2";
    min.dispatchEvent(new window.Event("input", { bubbles: true }));
    max.value = "5";
    max.dispatchEvent(new window.Event("input", { bubbles: true }));
    panel.showAgentData({ ...state, runtime: { ...state.runtime, detail: "New progress" } });
    assert.equal(min.value, "2");
    assert.equal(max.value, "5");
    document.getElementById("btn-behavior-save")!.click();
  });
  await saved;
});

test("Source username saves without losing settings or overwriting edits on broadcasts", async t => {
  const { document, window } = parseHTML(readFileSync(new URL("../src/sidepanel/sidepanel.html", import.meta.url), "utf8"));
  for (const select of document.querySelectorAll("select")) Object.defineProperty(select, "value", { configurable: true, writable: true, value: "" });
  for (const [key, value] of Object.entries({ document, window, chrome: { runtime: { onMessage: { addListener() {} } } } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  const state: AgentPublicState = { settings: { ...createDefaultAgentSettings(), delaySecMin: 7, ownHandle: "old" }, runtime: createInitialRuntime(), today: createEmptyDailyStats(), activity: [], recentJobs: [], x: getXConnection() };
  let saved: AgentPublicState["settings"] | undefined;
  const panel = initAgentPanel(async (type, extra) => {
    assert.equal(type, "save_agent_settings");
    saved = extra!.settings as AgentPublicState["settings"];
    return { ok: true, agent: { ...state, settings: saved } };
  });
  panel.showAgentData(state);
  const input = document.getElementById("source-own-handle") as HTMLInputElement;
  assert.equal(input.value, "old");
  input.value = "@MyAccount";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  panel.showAgentData(state);
  assert.equal(input.value, "@MyAccount");
  document.getElementById("btn-source-account-save")!.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved?.ownHandle, "MyAccount");
  assert.equal(saved?.skipOwnPosts, true);
  assert.equal(saved?.delaySecMin, 7);
  assert.equal((document.getElementById("ag-own-handle") as HTMLInputElement).value, "MyAccount");
});

test("saving a lower delay reschedules a waiting agent and does not resume a paused agent", async (t) => {
  let clock = 1900000000000;
  t.mock.method(Date, "now", () => clock);
  const storage: Record<string, unknown> = {};
  const alarms: Array<{ when?: number }> = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "delay-test", async sendMessage() {} },
    storage: { local: {
      async get(key: string) { return { [key]: storage[key] }; },
      async set(values: object) { Object.assign(storage, values); },
    } },
    alarms: { async create(_name: string, opts: { when?: number }) { alarms.push(opts); } },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  await startMockAgent();
  await saveAgentSettings({ ...createDefaultAgentSettings(), delaySecMin: 1, delaySecMax: 3 });
  let state = await getAgentPublicState();
  assert.ok(state.runtime.nextActionAt! >= clock + 1000 && state.runtime.nextActionAt! <= clock + 3000);
  assert.equal(alarms.at(-1)?.when, state.runtime.nextActionAt);
  await pauseMockAgent();
  const count = alarms.length;
  clock += 1000;
  await saveAgentSettings({ ...state.settings, delaySecMin: 2, delaySecMax: 4 });
  state = await getAgentPublicState();
  assert.equal(state.runtime.status, "paused");
  assert.equal(state.runtime.nextActionAt, null);
  assert.equal(alarms.length, count);
});
