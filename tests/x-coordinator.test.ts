import assert from "node:assert/strict";
import test from "node:test";
import { acquireXTurn, getXWorker, withXTurn, startExclusiveX } from "../src/background/x-coordinator.ts";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { startFollowRunner } from "../src/background/follow-runner.ts";
import { startUnfollowRunner } from "../src/background/unfollow-runner.ts";
import { smmStartPostScan } from "../src/background/smm-runner.ts";

test("busy X operations are rejected immediately and never resume automatically", async () => {
  const agent = await acquireXTurn("agent");
  assert.equal(await acquireXTurn("follow"), null);
  assert.equal(await acquireXTurn("smm"), null);
  assert.equal(getXWorker(), "agent");
  agent!(); assert.equal(getXWorker(), null);
  const follow = await acquireXTurn("follow");
  agent!(); assert.equal(getXWorker(), "follow");
  follow!();
  await assert.rejects(withXTurn("manual", async () => { throw new Error("failed navigation"); }));
  assert.equal(getXWorker(), null);
});

test("an Agent cannot execute while SMM owns X", async () => {
  const release = await acquireXTurn("smm");
  const runtime = createInitialRuntime();
  const result = await runAgentTick({ settings: createDefaultAgentSettings(), runtime, stats: createEmptyDailyStats(), queue: { jobs: [] },
    extensionId: "test", appendActivity: async () => {}, persistQueue: async () => {}, persistStats: async () => {} });
  assert.equal(result.nextDelayMs,0); assert.equal(result.runtime.status,"paused");
  assert.equal(getXWorker(), "smm"); release!();
});

test("startup races and persisted running modes require Stop before another Start", async t => {
 const disk: Record<string, unknown> = {};
 const old = Object.getOwnPropertyDescriptor(globalThis,"chrome");
 Object.defineProperty(globalThis,"chrome",{configurable:true,value:{storage:{local:{get:async(key:string)=>({[key]:disk[key]})}}}});
 t.after(()=>old?Object.defineProperty(globalThis,"chrome",old):Reflect.deleteProperty(globalThis,"chrome"));
 let unblock!:()=>void, entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const pending=new Promise<void>(resolve=>{unblock=resolve;});
 const agent=startExclusiveX("agent",async()=>{entered();await pending;disk["xContentCreator.agentRuntime.v1"]={status:"waiting"};return{ok:true};});
 await ready;
 let started=false;
 assert.equal((await startExclusiveX("follow",async()=>{started=true;return{ok:true};})).ok,false);
 assert.equal(started,false);unblock();await agent;
 assert.equal((await startExclusiveX("smm",async()=>({ok:true}))).ok,false);
 for (const start of [startFollowRunner, startUnfollowRunner, smmStartPostScan]) {
  const result = await start();
  assert.equal(result.ok,false); assert.match(result.error || "", /Agent/);
 }
 await assert.rejects(withXTurn("manual",async()=>{}));
 disk["xContentCreator.agentRuntime.v1"]={status:"paused"};
 assert.equal((await startExclusiveX("follow",async()=>{started=true;return{ok:true};})).ok,true);
 assert.equal(started,true);
});
