import type {
  ActionKind,
  ActionState,
  Campaign,
  PersistedState,
  ScanSnapshot,
} from "./types.ts";
import { ACTION_KINDS } from "./types.ts";
import { isCampaignLocked } from "./campaign-lock.ts";

function meaningfulEqual(a: Campaign | undefined, b: Campaign): boolean {
  if (!a) return false;
  if (a.tweet_id !== b.tweet_id) return false;
  if (a.author_handle !== b.author_handle) return false;
  if (a.tweet_url !== b.tweet_url) return false;
  if (a.text !== b.text) return false;
  if (a.follows_author !== b.follows_author) return false;
  if (a.locked !== b.locked || a.locked_points !== b.locked_points) return false;
  if (a.author_tier !== b.author_tier) return false;
  if (a.author_division !== b.author_division) return false;
  if (a.pinned !== b.pinned) return false;
  if (a.boosted !== b.boosted) return false;
  if (a.bonus_label !== b.bonus_label) return false;
  for (const kind of ACTION_KINDS) {
    const x = a.actions[kind];
    const y = b.actions[kind];
    if (x.status !== y.status || x.displayedPoints !== y.displayedPoints || x.recordedBy !== y.recordedBy) return false;
    if (JSON.stringify(x.local) !== JSON.stringify(y.local)) return false;
  }
  return true;
}

/** Preserve actual Pogo receipts and keep local attempts separate from rewards. */
export function mergeActionKeepDone(prev: ActionState, incoming: ActionState): ActionState {
  if (prev.status === "recorded" && prev.recordedBy === "pogo") {
    return {
      status: "recorded",
      recordedBy: "pogo",
      displayedPoints: incoming.displayedPoints ?? prev.displayedPoints,
    };
  }
  const local = prev.local ?? (prev.status === "recorded" ? { state: "uncertain" as const, at: Date.now(), error: "legacy_recorded_unverified" } : undefined);
  return { ...incoming, ...(local && incoming.status !== "recorded" ? { local } : {}) };
}

/**
 * Gộp campaign từ scan với cache cũ.
 * Giữ bằng chứng thao tác local và trạng thái Pogo đã xác nhận.
 */
export function mergeCampaignKeepProgress(prev: Campaign | undefined, incoming: Campaign): Campaign {
  if (!prev) return incoming;
  const actions = { ...incoming.actions };
  for (const kind of ACTION_KINDS) {
    actions[kind] = mergeActionKeepDone(prev.actions[kind], incoming.actions[kind]);
  }
  return {
    ...incoming,
    actions,
    follows_author: prev.follows_author === true ? true : incoming.follows_author,
  };
}

/** Cập nhật cache từ một lần quét DOM/API. Không đánh dấu bài biến mất là đã làm. */
export function applyScan(prev: PersistedState, scan: ScanSnapshot): PersistedState {
  const previousHandle = prev.linked_account?.handle.replace(/^@/, "").toLowerCase();
  const incomingHandle = scan.linked_account?.handle.replace(/^@/, "").toLowerCase();
  if (previousHandle && incomingHandle && previousHandle !== incomingHandle) {
    prev = { ...clearCampaignCache(prev), linked_account: null };
  }
  const campaigns: Record<string, Campaign> = { ...prev.campaigns };
  let changed = false;
  const seen = new Set<string>();

  for (const item of scan.campaigns) {
    seen.add(item.tweet_id);
    const incoming: Campaign = {
      ...item,
      stale: false,
      last_observed_at: scan.scanned_at,
      source: item.source === "api" ? "api" : "dom",
    };
    const next = mergeCampaignKeepProgress(campaigns[item.tweet_id], incoming);
    if (!meaningfulEqual(campaigns[item.tweet_id], next)) changed = true;
    campaigns[item.tweet_id] = next;
  }

  // Chỉ đánh stale khi đã quan sát được ít nhất một bài (feed đang render).
  // Quét 0 bài không chứng minh feed trống hay bài đã hoàn thành.
  if (scan.feed_present) {
    for (const id of Object.keys(campaigns)) {
      if (!seen.has(id) && !campaigns[id].stale) {
        campaigns[id] = { ...campaigns[id], stale: true };
      }
    }
  }

  return {
    ...prev,
    campaigns,
    campaign_order: [...seen, ...Object.keys(campaigns).filter((id) => !seen.has(id))],
    last_dom_scan_at: scan.scanned_at,
    last_data_change_at: changed ? scan.scanned_at : prev.last_data_change_at,
    linked_account: scan.linked_account ?? prev.linked_account,
    login_required: scan.login_required,
    feed_visible: scan.feed_present,
    frame: {
      found: true,
      url: scan.frame_url,
      last_seen_at: scan.scanned_at,
    },
    ever_connected: true,
  };
}

export function clearCampaignCache(prev: PersistedState): PersistedState {
  return {
    ...prev,
    campaigns: {},
    campaign_order: [],
    last_dom_scan_at: null,
    last_data_change_at: null,
    feed_visible: false,
  };
}

export type ListFilter = "todo" | "all" | "locked" | "reply_open" | "retweet_open" | "quote_open";

export function filterCampaigns(
  campaigns: Campaign[],
  filter: ListFilter,
  query: string,
): Campaign[] {
  const q = query.trim().toLowerCase();
  return campaigns.filter((c) => {
    const locked = isCampaignLocked(c);
    if (filter === "locked" && !locked) return false;
    if (filter !== "all" && filter !== "locked" && locked) return false;
    // Todo = ẩn Reply đã done (recorded) — tránh nhìn lại / làm lại.
    if (filter === "todo" && c.actions.reply.status === "recorded") return false;
    if (filter === "reply_open" && c.actions.reply.status !== "not_recorded") return false;
    if (filter === "retweet_open" && c.actions.retweet.status !== "not_recorded") return false;
    if (filter === "quote_open" && c.actions.quote.status !== "not_recorded") return false;
    if (!q) return true;
    const hay = [c.tweet_id, c.author_handle ?? "", c.text ?? ""].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

/** Stable within each group: preserve the feed order while prioritizing Boosted. */
export function prioritizeBoosted(campaigns: Campaign[]): Campaign[] {
  return [...campaigns].sort((a, b) => Number(b.boosted) - Number(a.boosted));
}

export function campaignList(state: PersistedState): Campaign[] {
  const fallback = Object.values(state.campaigns).sort((a, b) => b.last_observed_at - a.last_observed_at);
  const ids = new Set([...(state.campaign_order ?? []), ...fallback.map((c) => c.tweet_id)]);
  return prioritizeBoosted([...ids].map((id) => state.campaigns[id]).filter((c): c is Campaign => !!c));
}

export function actionLabel(kind: ActionKind): string {
  if (kind === "reply") return "Reply";
  if (kind === "retweet") return "Retweet";
  return "Quote";
}
