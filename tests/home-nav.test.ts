import assert from "node:assert/strict";
import test from "node:test";
import { goHomeNaturally, homeNavError } from "../src/x/home-nav.ts";

test("goHomeNaturally returns already on /home", () => {
  assert.equal(
    goHomeNaturally({ pathname: "/home", historyLength: 5, rng: () => 0 }),
    "already",
  );
});

test("goHomeNaturally prefers back most of the time", () => {
  let backed = 0;
  let assigned = 0;
  const kind = goHomeNaturally({
    pathname: "/alice/status/1",
    historyLength: 3,
    // reloadPct 28 → rng 0.5 → 50 >= 28 → back
    rng: () => 0.5,
    reloadPct: 28,
    back: () => {
      backed += 1;
    },
    assign: () => {
      assigned += 1;
    },
  });
  assert.equal(kind, "back");
  assert.equal(backed, 1);
  assert.equal(assigned, 0);
  assert.equal(homeNavError("back"), "navigating_home_back");
});

test("goHomeNaturally reloads when roll hits reloadPct", () => {
  let assignedUrl = "";
  const kind = goHomeNaturally({
    pathname: "/alice/status/1",
    historyLength: 3,
    // rng 0.1 → 10 < 28 → reload
    rng: () => 0.1,
    reloadPct: 28,
    origin: "https://x.com",
    back: () => {},
    assign: (url) => {
      assignedUrl = url;
    },
  });
  assert.equal(kind, "reload");
  assert.equal(assignedUrl, "https://x.com/home");
  assert.equal(homeNavError("reload"), "navigating_home");
});

test("goHomeNaturally reloads when no history to back", () => {
  let assigned = 0;
  const kind = goHomeNaturally({
    pathname: "/bob",
    historyLength: 1,
    rng: () => 0.99,
    reloadPct: 28,
    back: () => {},
    assign: () => {
      assigned += 1;
    },
    origin: "https://x.com",
  });
  assert.equal(kind, "reload");
  assert.equal(assigned, 1);
});
