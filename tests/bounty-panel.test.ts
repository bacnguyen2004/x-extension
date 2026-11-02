import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { initBountyPanel } from "../src/sidepanel/bounty-panel.ts";
import type { PogoBountyPublicState, PogoBountyView } from "../src/domain/pogo-bounty.ts";

function view(partial: Partial<PogoBountyView> & Pick<PogoBountyView, "id" | "title" | "canJoin">): PogoBountyView {
  return {
    description: null,
    claimFee: 0,
    slotsLeft: 4,
    maxSlots: 10,
    eligible: true,
    skipReason: null,
    skipLabel: "",
    claimed: false,
    invited: false,
    requiredTag: null,
    targetTweetUrl: null,
    expiresAt: null,
    rewardPoints: 0,
    cryptoToken: null,
    cryptoAmount: null,
    minPlacement: null,
    minFollowers: null,
    requiredWalletType: null,
    series: null,
    lastJoin: null,
    ...partial,
  };
}

test("bounty panel Join is enabled only for joinable items and auto-join toggle sends", async (t) => {
  const { document, window } = parseHTML(readFileSync(new URL("../src/sidepanel/sidepanel.html", import.meta.url), "utf8"));
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => original ? Object.defineProperty(globalThis, "document", original) : Reflect.deleteProperty(globalThis, "document"));

  const base: PogoBountyPublicState = {
    autoJoin: false,
    scannedAt: 1,
    error: null,
    hops: 900,
    joinableCount: 1,
    claimedCount: 0,
    items: [
      view({
        id: 68,
        title: "Rome Protocol Ambassadors - Series 1",
        canJoin: false,
        eligible: false,
        skipReason: "placement",
        skipLabel: "Rank chưa đủ",
        claimFee: 750,
        slotsLeft: 0,
        maxSlots: 35,
        cryptoAmount: 225,
        cryptoToken: "USDC",
        series: { currentStep: 2, stepCount: 4, runState: "not_joined" },
      }),
      view({ id: 99, title: "Open bounty", canJoin: true }),
    ],
  };

  const calls: { type: string; extra?: Record<string, unknown> }[] = [];
  const panel = initBountyPanel(async (type, extra) => {
    calls.push({ type, extra });
    if (type === "pogo_bounties_auto_join") {
      return { ok: true, bounties: { ...base, autoJoin: extra?.enabled === true } };
    }
    if (type === "pogo_bounty_claim") {
      return {
        ok: true,
        bounties: {
          ...base,
          joinableCount: 0,
          claimedCount: 1,
          items: base.items.map((item) => item.id === extra?.id
            ? { ...item, canJoin: false, claimed: true, skipReason: "already_claimed", skipLabel: "Đã join" }
            : item),
        },
      };
    }
    return { ok: true, bounties: base };
  });

  panel.onMessage({ type: "pogo_bounties", bounties: base });

  const articles = [...document.querySelectorAll("#pogo-bounty-list article")];
  assert.equal(articles.length, 2);
  const buttons = articles.map((card) => card.querySelector("button") as HTMLButtonElement);
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[0].textContent, "Rank chưa đủ");
  assert.equal(buttons[1].disabled, false);
  assert.equal(buttons[1].textContent, "Join");
  assert.equal(document.getElementById("pogo-bounty-status")?.textContent, "Đã quét 2 bounty · 1 join được · 0 đã join · 900 Hops.");
  assert.equal(document.getElementById("src-bounty-chip")?.textContent, "1 join được");

  const auto = document.getElementById("pogo-bounty-auto-join") as HTMLInputElement;
  assert.equal(auto.checked, false);
  auto.checked = true;
  auto.dispatchEvent(new window.Event("change", { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.at(-1)?.type, "pogo_bounties_auto_join");
  assert.equal(calls.at(-1)?.extra?.enabled, true);
  assert.equal(auto.checked, true);

  buttons[1].click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.at(-1)?.type, "pogo_bounty_claim");
  assert.equal(calls.at(-1)?.extra?.id, 99);
  assert.equal(document.querySelectorAll("#pogo-bounty-list button")[1]?.textContent, "Đã join");
});
