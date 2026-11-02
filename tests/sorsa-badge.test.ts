import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { startSorsaBadges } from "../src/content/x-sorsa-badge.ts";

test("Sorsa badges share one appearance and remain stable on reused account rows", async (t) => {
  const name = (handle: string, type = "User-Name") => `<div data-testid="${type}" style="display:flex;flex-direction:column"><div style="display:flex;flex-direction:row"><a href="/${handle}">${handle}</a><svg data-testid="icon-verified"></svg></div><span>@${handle}</span></div>`;
  const { document, window } = parseHTML(`<html><body><main data-testid="primaryColumn"><article data-testid="tweet">${name("alice")}</article>${name("bob", "UserName")}<div data-testid="UserCell">${name("carol")}</div></main></body></html>`);
  let onMutation: () => void = () => {};
  let onStorage: (changes: unknown, area: string) => void = () => {};
  const globals: Record<string, unknown> = {
    document, window, location: { pathname: "/bob" },
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    getComputedStyle: (el: HTMLElement) => ({ display: el.style.display, flexDirection: el.style.flexDirection }),
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    MutationObserver: class {
      constructor(callback: () => void) { onMutation = callback; }
      observe() {}
    },
    chrome: {
      runtime: {
        sendMessage: (msg: { type?: string; usernames?: string[] }, cb: (value: unknown) => void) => {
          if (msg?.type === "x_ui_sorsa_scores") {
            const scores: Record<string, { score: number | null }> = {};
            for (const u of msg.usernames || []) scores[u.toLowerCase()] = { score: 42 };
            cb({ ok: true, scores });
            return;
          }
          cb({ ok: true, sorsa: { mode: "public" } });
        },
      },
      storage: {
        local: { get: (_: unknown, cb: (value: unknown) => void) => cb({}) },
        onChanged: { addListener: (cb: typeof onStorage) => { onStorage = cb; } },
      },
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  startSorsaBadges();
  // hydrateFromDiskCache → loadPrefs → scan are promise/microtask chained.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const badges = [...document.querySelectorAll<HTMLElement>(".xcc-sorsa-badge")];
  assert.equal(badges.length, 3);
  assert.deepEqual(badges.map((b) => b.dataset.handle), ["alice", "bob", "carol"]);
  assert.ok(badges.every((b) => b.tagName === "SPAN" && b.classList.contains("xcc-sorsa-badge")));
  assert.ok(badges[0] && !badges[0].classList.contains("xcc-sorsa-compact") && !badges[0].classList.contains("xcc-sorsa-profile"));
  assert.ok(badges[1]?.classList.contains("xcc-sorsa-profile"));
  assert.ok(badges[2]?.classList.contains("xcc-sorsa-compact"));
  assert.ok(badges.every((b) => b.querySelector(".xcc-sorsa-inner")));
  assert.ok(badges.every((b) => b.previousElementSibling?.getAttribute("data-testid") === "icon-verified"));
  const before = document.body.innerHTML;
  onMutation();
  t.mock.timers.tick(120);
  assert.equal(document.body.innerHTML, before, "rescanning must not change badge markup or position");
  const cell = document.querySelector('[data-testid="UserCell"]')!;
  // X uses role=button on the whole account row, independently of Follow.
  cell.setAttribute("role", "button");
  cell.querySelector("a")!.setAttribute("href", "/dave");
  // The same DOM node now belongs to a new account; the existing badge must update.
  onMutation();
  t.mock.timers.tick(120);
  assert.equal(cell.querySelector<HTMLElement>(".xcc-sorsa-badge")!.dataset.handle, "dave");
  assert.match(cell.querySelector(".xcc-sorsa-badge")!.getAttribute("aria-label")!, /@dave/);
  cell.querySelector(".xcc-sorsa-badge")!.parentElement!.appendChild(badges[2]!.cloneNode(true));
  onMutation();
  t.mock.timers.tick(120);
  assert.equal(cell.querySelectorAll(".xcc-sorsa-badge").length, 1);
  // Real follower lists can omit User-Name and place the Follow button last.
  // Reproduce an old badge already misplaced inside that button.
  cell.innerHTML = `<div style="display:flex;flex-direction:row"><a href="/eve"><img></a><div><a href="/eve"><div style="display:flex;flex-direction:row"><span>Eve</span><svg data-testid="icon-verified"></svg></div></a><a href="/eve">@eve</a></div><button><div style="display:flex;flex-direction:row">Follow back<span class="xcc-sorsa-badge" data-handle="dave">42</span></div></button></div><div>Bio mentions @someone</div>`;
  onMutation();
  t.mock.timers.tick(120);
  const moved = cell.querySelector<HTMLElement>(".xcc-sorsa-badge")!;
  assert.equal(moved.dataset.handle, "eve");
  assert.equal(moved.closest('button, [role="button"]'), cell);
  assert.equal(cell.querySelector("button .xcc-sorsa-badge"), null);
  assert.equal(moved.previousElementSibling?.getAttribute("data-testid"), "icon-verified");
  assert.equal(cell.querySelectorAll(".xcc-sorsa-badge").length, 1);
  const repaired = cell.innerHTML;
  onMutation();
  t.mock.timers.tick(120);
  assert.equal(cell.innerHTML, repaired);
  onStorage({ "xContentCreator.ui.v1": { newValue: { enableSorsaBadge: false } } }, "local");
  assert.ok(document.documentElement.classList.contains("xcc-sorsa-off"));
  onStorage({ "xContentCreator.ui.v1": { newValue: { enableSorsaBadge: true } } }, "local");
  assert.ok(!document.documentElement.classList.contains("xcc-sorsa-off"));
});
