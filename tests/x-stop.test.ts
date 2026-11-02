import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { handleXCommand } from "../src/content/x-commands.ts";
import { runScrollBurst } from "../src/x/scroll.ts";

for (const kind of ["reply", "quote"] as const) {
  test(`stop during ${kind} composer input prevents submit`, async (t) => {
    const { document, window } = parseHTML(`<html><body>
      <a data-testid="SideNav_NewTweet_Button"></a>
      <article data-testid="tweet"><a href="/a/status/111"></a>
        <button data-testid="reply"></button><button data-testid="retweet"></button>
      </article>
      <div role="menuitem">Quote</div>
      <div data-testid="tweetTextarea_0" contenteditable="true"></div>
      <button data-testid="tweetButton"></button>
    </body></html>`);
    const globals = { document, window, HTMLElement: window.HTMLElement, InputEvent: window.InputEvent, Event: window.Event, location: { href: "https://x.com/a/status/111", pathname: "/a/status/111" } };
    for (const [key, value] of Object.entries(globals)) {
      const original = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
    }
    const messages: Array<{ type?: string; error?: string; requestId?: string }> = [];
    const port = { postMessage(message: object) { messages.push(message); } };
    let submits = 0;
    document.querySelector('[data-testid="tweetButton"]')!.addEventListener("click", () => submits++);
    let stopSent = false;
    document.querySelector('[data-testid="tweetTextarea_0"]')!.addEventListener("input", () => {
      stopSent = true;
      void handleXCommand(port, { type: `x_${kind}`, requestId: "competing-command" });
      void handleXCommand(port, { type: "x_stop" });
    });
    await handleXCommand(port, { type: `x_${kind}`, requestId: "original-command", tweetId: "111", tweetUrl: "https://x.com/a/status/111", text: "hello" });
    assert.equal(stopSent, true);
    assert.equal(submits, 0);
    assert.ok(messages.some((m) => m.type === `x_${kind}_result` && m.error === "stopped" && m.requestId === "original-command"));
    assert.ok(messages.some((m) => m.type === `x_${kind}_result` && m.error === "busy" && m.requestId === "competing-command"));
  });
}

test("scroll stops between steps", async () => {
  let stopped = false;
  let calls = 0;
  await runScrollBurst({ scrollBy() { calls++; } }, { distancePx: 300, steps: 3, stepDelayMs: 0 }, async () => { stopped = true; }, [], () => stopped);
  assert.equal(calls, 1);
});
