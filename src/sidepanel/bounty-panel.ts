/**
 * Tab Nguồn — Bounties Pogo: quét, join tay, tự join.
 */

import type { PogoBountyPublicState, PogoBountyView } from "../domain/pogo-bounty.ts";

type Send = (
  type: string,
  extra?: Record<string, unknown>,
) => Promise<{ ok: boolean; bounties?: PogoBountyPublicState; error?: string }>;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function rewardText(item: PogoBountyView): string {
  const bits: string[] = [];
  if (item.cryptoAmount && item.cryptoToken) bits.push(`${item.cryptoAmount} ${item.cryptoToken}`);
  else if (item.cryptoAmount) bits.push(String(item.cryptoAmount));
  if (item.rewardPoints > 0) bits.push(`${item.rewardPoints} Hops`);
  return bits.join(" · ") || "—";
}

function slotsText(item: PogoBountyView): string {
  if (item.maxSlots != null) return `${item.slotsLeft}/${item.maxSlots} slot`;
  return `${item.slotsLeft} slot`;
}

function seriesText(item: PogoBountyView): string | null {
  if (!item.series) return null;
  const step = item.series.currentStep != null && item.series.stepCount
    ? `Tuần ${item.series.currentStep}/${item.series.stepCount}`
    : "Series";
  return step;
}

export function initBountyPanel(send: Send): {
  onViewEnter: (view: string) => void;
  onMessage: (msg: unknown) => void;
  refresh: () => Promise<void>;
} {
  const statusEl = $("pogo-bounty-status");
  const listEl = $("pogo-bounty-list");
  const chipEl = $("src-bounty-chip");
  const autoEl = input("pogo-bounty-auto-join");
  const refreshBtn = $("btn-pogo-bounty-refresh") as HTMLButtonElement;
  let loaded = false;
  let painting = false;

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  function paint(state: PogoBountyPublicState): void {
    painting = true;
    autoEl.checked = state.autoJoin;
    chipEl.textContent = state.joinableCount > 0 ? `${state.joinableCount} join được` : state.items.length ? "0 join được" : "Bounty —";
    chipEl.classList.toggle("ok", state.joinableCount > 0);
    chipEl.classList.toggle("open", state.joinableCount === 0 && state.items.length > 0);

    if (state.error) setStatus(state.error);
    else if (!state.scannedAt) setStatus("Chưa quét bounty. Bấm Quét bounty hoặc Quét Pogo.");
    else {
      const hops = state.hops != null ? ` · ${Math.trunc(state.hops)} Hops` : "";
      setStatus(`Đã quét ${state.items.length} bounty · ${state.joinableCount} join được · ${state.claimedCount} đã join${hops}.`);
    }

    listEl.replaceChildren();
    if (!state.items.length) {
      const empty = document.createElement("p");
      empty.className = "field-hint";
      empty.textContent = "Chưa có bounty trên tài khoản này.";
      listEl.appendChild(empty);
      painting = false;
      return;
    }

    for (const item of state.items) {
      const card = document.createElement("article");
      card.className = item.claimed ? "src-link done-reply" : item.canJoin ? "src-link" : "src-link stale";

      const top = document.createElement("div");
      top.className = "src-link-top";
      const title = document.createElement("strong");
      title.className = "src-link-author";
      title.textContent = item.title;
      top.appendChild(title);

      const chips = document.createElement("div");
      chips.className = "src-link-chips";
      const reward = document.createElement("span");
      reward.className = "src-chip boost";
      reward.textContent = rewardText(item);
      chips.appendChild(reward);
      const slots = document.createElement("span");
      slots.className = `src-chip ${item.slotsLeft > 0 ? "open" : "stale"}`;
      slots.textContent = slotsText(item);
      chips.appendChild(slots);
      if (seriesText(item)) {
        const series = document.createElement("span");
        series.className = "src-chip";
        series.textContent = seriesText(item)!;
        chips.appendChild(series);
      }
      if (item.claimFee > 0) {
        const fee = document.createElement("span");
        fee.className = "src-chip open";
        fee.textContent = `${item.claimFee} Hops phí`;
        chips.appendChild(fee);
      }
      if (item.skipLabel) {
        const skip = document.createElement("span");
        skip.className = item.claimed ? "src-chip ok" : "src-chip stale";
        skip.textContent = item.skipLabel;
        chips.appendChild(skip);
      }
      top.appendChild(chips);
      card.appendChild(top);

      const meta = document.createElement("p");
      meta.className = "src-link-text";
      const bits = [
        item.requiredTag,
        item.minPlacement != null ? `Rank ≥ ${item.minPlacement}` : null,
        item.minFollowers != null ? `${item.minFollowers}+ follower` : null,
        item.requiredWalletType ? `Ví ${item.requiredWalletType}` : null,
      ].filter(Boolean);
      meta.textContent = bits.join(" · ");
      if (bits.length) card.appendChild(meta);

      const foot = document.createElement("div");
      foot.className = "src-link-foot";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = item.canJoin ? "btn primary src-open" : "btn ghost src-open";
      btn.disabled = !item.canJoin;
      btn.textContent = item.claimed
        ? "Đã join"
        : item.canJoin && item.claimFee > 0
          ? `Join · ${item.claimFee} Hops`
          : item.canJoin
            ? "Join"
            : item.skipLabel || "Không join được";
      btn.addEventListener("click", () => {
        if (!item.canJoin) return;
        void (async () => {
          btn.disabled = true;
          const res = await send("pogo_bounty_claim", { id: item.id });
          if (res.bounties) paint(res.bounties);
          setStatus(res.ok ? `Đã join: ${item.title}` : res.error || "Join thất bại.");
        })();
      });
      foot.appendChild(btn);
      if (item.lastJoin && !item.lastJoin.ok && item.lastJoin.error) {
        const err = document.createElement("span");
        err.className = "src-link-url";
        err.textContent = item.lastJoin.error;
        foot.appendChild(err);
      }
      card.appendChild(foot);
      listEl.appendChild(card);
    }
    painting = false;
  }

  async function refresh(): Promise<void> {
    const res = await send("pogo_bounties_get");
    if (res.ok && res.bounties) paint(res.bounties);
  }

  async function scan(): Promise<void> {
    refreshBtn.disabled = true;
    setStatus("Đang quét bounty…");
    const res = await send("pogo_bounties_sync");
    refreshBtn.disabled = false;
    if (res.bounties) paint(res.bounties);
    else setStatus(res.error || "Không quét được bounty.");
  }

  autoEl.addEventListener("change", () => {
    if (painting) return;
    void (async () => {
      const res = await send("pogo_bounties_auto_join", { enabled: autoEl.checked });
      if (res.bounties) paint(res.bounties);
    })();
  });

  refreshBtn.addEventListener("click", () => {
    void scan();
  });

  return {
    onViewEnter(view: string) {
      if (view !== "tasks") return;
      if (!loaded) {
        loaded = true;
        void refresh();
      }
    },
    onMessage(msg: unknown) {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; bounties?: PogoBountyPublicState };
      if (m.type === "pogo_bounties" && m.bounties) paint(m.bounties);
    },
    refresh,
  };
}
