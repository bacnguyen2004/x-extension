import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { handleXCommand, setStopped } from "../src/content/x-commands.ts";

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { document, window } = parseHTML('<main data-testid="primaryColumn"><a href="/alice">Alice</a></main>');
  for (const [key, value] of Object.entries({ document, window, location: { href: "https://x.com/home", pathname: "/home" } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  t.after(() => setStopped(true));
  const messages: Array<{ type?: string; error?: string; requestId?: string; detail?: string }> = [];
  return { document, messages, port: { postMessage(message: object) { messages.push(message); } } };
}

test("targeted cancellation ignores other IDs and releases the lock only after the old command exits", async t => {
  const { messages, port } = setup(t);
  const command = handleXCommand(port, { type: "x_timeline_scan", requestId: "old", deadlineAt: 21000 });
  await handleXCommand(port, { type: "x_cancel", targetRequestId: "different" });
  await handleXCommand(port, { type: "x_like", requestId: "busy-probe" });
  assert.ok(messages.some(m => m.requestId === "busy-probe" && m.error === "busy" && m.detail?.includes("x_timeline_scan")));
  await handleXCommand(port, { type: "x_cancel", targetRequestId: "old" });
  await command;
  assert.ok(messages.some(m => m.requestId === "old" && m.error === "stopped"));
  assert.ok(messages.some(m => m.requestId === "old" && m.type === "x_command_released"));
  await handleXCommand(port, { type: "x_navigate_link", requestId: "next", url: "https://x.com/missing" });
  assert.ok(messages.some(m => m.requestId === "next" && m.error === "navigation_link_missing"));
});

test("command deadline interrupts page pause and an expired command cannot click a link", async t => {
  const { document, messages, port } = setup(t);
  const command = handleXCommand(port, { type: "x_timeline_scan", requestId: "slow", deadlineAt: 2000 });
  t.mock.timers.tick(1000);
  await command;
  assert.ok(messages.some(m => m.requestId === "slow" && m.error === "timeout"));
  assert.ok(messages.some(m => m.requestId === "slow" && m.type === "x_command_released"));
  let clicked = false;
  document.querySelector("a")!.addEventListener("click", () => { clicked = true; });
  await handleXCommand(port, { type: "x_navigate_link", requestId: "expired", deadlineAt: 1500, url: "https://x.com/alice" });
  assert.equal(clicked, false);
  assert.ok(messages.some(m => m.requestId === "expired" && m.error === "timeout"));
});
