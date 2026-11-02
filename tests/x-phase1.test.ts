import assert from "node:assert/strict";
import test from "node:test";
import { detectXIdentity, pathIsHome } from "../src/x/identity.ts";
import { planScrollBurst, runScrollBurst } from "../src/x/scroll.ts";
import { isXTabSender } from "../src/messages/validate.ts";
import { parseHTML } from "linkedom";

test("identity becomes available after the account switcher renders without changing URL", () => {
  const { document } = parseHTML('<html><body><main role="main"></main></body></html>');
  assert.equal(detectXIdentity(document as unknown as Document, "/home").handle, null);
  const switcher = document.createElement("button");
  switcher.setAttribute("data-testid", "SideNav_AccountSwitcher_Button");
  switcher.setAttribute("aria-label", "Account menu");
  switcher.textContent = "Bac @itsbac0201";
  document.body.append(switcher);
  assert.equal(detectXIdentity(document as unknown as Document, "/home").handle, "itsbac0201");
});

test("pathIsHome", () => {
  assert.equal(pathIsHome("/home"), true);
  assert.equal(pathIsHome("/home/"), true);
  assert.equal(pathIsHome("/"), true);
  assert.equal(pathIsHome("/notifications"), false);
});

test("detectXIdentity from profile link + composer", () => {
  const doc = {
    querySelector(sel: string) {
      if (sel.includes("AppTabBar_Profile_Link")) {
        return { getAttribute: (n: string) => (n === "href" ? "/cool_user" : null) };
      }
      if (sel.includes("SideNav_NewTweet_Button")) return {};
      return null;
    },
  };
  const id = detectXIdentity(doc, "/home");
  assert.equal(id.loggedIn, true);
  assert.equal(id.handle, "cool_user");
  assert.equal(id.onHome, true);
  assert.equal(id.composerPresent, true);
});

test("detectXIdentity hard login wall", () => {
  const doc = {
    querySelector(sel: string) {
      if (sel.includes("loginButton")) return {};
      return null;
    },
  };
  const id = detectXIdentity(doc, "/");
  assert.equal(id.loggedIn, false);
});

test("detectXIdentity app chrome counts as logged in", () => {
  const doc = {
    querySelector(sel: string) {
      if (sel.includes("AppTabBar_Home_Link")) return {};
      if (sel.includes("loginButton")) return {}; // login link phụ không làm logout
      return null;
    },
  };
  const id = detectXIdentity(doc, "/home");
  assert.equal(id.loggedIn, true);
});

test("planScrollBurst clamps", () => {
  const p = planScrollBurst(10_000, 100);
  assert.ok(p.steps <= 8);
  assert.ok(p.perStep * p.steps <= 2400 + 8);
});

test("runScrollBurst accumulates", async () => {
  let total = 0;
  const root = {
    scrollBy({ top }: { top: number }) {
      total += top;
    },
  };
  const scrolled = await runScrollBurst(
    root,
    { distancePx: 300, steps: 3, stepDelayMs: 0 },
    async () => {},
  );
  assert.equal(scrolled, total);
  assert.ok(scrolled >= 300 - 3);
});

test("isXTabSender accepts x.com", () => {
  const ext = "abc";
  assert.equal(
    isXTabSender({ id: ext, frameId: 0, tab: { id: 1 }, url: "https://x.com/home" }, ext),
    true,
  );
  assert.equal(
    isXTabSender({ id: ext, tab: { id: 1 }, url: "https://x.com/home" }, ext),
    true,
  );
  assert.equal(
    isXTabSender({ id: ext, frameId: 0, tab: { id: 1 }, url: "https://evil.com/" }, ext),
    false,
  );
});
