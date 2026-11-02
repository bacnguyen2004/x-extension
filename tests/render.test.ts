import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { renderCampaignCard } from "../src/sidepanel/render.ts";
import { emptyActions, type Campaign } from "../src/domain/types.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";

test("render uses textContent — no HTML/script injection", () => {
  const { document } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
  const campaign: Campaign = {
    tweet_id: "2112057695247180169",
    author_handle: "evrendag1284",
    tweet_url: "https://x.com/evrendag1284/status/2112057695247180169",
    tweet_url_source: "constructed",
    text: '<img src=x onerror=alert(1)><script>alert(1)</script>Hello',
    actions: emptyActions(),
    follows_author: null,
    author_tier: null,
    author_division: null,
    pinned: false,
    boosted: false,
    bonus_label: null,
    last_observed_at: 1,
    source: "dom",
    stale: false,
  };
  const card = renderCampaignCard(document as unknown as Document, campaign, () => {});
  document.getElementById("root")!.appendChild(card);
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelector("script"), null);
  assert.ok(document.body.textContent?.includes("<script>alert(1)</script>"));
  assert.ok(document.body.textContent?.includes("Hello"));
  assert.equal(document.body.textContent?.includes("2112057695247180169"), true);
});

test("active boost shows bonus Hops prominently and exhausted bonus is not prioritized", () => {
  const raw = { tweet_id: "2112057695247180169", author_handle: "author", boosted: true, bonus: { rate: 0.5, left: 6, total: 100 } };
  const campaign = normalizeApiCampaign(raw)!;
  assert.equal(campaign.boosted, true);
  assert.equal(campaign.bonus_label, "+50% Hops");
  const { document } = parseHTML("<html><body></body></html>");
  const card = renderCampaignCard(document as unknown as Document, campaign, () => {});
  assert.equal(card.querySelector(".src-link-chips")?.firstElementChild?.textContent, "Boost · +50% Hops");
  const exhausted = normalizeApiCampaign({ ...raw, bonus: { ...raw.bonus, left: 0 } })!;
  assert.equal(exhausted.boosted, false);
  assert.equal(exhausted.bonus_label, null);
});
