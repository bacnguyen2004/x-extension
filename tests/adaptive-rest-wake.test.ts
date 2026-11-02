import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAgentSettings, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { readAdaptiveRest, waitForRest } from "../src/domain/adaptive-rest.ts";
import { getAgentPublicState, tickMockAgent, saveAgentSettings, pauseMockAgent } from "../src/background/agent-store.ts";

test("worker reload honors persisted resumeAt; changing delay preserves it; due work resumes but manual pause stays paused", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const resumeAt = now + 20 * 60000;
  const settings = createDefaultAgentSettings();
  settings.executeActions = false; settings.modules.homeScroll = false; settings.modules.pogoTasks = false;
  const disk: Record<string, unknown> = {
    "xContentCreator.agentSettings.v1": settings,
    "xContentCreator.agentRuntime.v1": { ...createInitialRuntime(), status: "waiting", nextActionAt: null, detail: "Đang nghỉ · Tải cao",
      adaptiveRest: waitForRest({ ...readAdaptiveRest(undefined, now), activeMs: 1800000 }, "high_load", resumeAt, now) },
  };
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "rest-wake", sendMessage: async () => {} },
    storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (p: object) => Object.assign(disk, structuredClone(p)) } },
    alarms: { create: async () => {}, clear: async () => {} },
  } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const woke = await getAgentPublicState();
  assert.equal(woke.runtime.nextActionAt, resumeAt);
  assert.match(woke.runtime.detail, /Tải cao/);
  await saveAgentSettings({ ...settings, delaySecMin: 5, delaySecMax: 5 });
  assert.equal((await getAgentPublicState()).runtime.nextActionAt, resumeAt);
  now = resumeAt - 1;
  assert.equal((await tickMockAgent()).runtime.nextActionAt, resumeAt);
  now = resumeAt + 1;
  const resumed = await tickMockAgent();
  assert.equal(resumed.runtime.status, "waiting");
  assert.equal(resumed.runtime.adaptiveRest?.activeMs, 0);
  assert.equal(resumed.runtime.adaptiveRest?.reason, "no_tasks");
  await pauseMockAgent();
  now += 86400000;
  assert.equal((await tickMockAgent()).runtime.status, "paused");
});
