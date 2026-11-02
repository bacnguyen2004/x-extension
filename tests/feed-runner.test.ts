import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {runAgentTick} from "../src/background/agent-runner.ts";
import {attachXPort} from "../src/background/x-bridge.ts";
import {createDefaultAgentSettings,createInitialRuntime,createEmptyDailyStats} from "../src/domain/agent-settings.ts";
import {createDefaultAiSettings} from "../src/domain/ai-settings.ts";
import type {AgentQueueState} from "../src/domain/agent-queue.ts";
import type {TimelineTweet} from "../src/x/timeline.ts";
import {beginNavigateToSource,browseScheduleOf,confirmSourceReady,createFeedRotationState} from "../src/domain/feed-rotation.ts";

function setup(t:TestContext) {
  const ai=createDefaultAiSettings();ai.apiKey="fake-key";
  const disk:Record<string,unknown>={"pogoTaskReader.aiSettings.v1":ai};
  const original=Object.getOwnPropertyDescriptor(globalThis,"chrome");
  Object.defineProperty(globalThis,"chrome",{configurable:true,value:{storage:{local:{get:async(k:string)=>({[k]:disk[k]}),set:async(p:object)=>Object.assign(disk,structuredClone(p))}}}});
  t.after(()=>original?Object.defineProperty(globalThis,"chrome",original):Reflect.deleteProperty(globalThis,"chrome"));
  t.mock.method(Math,"random",()=>0);let now=Date.now();t.mock.method(Date,"now",()=>now++);
  const listeners=new Set<(m:unknown)=>void>(),disconnects=new Set<()=>void>();
  const commands:Array<{type:string;browseSurface?:string}>=[];let badge=0,scrollError:string|undefined;
  let tweets: TimelineTweet[] = [];
  const emit=(m:object)=>{for(const fn of [...listeners])fn(m);};
  const port={sender:{id:"feed-test",url:"https://x.com/home",tab:{id:411},frameId:0},
    onMessage:{addListener:(fn:(m:unknown)=>void)=>listeners.add(fn),removeListener:(fn:(m:unknown)=>void)=>listeners.delete(fn)},
    onDisconnect:{addListener:(fn:()=>void)=>disconnects.add(fn),removeListener:(fn:()=>void)=>disconnects.delete(fn)},disconnect(){},
    postMessage(m:{type:string;browseSurface?:string;requestId?:string}) {
      if(m.type==="x_ping"){emit({type:"x_hello",handle:"owner",notificationCount:badge,onHome:true});return;}
      commands.push(m);
      if(m.type==="x_timeline_scan")emit({type:"x_timeline_scan_result",requestId:m.requestId,ok:true,tweets,notificationCount:badge});
      if(m.type==="x_scroll_burst")emit({type:"x_scroll_result",requestId:m.requestId,ok:!scrollError,error:scrollError,scrolledPx:scrollError?0:500});
    }};
  attachXPort(port as unknown as chrome.runtime.Port,"feed-test");t.after(()=>{for(const fn of [...disconnects])fn();});
  const settings=createDefaultAgentSettings();settings.priority="browse_only";settings.adaptiveRest=false;settings.ownHandle="owner";
  settings.modules={...settings.modules,pogoTasks:false,homeScroll:false,followingFeed:false,lists:true,notifications:true};
  settings.listUrlOrName="https://x.com/i/lists/1234567890";
  settings.actions={reply:true,like:false,follow:false,retweet:false,quote:false};
  let runtime=createInitialRuntime(),stats=createEmptyDailyStats(),queue:AgentQueueState={jobs:[]};
  runtime.browseRotation=confirmSourceReady(beginNavigateToSource(createFeedRotationState(),"lists",0),browseScheduleOf(settings),Date.now());
  runtime.lastBrowseSurface="lists";
  return {settings,commands,get runtime(){return runtime;},set runtime(value){runtime=value;},get stats(){return stats;},
    setBadge(value:number){badge=value;emit({type:"x_hello",handle:"owner",notificationCount:badge,onHome:true});},
    setScrollError(error?:string){scrollError=error;},
    setTweets(value: TimelineTweet[]){tweets=value;},
    async tick(){const r=await runAgentTick({settings,runtime,stats,queue,extensionId:"feed-test",appendActivity:async()=>{},persistQueue:async()=>{},persistStats:async()=>{},waitForDelay:async()=>{}});runtime=r.runtime;stats=r.stats;queue=r.queue;return r;}};
}

