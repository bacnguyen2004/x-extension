import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAgentSettings, createInitialRuntime, sanitizeAgentSettings } from "../src/domain/agent-settings.ts";
import { tickMockAgent, saveAgentSettings, setKillSwitch } from "../src/background/agent-store.ts";

test("continuous mode migrates old settings and passes both loop caps while finite mode and kill remain effective", async t => {
  assert.equal(sanitizeAgentSettings({ maxLoops: 500, sessionLimit: 1000 }).continuousRun, true);
  assert.equal(sanitizeAgentSettings({ continuousRun: false }).continuousRun, false);
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const settings = createDefaultAgentSettings();
  settings.executeActions = false;
  settings.modules.homeScroll = false;
  settings.modules.pogoTasks = false;
  const disk: Record<string, unknown> = {
    "xContentCreator.agentSettings.v1": settings,
    "xContentCreator.agentRuntime.v1": { ...createInitialRuntime(), status: "waiting", loopCount: 1001, nextActionAt: clock - 1000 },
  };
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "continuous-test", sendMessage: async () => {} },
    storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => Object.assign(disk, patch) } },
    alarms: { create: async () => {}, clear: async () => {} },
  } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const running = await tickMockAgent();
  assert.equal(running.runtime.status, "waiting");
  assert.ok(running.runtime.nextActionAt! > clock);
  await saveAgentSettings({ ...settings, continuousRun: false });
  clock = running.runtime.nextActionAt! + 1;
  const finite = await tickMockAgent();
  assert.equal(finite.runtime.status, "paused");
  assert.match(finite.runtime.detail, /giới hạn vòng/);
  await saveAgentSettings({ ...settings, continuousRun: true });
  assert.equal((await tickMockAgent()).runtime.status, "paused", "settings do not override a pause");
  await setKillSwitch(true);
  assert.equal((await tickMockAgent()).runtime.killSwitch, true);
  assert.equal((await tickMockAgent()).runtime.status, "paused");
});
