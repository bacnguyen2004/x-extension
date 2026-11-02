import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAgentSettings, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { ensureAgentAlarmsAfterWake, getAgentPublicState, tickMockAgent } from "../src/background/agent-store.ts";

test("worker wake preserves overdue work so alarm handling executes instead of postponing every time", async context => {
  let clock = 1900000000000;
  context.mock.method(Date, "now", () => clock);
  const due = clock - 30000;
  const settings = createDefaultAgentSettings();
  settings.executeActions = false;
  settings.modules.homeScroll = false;
  settings.modules.pogoTasks = false;
  const disk: Record<string, unknown> = {
    "xContentCreator.agentSettings.v1": settings,
    "xContentCreator.agentRuntime.v1": { ...createInitialRuntime(), status: "waiting", nextActionAt: due },
  };
  const alarms: Array<{ when?: number }> = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "wake-test", sendMessage: async () => {} },
    storage: { local: {
      get: async (key: string) => ({ [key]: disk[key] }),
      set: async (values: object) => { Object.assign(disk, values); },
    } },
    alarms: { create: async (_name: string, options: { when?: number }) => { alarms.push(options); } },
  } });
  context.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  await ensureAgentAlarmsAfterWake();
  assert.equal((await getAgentPublicState()).runtime.nextActionAt, due);
  const first = await tickMockAgent();
  assert.match(first.runtime.detail, /^Idle:/);
  const next = first.runtime.nextActionAt!;
  assert.ok(next > clock);
  await ensureAgentAlarmsAfterWake();
  assert.equal((await getAgentPublicState()).runtime.nextActionAt, next);
  clock = next + 120000;
  await ensureAgentAlarmsAfterWake();
  assert.equal((await getAgentPublicState()).runtime.nextActionAt, next);
  const resumed = await tickMockAgent();
  assert.ok(resumed.runtime.nextActionAt! > clock);
  assert.ok(alarms.some(alarm => alarm.when === clock + 1000));
});
