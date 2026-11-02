import assert from "node:assert/strict";
import test from "node:test";
import { pogoRetweetWindow, pogoRetweetFull, retweetPolicyError } from "../src/domain/pogo-retweet.ts";
import { guardedPogoRetweet, loadPogoRetweetPower, observePogoRetweetPower } from "../src/background/pogo-retweet-store.ts";
import { makeJob } from "../src/domain/agent-queue.ts";
import { planNextAction } from "../src/agent/planner.ts";
import { createDefaultAgentSettings, createEmptyDailyStats, sanitizeAgentSettings } from "../src/domain/agent-settings.ts";
import { dailyTarget } from "../src/domain/daily-targets.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";

test("API retweet observation stays fresh for 30 minutes then drops observedAt", async t => {
 let clock = Date.parse("2026-10-23T12:10:00Z");
 t.mock.method(Date, "now", () => clock);
 const key = "xContentCreator.pogoRetweetPower.v1.api_only";
 const disk: Record<string, unknown> = { [key]: { windowStart: pogoRetweetWindow().windowStart, items: [], observedUsed: 2, observedItems: 0, observedAt: clock - 31 * 60 * 1000, lastRemaining: 8 } };
 const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
 Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
   get: async (name: string) => ({ [name]: structuredClone(disk[name]) }),
   set: async (patch: object) => Object.assign(disk, structuredClone(patch)),
 } } } });
 t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
 assert.equal((await loadPogoRetweetPower("api_only")).observedAt, undefined);
 await observePogoRetweetPower("api_only", 6, 16);
 const live = await loadPogoRetweetPower("api_only");
 assert.equal(10 - live.used, 6);
 assert.equal(live.observedAt, clock);
 clock += 29 * 60 * 1000;
 assert.equal((await loadPogoRetweetPower("api_only")).observedAt, clock - 29 * 60 * 1000);
 clock += 2 * 60 * 1000;
 assert.equal((await loadPogoRetweetPower("api_only")).observedAt, undefined);
});



test("Pogo uses full and 25% reward slots once each, blocks at twenty and ignores stale refill labels", async t => {
 const disk: Record<string, unknown> = {};
 const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
 Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
   get: async (key: string) => ({ [key]: structuredClone(disk[key]) }),
   set: async (patch: object) => Object.assign(disk, structuredClone(patch)),
 } } } });
 t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
 await observePogoRetweetPower("reduced_case", 1, 11);
 const job = (n: number) => makeJob({ kind: "retweet", source: "pogo", tweetId: String(n), authorHandle: "alice", tweetUrl: `https://x.com/alice/status/${n}`, tweetText: "post" });
 let clicks = 0;
 const action = async () => { clicks++; return { ok: true }; };
 assert.equal((await guardedPogoRetweet(job(1), "reduced_case", () => false, action)).ok, true);
 await observePogoRetweetPower("reduced_case", 0, 10);
 assert.equal(pogoRetweetFull(await loadPogoRetweetPower("reduced_case")), false, "ten 25% slots remain after full rewards end");
 for (let n = 2; n <= 11; n++) {
   assert.equal((await guardedPogoRetweet(job(n), "reduced_case", () => false, action)).ok, true);
   await observePogoRetweetPower("reduced_case", 0, 10); // stale DOM must not refund local submissions
 }
 const exhausted = await loadPogoRetweetPower("reduced_case");
 assert.equal(exhausted.used, 20);
 assert.equal(exhausted.limit, 20);
 assert.equal(pogoRetweetFull(exhausted), true);
 assert.equal((await guardedPogoRetweet(job(12), "reduced_case", () => false, action)).error, "pogo_retweet_window_full");
 await observePogoRetweetPower("reduced_case", 8, 18);
 assert.equal((await loadPogoRetweetPower("reduced_case")).used, 20);
 assert.equal(clicks, 11);
});

test("planner continues Pogo RT in the reduced-reward band and stops at the total earning limit", () => {
 const settings = createDefaultAgentSettings(); settings.modules.homeScroll = false; settings.priority = "pogo_only";
 settings.actions = { like: false, reply: false, quote: false, follow: false, retweet: true };
 const stats = { ...createEmptyDailyStats(), pogoRetweets: { ...pogoRetweetWindow(), used: 12, limit: 20 } };
 const campaign = normalizeApiCampaign({ tweet_id: "2112825901511761984", author_handle: "alice", follows_author: true, locked_points: 0 })!;
 const input = { settings, stats, queue: { jobs: [] }, campaigns: [campaign], executeActions: true, hasApiKey: false, ownHandle: null };
 const first = planNextAction(input);
 const jobs = first.type === "bundle" ? first.jobs : first.type === "job" ? [first.job] : [];
 assert.ok(jobs.some(job => job.kind === "retweet"));
 stats.pogoRetweets.used = 20;
 const last = planNextAction(input);
 const remaining = last.type === "bundle" ? last.jobs : last.type === "job" ? [last.job] : [];
 assert.ok(remaining.every(job => job.kind !== "retweet"));
});


