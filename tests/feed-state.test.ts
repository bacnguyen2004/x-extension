import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { readFeedState, waitForFeedReady, nextFeedRecovery, type FeedState } from "../src/x/feed-state.ts";
import { handleXCommand, setStopped } from "../src/content/x-commands.ts";

const ready: FeedState = {surfaceReady:true,fingerprint:"old",height:1000,hasContent:true,loading:false,empty:false,atBottom:false};

test("a throttled timer cannot turn the eight second readiness budget into forty minutes", async t => {
  let now = 1000, waits = 0;
  t.mock.method(Date, "now", () => now);
  const result = await waitForFeedReady(() => ({ ...ready, hasContent: false, fingerprint: "", loading: true }), async () => { waits++; now += 60000; });
  assert.equal(result.ready, false);
  assert.equal(waits, 1);
});

test("a selected tab with stale articles cannot pass readiness before new feed content arrives", async () => {
  let elapsed = 0;
  const result = await waitForFeedReady(() => ({...ready,fingerprint:elapsed < 1000 ? "old" : "new"}), async ms => {elapsed += ms;}, {before:"old"});
  assert.equal(result.ready,true); assert.equal(elapsed, 1000);
  const unchanged = await waitForFeedReady(() => ready, async () => {}, {before:"old",timeoutMs:1000});
  assert.equal(unchanged.ready,false);
});

test("a wrong source or an initial loader without posts blocks readiness", async () => {
  for (const state of [{...ready,surfaceReady:false},{...ready,hasContent:false,fingerprint:"",loading:true}]) {
    assert.equal((await waitForFeedReady(() => state, async () => {}, {timeoutMs:600})).ready,false);
  }
  let elapsed = 0;
  assert.equal((await waitForFeedReady(() => ({...ready,loading:elapsed < 400}), async ms => {elapsed += ms;}, {before:"old"})).ready,true);
});

test("loaded posts are immediately usable despite a persistent spinner and changing feed height", async () => {
  let waits = 0, height = 1000;
  const result = await waitForFeedReady(() => ({ ...ready, loading: true, height: height++ }), async () => { waits++; });
  assert.equal(result.ready, true);
  assert.equal(waits, 0);
  const stale = await waitForFeedReady(() => ({ ...ready, loading: true }), async () => {}, { before: "old", timeoutMs: 600 });
  assert.equal(stale.ready, false, "a persistent spinner must not authorize scanning the previous source");
});

test("a source can return the same posts after its old content actually disappears", async () => {
  let reads = 0;
  const result = await waitForFeedReady(() => ++reads < 3 ? { ...ready, hasContent: false, fingerprint: "", loading: true } : ready,
    async () => {}, { before: "old" });
  assert.equal(result.ready, true);
});

test("empty and hidden tweet shells do not count as usable initial content", () => {
  const { document } = parseHTML('<main data-testid="primaryColumn"><div role="tab" aria-selected="true">For you</div><article data-testid="tweet"></article><div hidden><article data-testid="tweet">Hidden old post</article></div></main>');
  assert.equal(readFeedState(document, "/home", "home").hasContent, false);
});

test("readiness verifies Home/Following selection, exact List URL, and Notifications All", () => {
  const {document} = parseHTML('<main data-testid="primaryColumn"><div role="tab" aria-selected="true">For you</div><div role="tab" aria-selected="false">Following</div><article data-testid="tweet"><a href="/a/status/123"><time></time></a></article></main>');
  assert.equal(readFeedState(document,"/home","home").surfaceReady,true);
  assert.equal(readFeedState(document,"/home","following").surfaceReady,false);
  assert.equal(readFeedState(document,"/i/lists/1234","lists","https://x.com/i/lists/9999").surfaceReady,false);
  assert.equal(readFeedState(document,"/notifications","mentions").surfaceReady,false);
});

