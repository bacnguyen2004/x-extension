import type { Campaign, PublicState, UiStatus } from "../domain/types.ts";
import { ACTION_KINDS } from "../domain/types.ts";
import { actionLabel, campaignList, filterCampaigns, type ListFilter } from "../domain/merge.ts";
import { statusLabel } from "../domain/status.ts";
import { sanitizeTweetUrl } from "../domain/url.ts";
import { isCampaignLocked } from "../domain/campaign-lock.ts";
import { actionProgressLabel } from "../domain/action-progress.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function statusClass(status: Campaign["actions"]["reply"]["status"]): string {
  if (status === "recorded") return "ok";
  if (status === "not_recorded") return "open";
  return "unk";
}

function modeLabel(mode: PublicState["mode"]): string {
  if (mode === "watching") return "Đang theo dõi";
  if (mode === "paused") return "Tạm dừng";
  return "Chưa chạy";
}

function connectionDot(status: UiStatus): string {
  if (status === "watching" || status === "idle_ready") return "pill-dot";
  if (status === "waiting_feed" || status === "login_check" || status === "no_token") {
    return "pill-dot warn";
  }
  return "pill-dot off";
}

export function renderStatus(root: HTMLElement, state: PublicState): void {
  const doc = root.ownerDocument;
  root.replaceChildren();

  const ready = state.api_token_present && !state.login_required;

  const title = doc.getElementById("src-title");
  if (title) title.textContent = statusLabel(state.ui_status);

  const live = doc.getElementById("src-live-dot");
  if (live) {
    live.classList.remove("on", "warn");
    if (ready && (state.mode === "watching" || state.ui_status === "watching" || state.ui_status === "idle_ready")) {
      live.classList.add("on");
    } else if (!ready || state.ui_status === "no_token" || state.ui_status === "login_check") {
      live.classList.add("warn");
    }
  }

  const meta = el(doc, "div", "src-pills");
  const conn = el(doc, "span", ready ? "pill ok" : "pill warn");
  conn.appendChild(el(doc, "span", connectionDot(state.ui_status)));
  conn.appendChild(
    doc.createTextNode(state.login_required && state.api_token_present ? "Phiên hết hạn" : ready ? "Đã có phiên API" : "Chưa có phiên API"),
  );
  meta.appendChild(conn);
  meta.appendChild(el(doc, "span", "pill", modeLabel(state.mode)));
  if (state.linked_account) {
    meta.appendChild(el(doc, "span", "pill", `@${state.linked_account.handle}`));
  }
  if (state.api_http_status != null) {
    meta.appendChild(el(doc, "span", "pill", `HTTP ${state.api_http_status}`));
  }
  root.appendChild(meta);

  const metrics = el(doc, "div", "metrics src-metrics");
  for (const [num, lbl] of [
    [String(state.campaign_count), "Chiến dịch"],
    [String(state.observed_count), "Vừa thấy"],
    [String(state.stale_count), "Đã cũ"],
  ] as const) {
    const m = el(doc, "div", "metric");
    m.appendChild(el(doc, "span", "num", num));
    m.appendChild(el(doc, "span", "lbl", lbl));
    metrics.appendChild(m);
  }
  root.appendChild(metrics);

  if (state.warnings.length) {
    const box = el(doc, "div", "warnings");
    for (const w of state.warnings) {
      box.appendChild(el(doc, "p", "warn", w));
    }
    root.appendChild(box);
  }
}

export function renderCampaignCard(
  doc: Document,
  campaign: Campaign,
  onOpen: (url: string) => void,
): HTMLElement {
  const safe = sanitizeTweetUrl(campaign.tweet_url);
  const card = el(doc, "article", campaign.stale ? "src-link stale" : "src-link");

  const top = el(doc, "div", "src-link-top");
  top.appendChild(
    el(doc, "strong", "src-link-author", campaign.author_handle ? `@${campaign.author_handle}` : "—"),
  );
  const replyDone = campaign.actions.reply.status === "recorded";
  const chips = el(doc, "div", "src-link-chips");
  if (campaign.boosted) {
    const boost = el(doc, "span", "src-chip boost", campaign.bonus_label ? `Boost · ${campaign.bonus_label}` : "Boost · ưu tiên");
    boost.title = "Task Boost được ưu tiên trước task thường khi đủ điều kiện.";
    chips.appendChild(boost);
  }
  for (const kind of ACTION_KINDS) {
    const a = campaign.actions[kind];
    const chip = el(doc, "span", `src-chip ${statusClass(a.status)}`, `${actionLabel(kind)}: ${actionProgressLabel(a)}`);
    chip.title = actionProgressLabel(a);
    chips.appendChild(chip);
  }
  if (campaign.follows_author === true) chips.appendChild(el(doc, "span", "src-chip ok", "F"));
  if (isCampaignLocked(campaign)) chips.appendChild(el(doc, "span", "src-chip stale", "Locked"));
  if (replyDone) chips.appendChild(el(doc, "span", "src-chip ok", "đã reply"));
  if (campaign.stale) chips.appendChild(el(doc, "span", "src-chip stale", "cũ"));
  top.appendChild(chips);
  card.appendChild(top);
  if (replyDone) card.classList.add("done-reply");

  const snippet = (campaign.text ?? "").replace(/\s+/g, " ").trim();
  if (snippet) {
    card.appendChild(el(doc, "p", "src-link-text", snippet.length > 100 ? `${snippet.slice(0, 100)}…` : snippet));
  }

  const foot = el(doc, "div", "src-link-foot");
  const openBtn = el(
    doc,
    "button",
    replyDone ? "btn ghost src-open" : "btn accent src-open",
    replyDone ? "Đã xong" : safe ? "Mở link" : "Hết link",
  );
  openBtn.type = "button";
  openBtn.disabled = !safe;
  openBtn.addEventListener("click", () => {
    if (safe) onOpen(safe);
  });
  foot.appendChild(openBtn);
  foot.appendChild(el(doc, "span", "src-link-url", safe ?? campaign.tweet_id));
  card.appendChild(foot);

  if (safe) {
    card.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest("button")) return;
      onOpen(safe);
    });
    card.classList.add("clickable");
  }

  return card;
}

export function renderList(
  root: HTMLElement,
  state: PublicState,
  filter: ListFilter,
  query: string,
  onOpen: (url: string) => void,
): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const items = filterCampaigns(campaignList(state), filter, query);
  if (!items.length) {
    root.appendChild(
      el(
        doc,
        "p",
        "empty",
        filter === "todo"
          ? "Không còn chiến dịch cần xử lý. Chọn “Tất cả” để xem lại."
          : filter === "locked"
            ? "Không có task Locked."
            : "Chưa có chiến dịch. Kết nối Pogo rồi bấm Quét.",
      ),
    );
    return;
  }
  for (const c of items) {
    root.appendChild(renderCampaignCard(doc, c, onOpen));
  }
}
