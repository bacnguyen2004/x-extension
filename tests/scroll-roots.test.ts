import assert from "node:assert/strict";
import test from "node:test";
import { runScrollBurst } from "../src/x/scroll.ts";

const options = { distancePx: 300, steps: 3, stepDelayMs: 0 };

test("a late scroll timer does not repeat the full polling budget", async t => {
  let now = 1000, waits = 0;
  t.mock.method(Date, "now", () => now);
  const root = { scrollTop: 0, scrollBy() {} };
  assert.equal(await runScrollBurst(root, options, async () => { waits++; now += 60000; }), 0);
  assert.equal(waits, 1);
});
test("document and window aliases scroll once per step rather than multiplying distance", async () => {
  let position = 0, calls = 0;
  const target = () => ({ get scrollTop() { return position; }, scrollBy({ top }: { top: number }) { position += top; calls++; } });
  assert.equal(await runScrollBurst(target(), options, async () => {}, [target(), target()]), 300);
  assert.equal(position, 300); assert.equal(calls, 3);
});
test("an immovable root falls back to the actual timeline container", async () => {
  let position = 0;
  const stuck = { scrollTop: 0, scrollBy() {} };
  const real = { get scrollTop() { return position; }, scrollBy({ top }: { top: number }) { position += top; } };
  assert.equal(await runScrollBurst(stuck, options, async () => {}, [real]), 300);
  assert.equal(position, 300);
});
test("reaching the bottom reports actual movement and a stalled page reports zero", async () => {
  let position = 0;
  const root = { get scrollTop() { return position; }, scrollBy({ top }: { top: number }) { position = Math.min(150, position + top); } };
  assert.equal(await runScrollBurst(root, options, async () => {}), 150);
  assert.equal(await runScrollBurst(root, options, async () => {}), 0);
});

test("delayed compositor movement is measured before attempting a document alias", async () => {
  let position = 0, requested = 0, aliases = 0, waits = 0;
  const root = {get scrollTop() {return position;}, scrollBy({top}: {top:number}) {requested += top;}};
  const alias = {get scrollTop() {return position;}, scrollBy() {aliases++;}};
  const moved = await runScrollBurst(root, options, async () => {if (++waits % 2 === 0) position = requested;}, [alias]);
  assert.equal(moved, 300); assert.equal(aliases, 0);
});

test("Stop while waiting for a delayed scroll prevents further steps or fallbacks", async () => {
  let stopped = false, calls = 0;
  const root = {scrollTop: 0, scrollBy() {calls++;}};
  assert.equal(await runScrollBurst(root, options, async () => {stopped = true;}, [root], () => stopped), 0);
  assert.equal(calls, 1);
});
