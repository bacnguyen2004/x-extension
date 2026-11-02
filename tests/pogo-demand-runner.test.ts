import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTick } from "../src/background/agent-runner.ts";
import { attachXPort } from "../src/background/x-bridge.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, createInitialRuntime } from "../src/domain/agent-settings.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { createInitialState, type Campaign } from "../src/domain/types.ts";

test("Agent pulls only after cached Pogo work is exhausted, and never when Pogo is disabled", async t => {
 const campaign=normalizeApiCampaign({tweet_id:"2112825901511761984",author_handle:"alice",text:"A post",follows_author:false,locked_points:0})!;
 const disk:Record<string,unknown>={"pogoTaskReader.state":createInitialState()};
 const old=Object.getOwnPropertyDescriptor(globalThis,"chrome");
 Object.defineProperty(globalThis,"chrome",{configurable:true,value:{storage:{local:{get:async(key:string)=>({[key]:disk[key]}),set:async(patch:object)=>{Object.assign(disk,patch);}}}}});
 t.after(()=>old?Object.defineProperty(globalThis,"chrome",old):Reflect.deleteProperty(globalThis,"chrome"));
 const listeners=new Set<(m:unknown)=>void>(),disconnects=new Set<()=>void>(),commands:string[]=[];
 const emit=(m:object)=>{for(const fn of [...listeners])fn(m);};
 const port={sender:{id:"pull-test",url:"https://x.com/home",tab:{id:83},frameId:0},onMessage:{addListener:(fn:(m:unknown)=>void)=>listeners.add(fn),removeListener:(fn:(m:unknown)=>void)=>listeners.delete(fn)},
 onDisconnect:{addListener:(fn:()=>void)=>disconnects.add(fn),removeListener:(fn:()=>void)=>disconnects.delete(fn)},postMessage(m:{type:string;requestId?:string}){
 if(m.type==="x_ping"){emit({type:"x_hello",handle:"me",onHome:true});return;}commands.push(m.type);
 emit({type:m.type+"_result",requestId:m.requestId,ok:true,detail:"follow_confirmed"});},disconnect(){}};
 attachXPort(port as unknown as chrome.runtime.Port,"pull-test");t.after(()=>{for(const fn of [...disconnects])fn();});
 const settings=createDefaultAgentSettings();settings.modules.homeScroll=false;settings.priority="pogo_only";
 settings.actions={like:false,reply:false,retweet:false,follow:true,quote:false};
 let pulls=0;
 const tick=()=>runAgentTick({settings,stats:createEmptyDailyStats(),runtime:createInitialRuntime(),queue:{jobs:[]},extensionId:"pull-test",appendActivity:async()=>{},persistQueue:async()=>{},persistStats:async()=>{},
  pullPogo:async()=>{pulls++;return{kind:"updated",campaigns:[campaign]};}});
 const first=await tick();assert.equal(pulls,1);assert.equal(first.stats.follow,1);assert.ok(commands.includes("x_follow"));
 disk["pogoTaskReader.state"]={...createInitialState(),campaigns:{[campaign.tweet_id]:campaign}};
 await tick();assert.equal(pulls,1,"existing usable task must run before pulling");
 settings.modules.pogoTasks=false;await tick();assert.equal(pulls,1);
});
