import assert from "node:assert/strict";
import test from "node:test";
import { pullPogoWhenEmpty, resetPogoDemandPull } from "../src/background/pogo-demand-feed.ts";
import { resetPogoBountyStore } from "../src/background/pogo-bounty-store.ts";
import { setApiSessionToken } from "../src/background/api-session.ts";
import { createInitialState } from "../src/domain/types.ts";

test("empty-queue pulls coalesce, preserve local state, back off and stop on expired sessions", async t => {
 const disk:Record<string,unknown>={"pogoTaskReader.state":createInitialState()}, session:Record<string,unknown>={};
 const old=Object.getOwnPropertyDescriptor(globalThis,"chrome");
 const storage=(data:Record<string,unknown>)=>({get:async(key:string)=>({[key]:data[key]}),set:async(patch:object)=>{Object.assign(data,patch);},remove:async(key:string)=>{delete data[key];}});
 Object.defineProperty(globalThis,"chrome",{configurable:true,value:{storage:{local:storage(disk),session:storage(session)}}});
 t.after(()=>old?Object.defineProperty(globalThis,"chrome",old):Reflect.deleteProperty(globalThis,"chrome"));
 resetPogoBountyStore();
 let clock=Date.now(), calls=0, status=200;
 t.mock.method(Date,"now",()=>clock);
 t.mock.method(globalThis,"fetch",async(input:unknown)=>{assert.equal(String(input),"https://pogo.social/api/feed");calls++;return status===200?Response.json({campaigns:[]}):new Response("",{status});});
 await setApiSessionToken("fake-token");await resetPogoDemandPull();
 const [a,b]=await Promise.all([pullPogoWhenEmpty(()=>false),pullPogoWhenEmpty(()=>false)]);
 assert.equal(a.kind,"updated");assert.equal(b.kind,"updated");assert.equal(calls,1);
 assert.equal((await pullPogoWhenEmpty(()=>false)).kind,"waiting");assert.equal(calls,1);
 assert.ok(a.retryAt! >= clock + 300000 && a.retryAt! <= clock + 600000);
 clock=a.retryAt!+1;status=429;assert.equal((await pullPogoWhenEmpty(()=>false)).kind,"failed");assert.equal(calls,2);
 clock+=30001;assert.equal((await pullPogoWhenEmpty(()=>false)).kind,"waiting");assert.equal(calls,2);
 clock+=60001;status=401;assert.equal((await pullPogoWhenEmpty(()=>false)).kind,"login_required");assert.equal(calls,3);
 clock+=600000;assert.equal((await pullPogoWhenEmpty(()=>false)).kind,"login_required");assert.equal(calls,3);
 await setApiSessionToken(null);await resetPogoDemandPull();
});
