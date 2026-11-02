import type { Campaign, PersistedState } from "./types.ts";
import { campaignList } from "./merge.ts";

export function buildExportPayload(state: PersistedState) {
  const campaigns = campaignList(state).map(toExportCampaign);
  return {
    exported_at: new Date().toISOString(),
    source: "pogo-task-reader",
    note: "Task đã đọc từ DOM và/hoặc API. Không chắc là toàn bộ feed. Không chứa token hay thông tin xác thực.",
    last_dom_scan_at: state.last_dom_scan_at,
    last_data_change_at: state.last_data_change_at,
    linked_account: state.linked_account,
    campaigns,
  };
}

function toExportCampaign(c: Campaign) {
  return {
    tweet_id: c.tweet_id,
    author_handle: c.author_handle,
    tweet_url: c.tweet_url,
    tweet_url_source: c.tweet_url_source,
    text: c.text,
    my_interactions: (["reply", "retweet", "quote"] as const).filter(
      (k) => c.actions[k].status === "recorded",
    ),
    actions: c.actions,
    follows_author: c.follows_author,
    locked: c.locked ?? null,
    locked_points: c.locked_points ?? null,
    author_tier: c.author_tier,
    author_division: c.author_division == null ? null : { number: c.author_division },
    pinned: c.pinned,
    boosted: c.boosted,
    bonus_label: c.bonus_label,
    earned_points: Object.fromEntries(
      (["reply", "retweet", "quote"] as const)
        .filter((k) => c.actions[k].status === "recorded" && c.actions[k].displayedPoints != null)
        .map((k) => [k, c.actions[k].displayedPoints]),
    ),
    last_observed_at: c.last_observed_at,
    source: c.source,
    stale: c.stale,
  };
}