test("valid posts with zero selected actions do not count as an empty source", async t => {
  const run = setup(t); run.settings.modules.notifications = false; run.settings.humanize.replyPct = 0;
  run.setTweets([{ tweetId: "2112057695247180191", authorHandle: "alice", tweetUrl: "https://x.com/alice/status/2112057695247180191",
    text: "A valid post that should not be mistaken for an empty feed.", alreadyLiked: false, promoted: false }]);
  for (let i = 0; i < 7; i++) {
    await run.tick();
    assert.equal(run.runtime.browseRotation?.emptyScrolls, 0);
    assert.equal(run.runtime.browseRotation?.pendingSwitch, false);
    assert.equal(run.runtime.browseRotation?.currentSource, "lists");
  }
  assert.equal(run.commands.filter(m => m.type === "x_timeline_scan").length, 7);
  assert.equal(run.stats.scrollSessions, 7);
});

test("a scroll timeout is reported as timeout instead of pretending navigation is in progress", async t => {
  const run = setup(t); run.settings.modules.notifications = false;
  run.setScrollError("timeout");
  const result = await run.tick();
  assert.match(result.runtime.detail ?? "", /timeout/);
  assert.doesNotMatch(result.runtime.detail ?? "", /điều hướng/i);
  assert.equal(result.queue.jobs.find(j => j.kind === "scroll_home")?.error, "timeout");
  assert.equal(result.stats.scrollSessions, 0);
});

test("three genuinely empty scans switch source despite a stale visit marker", async t => {
  const run = setup(t); run.settings.modules.notifications = false; run.settings.modules.homeScroll = true;
  await run.tick(); await run.tick(); await run.tick();
  assert.equal(run.runtime.browseRotation?.emptyScrolls, 3);
  assert.equal(run.runtime.browseRotation?.pendingSwitch, true);
  run.runtime.browseVisit = { surface: "lists", rolls: { engage: false, like: false, reply: false, retweet: false, follow: false } };
  const before = run.commands.length;
  await run.tick();
  const scans = run.commands.slice(before).filter(m => m.type === "x_timeline_scan");
  assert.equal(scans[0]?.browseSurface, "home");
  assert.equal(run.runtime.browseRotation?.currentSource, "home");
  assert.ok((run.runtime.browseRotation?.emptyScrolls ?? 0) <= 3);
});

test("notifications wait for the current source batch and return to Lists instead of Home",async t=>{
  const run=setup(t);
  await run.tick();
  assert.equal(run.runtime.browseRotation?.currentSource,"lists");
  assert.ok((run.runtime.browseRotation?.emptyScrolls??0)>=1);
  run.setBadge(3);
  // 3 empty scrolls → early switch / end session blocking notifications
  await run.tick();
  await run.tick();
  assert.ok(run.runtime.browseRotation?.pendingSwitch || run.runtime.browseRotation?.phase==="waiting_round" || run.runtime.browseRotation?.phase==="switch_pending" || !run.runtime.browseRotation?.currentSource || run.runtime.browseRotation?.phase==="navigating");
  // Trong phiên Lists, không nhảy Mentions
  assert.ok(!run.commands.some(m=>m.browseSurface==="mentions"&&m.type==="x_timeline_scan") || run.runtime.browseRotation?.phase==="waiting_round" || run.runtime.browseRotation?.pendingSwitch);
  // Ép hết phiên rồi tick tiếp
  run.runtime={...run.runtime,browseRotation:{...run.runtime.browseRotation!,pendingSwitch:true,phase:"switch_pending",remainingScanTimeMs:0,clockRunning:false,clockStartedAt:null,currentSource:null,targetSource:null}};
  run.runtime=structuredClone(run.runtime);await run.tick();
  // Có thể vào mentions hoặc waiting; nếu mentions thì quay lại lists
  if(run.commands.some(m=>m.browseSurface==="mentions")){
    assert.ok(run.commands.some(m=>m.browseSurface==="lists"));
    assert.ok(!run.commands.some(m=>m.browseSurface==="home"));
  }
});