test("Pogo RT windows refill at 01/07/13/19 Vietnam and do not refill at midnight", () => {
 for (const hour of [0,6,12,18]) {
  const boundary=Date.parse(`2026-10-22T${String(hour).padStart(2,"0")}:00:00Z`);
  assert.equal(pogoRetweetWindow(boundary).windowStart,boundary);
  assert.equal(pogoRetweetWindow(boundary-1).nextResetAt,boundary);
 }
 const beforeMidnight=pogoRetweetWindow(Date.parse("2026-10-22T16:59:59Z"));
 assert.deepEqual(pogoRetweetWindow(Date.parse("2026-10-22T17:00:00Z")),beforeMidnight);
});

test("Pogo RT reserves durable slots, blocks the eleventh, isolates accounts and refills at 01", async t => {
 let clock=Date.parse("2026-10-21T12:00:00Z");t.mock.method(Date,"now",()=>clock);
 const disk:Record<string,unknown>={};const old=Object.getOwnPropertyDescriptor(globalThis,"chrome");
 Object.defineProperty(globalThis,"chrome",{configurable:true,value:{storage:{local:{get:async(key:string)=>({[key]:structuredClone(disk[key])}),set:async(patch:object)=>{Object.assign(disk,structuredClone(patch));}}}}});
 t.after(()=>old?Object.defineProperty(globalThis,"chrome",old):Reflect.deleteProperty(globalThis,"chrome"));
 const job=(n:number,source:"pogo"|"browse"|"manual"="pogo")=>makeJob({kind:"retweet",source,tweetId:String(n),tweetUrl:`https://x.com/a/status/${n}`,tweetText:"post",authorHandle:"a"});
 let clicks=0;
 const action=async()=>{clicks++;const stored=disk["xContentCreator.pogoRetweetPower.v1.alice"] as {items:unknown[]};assert.ok(stored.items.length>0,"reserve must persist before requesting X");return{ok:true,detail:"retweeted"};};
 assert.equal((await guardedPogoRetweet(job(90,"browse"),"alice",()=>false,action)).error,"retweet_pogo_only");
 assert.equal((await guardedPogoRetweet(job(91,"manual"),"alice",()=>false,action)).error,"retweet_pogo_only");
 await Promise.all(Array.from({length:11},(_,i)=>guardedPogoRetweet(job(i),"alice",()=>false,action)));
 assert.equal(clicks,10);assert.equal((await loadPogoRetweetPower("alice")).used,10);
 disk["xContentCreator.agentQueue.v1"]={jobs:[]};
 assert.equal((await loadPogoRetweetPower("alice")).used,10,"clearing history cannot refill slots");
 assert.equal((await loadPogoRetweetPower("bob")).used,0);
 clock=Date.parse("2026-10-21T17:00:00Z");assert.equal((await loadPogoRetweetPower("alice")).used,10);
 clock=Date.parse("2026-10-21T18:00:00Z");assert.equal((await loadPogoRetweetPower("alice")).used,0);
 await guardedPogoRetweet(job(40),"alice",()=>false,async()=>({ok:true,detail:"already_retweeted"}));
 assert.equal((await loadPogoRetweetPower("alice")).used,0);
 await guardedPogoRetweet(job(41),"alice",()=>false,async()=>({ok:false,error:"timeout"}));
 assert.equal((await loadPogoRetweetPower("alice")).used,1,"uncertain submission consumes a slot");
 assert.equal((await guardedPogoRetweet(job(41),"alice",()=>false,action)).error,"pogo_retweet_already_attempted");
 await guardedPogoRetweet(job(42),"alice",()=>false,async()=>({ok:false,error:"retweet_btn_missing"}));
 assert.equal((await loadPogoRetweetPower("alice")).used,1);
});

test("full Pogo RT windows leave replies available and resume RT after refill", () => {
 const settings=createDefaultAgentSettings();settings.modules.homeScroll=false;settings.priority="pogo_only";
 settings.actions={like:false,reply:true,quote:false,follow:false,retweet:true};
 const stats={...createEmptyDailyStats(),pogoRetweets:{...pogoRetweetWindow(),used:10}};
 const campaign=normalizeApiCampaign({tweet_id:"2112825901511761984",author_handle:"a",text:"post",follows_author:true,locked_points:0})!;
 const input={settings,stats,queue:{jobs:[]},campaigns:[campaign],executeActions:true,hasApiKey:true,ownHandle:null};
 const plan=planNextAction(input);assert.equal(plan.type,"bundle");
 if(plan.type==="bundle") {assert.ok(plan.jobs.some(j=>j.kind==="draft_reply"));assert.ok(plan.jobs.every(j=>j.kind!=="retweet"));}
 stats.pogoRetweets.windowStart-=21600000;
 assert.equal(pogoRetweetFull(stats.pogoRetweets),false);
 const next=planNextAction(input);assert.equal(next.type,"bundle");
 if(next.type==="bundle")assert.ok(next.jobs.some(j=>j.kind==="retweet"));
});




