import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { handleXCommand, setStopped } from "../src/content/x-commands.ts";

function setup(t: TestContext, surface: "home" | "following" | "lists", moves = true, updates = true) {
  const path = surface === "lists" ? "/i/lists/1234567890" : "/home";
  const { document, window } = parseHTML(`<html><body><main data-testid="primaryColumn" aria-busy="true">
    <div role="tab" aria-selected="${surface === "home"}">For you</div>
    <div role="tab" aria-selected="${surface === "following"}">Following</div>
    <article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a></div>
      <a href="/alice/status/2112057695247180191"><time></time></a><div data-testid="tweetText">A readable post while X loads more.</div></article>
    <div role="progressbar"></div></main></body></html>`);
  const spinner = document.querySelector('[role="progressbar"]')!;
  Object.defineProperty(spinner, "getBoundingClientRect", { value: () => ({ width: 20, height: 20, top: 100, bottom: 120 }) });
  let position = 0, calls = 0;
  Object.defineProperties(document.documentElement, {
    scrollTop: { get: () => position }, scrollHeight: { value: 100000 }, clientHeight: { value: 800 },
    scrollBy: { value: ({ top }: { top: number }) => {
      calls++;
      if (moves) position += top;
      else if (updates) document.querySelector('article a[href*="/status/"]')!.setAttribute("href", `/alice/status/${2112057695247180191n + BigInt(calls)}`);
    } },
  });
  for (const [key, value] of Object.entries({ document, window, location: { href: `https://x.com${path}`, pathname: path, origin: "https://x.com" } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  let now = 1900000000000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms = 0) => {
    if (ms <= 8000) queueMicrotask(() => { now += ms; fn(); });
    return 1 as unknown as NodeJS.Timeout;
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.after(() => setStopped(true));
  const responses: Array<{ type?: string; ok?: boolean; error?: string; scrolledPx?: number; tweets?: unknown[] }> = [];
  const port = { postMessage(message: object) { responses.push(message); } };
  return { responses, port, options: { browseSurface: surface, listUrl: surface === "lists" ? `https://x.com${path}` : undefined } };
}

for (const surface of ["home", "following", "lists"] as const) {
  test(`${surface} scans and repeatedly scrolls loaded posts while the load-more spinner stays visible`, async t => {
    const { responses, port, options } = setup(t, surface);
    await handleXCommand(port, { type: "x_timeline_scan", requestId: "scan", ...options });
    const scan = responses.find(m => m.type === "x_timeline_scan_result")!;
    assert.equal(scan.ok, true); assert.equal(scan.tweets?.length, 1);
    for (let i = 0; i < 7; i++) {
      await handleXCommand(port, { type: "x_scroll_burst", requestId: `scroll-${i}`, distancePx: 480, steps: 2, ...options });
    }
    const scrolls = responses.filter(m => m.type === "x_scroll_result");
    assert.equal(scrolls.length, 7);
    assert.ok(scrolls.every(m => m.ok && m.scrolledPx === 480));
  });
}

test("new content during a stationary scroll is progress even while loading remains visible", async t => {
  const { responses, port, options } = setup(t, "home", false);
  for (let i = 0; i < 7; i++) {
    await handleXCommand(port, { type: "x_scroll_burst", requestId: `scroll-${i}`, ...options });
  }
  const scrolls = responses.filter(m => m.type === "x_scroll_result");
  assert.equal(scrolls.length, 7);
  assert.ok(scrolls.every(m => m.error === "feed_content_changed"));
});

test("a feed with neither scroll movement nor content changes still gets bounded recovery", async t => {
  const { responses, port, options } = setup(t, "home", false, false);
  for (let i = 0; i < 3; i++) {
    await handleXCommand(port, { type: "x_scroll_burst", requestId: `stalled-${i}`, ...options });
  }
  const scrolls = responses.filter(m => m.type === "x_scroll_result");
  assert.deepEqual(scrolls.map(m => m.error), ["scroll_no_progress", "scroll_no_progress", "feed_recovery_top"]);
});