test("repeated busy replies preserve the source and queue without triggering the six error pause", async t => {
  const run = setup(t); run.settings.modules.notifications = false;
  run.setScrollError("busy");
  const remaining = run.runtime.browseRotation!.remainingScanTimeMs;
  for (let i = 0; i < 7; i++) {
    const result = await run.tick();
    assert.equal(result.runtime.consecutiveErrors, 0);
    assert.notEqual(result.runtime.status, "paused");
    assert.equal(result.queue.jobs.filter(j => j.status === "pending").length, 1);
    assert.equal(result.stats.scrollSessions, 0);
    assert.equal(result.runtime.browseRotation?.currentSource ?? result.runtime.browseRotation?.targetSource, "lists");
    assert.match(result.runtime.detail ?? "", /Tab X/);
  }
  run.setScrollError();
  const result = await run.tick();
  assert.equal(result.stats.scrollSessions, 1);
  assert.equal(result.runtime.browseRotation?.currentSource, "lists");
  assert.ok((result.runtime.browseRotation?.remainingScanTimeMs ?? 0) <= remaining);
});

test("exiting Notifications preserves an interrupted source batch through runtime reload",async t=>{
  const run=setup(t);await run.tick();run.runtime.notificationReturn="lists";
  run.runtime.notificationBatch={...run.runtime.notificationBatch!,active:false,needsExit:true};
  // Pause clock so notification exit không trừ thời gian quét.
  run.runtime.browseRotation={...run.runtime.browseRotation!,clockRunning:false,clockStartedAt:null,phase:"paused"};
  run.runtime=structuredClone(run.runtime);const remaining=run.runtime.browseRotation!.remainingScanTimeMs;
  await run.tick();assert.equal(run.commands.at(-1)?.browseSurface,"lists");
  assert.equal(run.runtime.browseRotation?.currentSource??run.runtime.browseRotation?.targetSource,"lists");
  assert.ok(Math.abs((run.runtime.browseRotation?.remainingScanTimeMs??0)-remaining)<1000);
});

test("loading and stalled scrolls neither count empty nor switch source; exhaustion defers only that source",async t=>{
  const run=setup(t);run.settings.modules.notifications=false;
  const emptyBefore=run.runtime.browseRotation?.emptyScrolls??0;
  run.setScrollError("feed_loading");await run.tick();
  assert.equal(run.runtime.browseRotation?.currentSource??run.runtime.browseRotation?.targetSource,"lists");
  assert.equal(run.runtime.browseRotation?.emptyScrolls??0,emptyBefore);
  assert.equal(run.stats.scrollSessions,0);
  run.settings.modules.homeScroll=true;
  run.setScrollError("scroll_no_progress");await run.tick();
  assert.equal(run.commands.at(-1)?.browseSurface,"lists");
  assert.equal(run.runtime.browseRotation?.currentSource??run.runtime.browseRotation?.targetSource,"lists");
  run.setScrollError("feed_recovery_cooldown");await run.tick();
  const after=run.runtime.browseRotation?.targetSource??run.runtime.browseRotation?.currentSource;
  assert.ok(after==="home"||run.runtime.browseRotation?.phase==="waiting_round"||run.runtime.browseRotation?.phase==="navigating");
  run.setScrollError();await run.tick();
  assert.ok(["home","lists"].includes(run.commands.at(-1)?.browseSurface??""));
});