test("Notifications cards without tweet articles are valid loaded content", () => {
  const {document} = parseHTML('<main data-testid="primaryColumn"><div role="tab" aria-selected="true">All</div><div data-testid="notification">Alice posted <a href="/alice/status/123">Open post</a></div></main>');
  const state=readFeedState(document,"/notifications","mentions");
  assert.equal(state.surfaceReady,true);assert.equal(state.hasContent,true);assert.ok(state.fingerprint.includes("/alice/status/123"));
});

test("an offscreen or hidden infinite-scroll spinner does not block a loaded feed", () => {
  const {document} = parseHTML('<main data-testid="primaryColumn"><div role="tab" aria-selected="true">For you</div><article data-testid="tweet">A loaded post</article><div role="progressbar"></div></main>');
  const spinner=document.querySelector('[role="progressbar"]')!;
  let top=5000;
  Object.defineProperty(spinner,"getBoundingClientRect",{value:()=>({width:20,height:20,top,bottom:top+20})});
  assert.equal(readFeedState(document,"/home","home").loading,false);
  top=100;assert.equal(readFeedState(document,"/home","home").loading,true);
  spinner.setAttribute("aria-hidden","true");assert.equal(readFeedState(document,"/home","home").loading,false);
});

test("feed recovery goes to the top, permits one reload per five minutes and then defers the source", () => {
  let state = {failures:0,reloadAt:0}; const actions: string[] = [];
  for (let i=0;i<12;i++) {
    const next=nextFeedRecovery(state,1000000+i*1000); state=next.state; actions.push(next.action);
  }
  assert.equal(actions[2],"top"); assert.equal(actions[5],"reload"); assert.equal(actions[11],"cooldown");
  const afterReload=nextFeedRecovery({failures:5,reloadAt:1000000},1000100);
  assert.equal(afterReload.action,"cooldown");
  assert.equal(nextFeedRecovery(afterReload.state,1300001).action,"reload");
});

test("a tab transition is clicked once and stale articles are not scanned as the new source", async t => {
  const {document,window} = parseHTML('<main data-testid="primaryColumn"><div role="tab" aria-selected="true">For you</div><div role="tab" aria-selected="false">Following</div><article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a></div><a href="/alice/status/2112057695247180191"><time></time></a><div data-testid="tweetText">Old Home article content</div></article></main>');
  for (const [key,value] of Object.entries({document,window,location:{href:"https://x.com/home",pathname:"/home",origin:"https://x.com"}})) {
    const original=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,value});
    t.after(() => original ? Object.defineProperty(globalThis,key,original) : Reflect.deleteProperty(globalThis,key));
  }
  let now=1900000000000, clicks=0;
  t.mock.method(Date,"now",()=>now);
  t.mock.method(globalThis,"setTimeout",(fn:()=>void, ms=0)=>{if(ms<=8000)queueMicrotask(()=>{now+=ms;fn();});return 1 as unknown as NodeJS.Timeout;});
  t.mock.method(globalThis,"clearTimeout",()=>{});
  const tabs=document.querySelectorAll('[role="tab"]');
  tabs[1].addEventListener("click",()=>{clicks++;tabs[0].setAttribute("aria-selected","false");tabs[1].setAttribute("aria-selected","true");});
  t.after(()=>setStopped(true));
  const responses: Array<{ok?:boolean;error?:string;tweets?:unknown[]}> = [];
  const port={postMessage:(m:object)=>{if ((m as {type?:string}).type === "x_timeline_scan_result") responses.push(m);}};
  const command={type:"x_timeline_scan",browseSurface:"following"};
  await handleXCommand(port,command); await handleXCommand(port,command);
  assert.equal(clicks,1); assert.equal(responses[1].ok,false); assert.equal(responses[1].tweets,undefined);
  document.querySelector('a[href*="/status/"]')!.setAttribute("href","/alice/status/2112057695247180192");
  await handleXCommand(port,command);
  assert.equal(responses[2].ok,true); assert.equal(responses[2].tweets?.length,1); assert.equal(clicks,1);
});
