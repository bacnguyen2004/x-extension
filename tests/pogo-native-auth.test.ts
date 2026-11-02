import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createNativeAuthProvider, getNativeAuthState, setNativeAuthEnabled, bearerExpiresAt } from "../src/background/pogo-native-auth.ts";
import { getApiSessionToken, setApiSessionToken } from "../src/background/api-session.ts";

const token = (exp: number) => `header.${Buffer.from(JSON.stringify({exp})).toString("base64url")}.signature`;
function setup(t: TestContext, native: () => Promise<object>) {
 const disk: Record<string, unknown> = {};
 const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
 Object.defineProperty(globalThis, "chrome", {configurable:true,value:{
   runtime:{id:"native-test",sendNativeMessage:(_host:string,message:{action:string})=>message.action==="notify"?Promise.resolve({ok:true}):native()},alarms:{create:async()=>{},clear:async()=>{}},
   storage:{local:{get:async(key:string)=>({[key]:disk[key]}),set:async(patch:object)=>Object.assign(disk,patch)},
     session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}},
 }});
 t.after(()=>old?Object.defineProperty(globalThis,"chrome",old):Reflect.deleteProperty(globalThis,"chrome"));
 return disk;
}

test("native auth is opt-in and does not contact the helper for a healthy token",async t=>{
 let calls=0;
 setup(t,async()=>{calls++;return{ok:false};});
 const provider=createNativeAuthProvider(async()=>{throw Error("unexpected commit");});
 await provider(null);assert.equal(calls,0);
 await setNativeAuthEnabled(true);
 const healthy=token(Math.floor(Date.now()/1000)+3600);
 assert.ok(bearerExpiresAt(healthy)!>Date.now());
 await provider(healthy);assert.equal(calls,0);
 assert.equal(bearerExpiresAt("opaque"),null);
});

test("near-expiry token renewal coalesces and verifies the Bearer before committing",async t=>{
 let calls=0,commits=0,verified=0;
 const fresh=token(Math.floor(Date.now()/1000)+3600);
 setup(t,async()=>{calls++;return{ok:true,token:fresh};});
 await setNativeAuthEnabled(true);
 t.mock.method(globalThis,"fetch",async()=>{verified++;return Response.json({campaigns:[],linked_handle:"alice"});});
 const provider=createNativeAuthProvider(async value=>{commits++;await setApiSessionToken(value);});
 await Promise.all(Array.from({length:10},()=>provider(token(Math.floor(Date.now()/1000)+60))));
 assert.equal(calls,1);assert.equal(verified,1);assert.equal(commits,1);
 assert.equal(getApiSessionToken(),fresh);
 assert.equal((await getNativeAuthState()).lastError,null);
});

test("manual changes during automatic auth cannot be overwritten by a late helper response",async t=>{
 let finish!:(value:object)=>void;
 const pending=new Promise<object>(resolve=>{finish=resolve;});
 let started!:()=>void;
 const entered=new Promise<void>(resolve=>{started=resolve;});
 setup(t,async()=>{started();return pending;});
 await setNativeAuthEnabled(true);
 let commits=0;
 const provider=createNativeAuthProvider(async()=>{commits++;});
 const request=provider(null);
 await entered;await setApiSessionToken("manual-token");
 finish({ok:true,token:"late-token"});await request;
 assert.equal(commits,0);assert.equal(getApiSessionToken(),"manual-token");
});

test("missing host has a cooldown and public status never exposes native error details",async t=>{
 let calls=0;
 setup(t,async()=>{calls++;throw Error("private session and token details");});
 await setNativeAuthEnabled(true);
 const provider=createNativeAuthProvider(async()=>{});
 await provider(null);await provider(null);
 assert.equal(calls,1);
 const state=await getNativeAuthState();
 assert.equal(state.lastError,"native_host_unavailable");
 assert.equal(JSON.stringify(state).includes("private"),false);
});