test("false API empty reading can recover when full-left remaining returns", async t => {
 const disk:Record<string,unknown>={};const old=Object.getOwnPropertyDescriptor(globalThis,"chrome");
 Object.defineProperty(globalThis,"chrome",{configurable:true,value:{storage:{local:{get:async(key:string)=>({[key]:structuredClone(disk[key])}),set:async(patch:object)=>Object.assign(disk,structuredClone(patch))}}}});
 t.after(()=>old?Object.defineProperty(globalThis,"chrome",old):Reflect.deleteProperty(globalThis,"chrome"));
 await observePogoRetweetPower("alice",0);
 assert.equal((await loadPogoRetweetPower("alice")).used,10);
 await observePogoRetweetPower("alice",8);
 assert.equal((await loadPogoRetweetPower("alice")).used,2,"recover from false 0 when API shows 8 full left");
});


test("Home RT toggle persists and works independently of a full Pogo window and old numeric targets", () => {
 const settings=createDefaultAgentSettings();settings.modules.pogoTasks=false;settings.priority="browse_only";
 settings.actions={like:false,reply:false,follow:false,quote:false,retweet:true};
 settings.homeRetweet=true;
 settings.dailyTargets!.ranges.retweet={min:1,max:1};
 const stats={...createEmptyDailyStats(),retweet:20,pogoRetweets:{...pogoRetweetWindow(),used:10}};
 assert.equal(dailyTarget(settings,stats,"retweet"),0);
 assert.equal(sanitizeAgentSettings(settings).homeRetweet,true);
 const candidate={tweetId:"2112825901511761984",tweetUrl:"https://x.com/a/status/2112825901511761984",authorHandle:"a",text:"post",promoted:false,alreadyLiked:false};
 const input={settings,stats,queue:{jobs:[]},campaigns:[],executeActions:true,hasApiKey:false,ownHandle:null,browseCandidates:[candidate],browseRolls:{engage:true,like:false,reply:false,retweet:true,follow:false}};
 const planned=planNextAction(input);
 const jobs=planned.type==="bundle"?planned.jobs:planned.type==="job"?[planned.job]:[];
 assert.ok(jobs.some(j=>j.kind==="retweet"&&j.source==="browse"));
 assert.equal(retweetPolicyError({kind:"retweet",source:"browse"},stats.pogoRetweets,true),null);
 assert.equal(retweetPolicyError({kind:"retweet",source:"pogo"},stats.pogoRetweets,true),"pogo_retweet_window_full");
 settings.homeRetweet=false;
 const disabled=planNextAction(input);
 const disabledJobs=disabled.type==="bundle"?disabled.jobs:disabled.type==="job"?[disabled.job]:[];
 assert.ok(disabledJobs.every(j=>j.kind!=="retweet"));
 assert.equal(retweetPolicyError({kind:"retweet",source:"browse"},stats.pogoRetweets,false),"home_retweet_disabled");
 settings.homeRetweet=true;settings.actions.retweet=false;
 const masterOff=planNextAction(input);
 const offJobs=masterOff.type==="bundle"?masterOff.jobs:masterOff.type==="job"?[masterOff.job]:[];
 assert.ok(offJobs.every(j=>j.kind!=="retweet"));
});

test("observed Pogo allowance limits clicks, survives delayed labels and isolates accounts and windows", async t => {
 let clock=Date.parse("2026-10-22T12:10:00Z");t.mock.method(Date,"now",()=>clock);
 const disk:Record<string,unknown>={}; const old=Object.getOwnPropertyDescriptor(globalThis,"chrome");
 Object.defineProperty(globalThis,"chrome",{configurable:true,value:{storage:{local:{get:async(key:string)=>({[key]:structuredClone(disk[key])}),set:async(patch:object)=>{Object.assign(disk,structuredClone(patch));}}}}});
 t.after(()=>old?Object.defineProperty(globalThis,"chrome",old):Reflect.deleteProperty(globalThis,"chrome"));
 await observePogoRetweetPower("alice",2);
 assert.equal((await loadPogoRetweetPower("alice")).used,8);
 assert.equal((await loadPogoRetweetPower("alice")).observedAt,clock);
 assert.equal((await loadPogoRetweetPower("bob")).used,0);
 assert.equal((await loadPogoRetweetPower("bob")).observedAt,undefined);
 let clicks=0;
 const action=async()=>{clicks++;return {ok:true};};
 const job=(id:number)=>makeJob({kind:"retweet",source:"pogo",tweetId:String(id),authorHandle:"a",tweetUrl:`https://x.com/a/status/${id}`,tweetText:"post"});
 await guardedPogoRetweet(job(101),"alice",()=>false,action);
 await observePogoRetweetPower("alice",2); // stale UI must not grant another slot
 await guardedPogoRetweet(job(102),"alice",()=>false,action);
 const blocked=await guardedPogoRetweet(job(103),"alice",()=>false,action);
 assert.equal(clicks,2);assert.equal(blocked.error,"pogo_retweet_window_full");
 await observePogoRetweetPower("alice",10);
 assert.equal((await loadPogoRetweetPower("alice")).used,10);
 clock=Date.parse("2026-10-22T18:00:00Z");
 assert.equal((await loadPogoRetweetPower("alice")).used,0);
});
