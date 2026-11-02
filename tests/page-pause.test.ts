import assert from "node:assert/strict";
import test from "node:test";
import { createPagePause } from "../src/x/page-pause.ts";
import { beginAction, stopActions } from "../src/x/action-control.ts";

test("a delayed page timer exits at its real deadline", async t => {
  beginAction();
  let now = 1000, waits = 0;
  t.mock.method(Date, "now", () => now);
  const pause = createPagePause(() => "/home", async () => { waits++; now += 60000; });
  await assert.rejects(pause(), { name: "ActionDeadlineError" });
  assert.equal(waits, 1);
});

test("a continuously changing page cannot hold the command lock indefinitely", async () => {
  beginAction();
  let page = 0, waits = 0;
  const pause = createPagePause(() => String(page), async () => { waits++; page++; });
  await assert.rejects(pause(), { name: "ActionDeadlineError" });
  assert.equal(waits, 3);
});

test("each new page pauses 3–5 seconds, while actions on the same page continue", async () => {
  beginAction();
  let page = "/home|For you";
  const waits: number[] = [];
  const pause = createPagePause(() => page, async ms => { waits.push(ms); }, () => 0.5);
  await pause(); await pause();
  page = "/i/lists/123"; await pause(); await pause();
  page = "/alice/status/123"; await pause();
  page = "/i/lists/123"; await pause();
  assert.deepEqual(waits, [4000, 4000, 4000, 4000]);
});

test("Following changes pause even when the URL stays /home", async () => {
  beginAction();
  let page = "/home|For you", waits = 0;
  const pause = createPagePause(() => page, async ms => { assert.ok(ms >= 3000 && ms <= 5000); waits++; });
  await pause(); page = "/home|Following"; await pause();
  assert.equal(waits, 2);
});

test("a redirect during the pause waits for the new page before proceeding", async () => {
  beginAction();
  let page = "/alice", waits = 0;
  const pause = createPagePause(() => page, async () => { if (++waits === 1) page = "/home"; });
  await pause(); assert.equal(waits, 2);
});

test("Stop during a page pause prevents proceeding and resume waits again", async () => {
  beginAction();
  let waits = 0;
  const pause = createPagePause(() => "/home", async () => { if (++waits === 1) stopActions(); });
  await assert.rejects(pause(), /stopped/);
  beginAction(); await pause(); assert.equal(waits, 2);
});
