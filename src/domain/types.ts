export type ActionKind = "reply" | "retweet" | "quote";
export type ActionStatus = "recorded" | "not_recorded" | "unknown";
export type WatchMode = "idle" | "watching" | "paused";
export type DataSource = "dom" | "api";

export type UiStatus =
  | "no_token"
  | "waiting_feed"
  | "watching"
  | "paused"
  | "login_check"
  | "cache_only"
  | "idle_ready";

export interface ActionState {
  status: ActionStatus;
  displayedPoints: number | null;
  recordedBy?: "pogo";
  /** Local execution evidence; never means Pogo awarded points. */
  local?: { state: "submitted" | "confirmed" | "uncertain" | "blocked"; at: number; error?: string };
}

export interface Campaign {
  tweet_id: string;
  author_handle: string | null;
  tweet_url: string | null;
  tweet_url_source: "dom" | "constructed" | "unknown";
  text: string | null;
  actions: Record<ActionKind, ActionState>;
  follows_author: boolean | null;
  /** Pogo eligibility from the latest feed. Optional for legacy cached campaigns. */
  locked?: boolean | null;
  locked_points?: number | null;
  author_tier: string | null;
  author_division: number | null;
  pinned: boolean;
  boosted: boolean;
  bonus_label: string | null;
  last_observed_at: number;
  source: DataSource;
  stale: boolean;
}

export interface LinkedAccount {
  handle: string;
  source: DataSource;
}

export interface ScanSnapshot {
  campaigns: Campaign[];
  scanned_at: number;
  frame_url: string;
  feed_present: boolean;
  login_required: boolean;
  linked_account: LinkedAccount | null;
  /** Từ API retweet_power — lượt đủ điểm còn lại. */
  retweet_remaining?: number | null;
  /** Từ API retweet_power — tổng lượt còn thưởng (full + reduced). */
  retweet_earning_remaining?: number | null;
  /** Từ API polling — mốc đối soát kế tiếp (ms). */
  polling_next_scan_at?: number | null;
}

export interface PersistedState {
  mode: WatchMode;
  data_source: DataSource;
  campaigns: Record<string, Campaign>;
  /** Latest feed order, independent of object insertion order. */
  campaign_order?: string[];
  last_dom_scan_at: number | null;
  last_data_change_at: number | null;
  linked_account: LinkedAccount | null;
  frame: {
    found: boolean;
    url: string | null;
    last_seen_at: number | null;
  };
  login_required: boolean;
  feed_visible: boolean;
  ever_connected: boolean;
  profile_confirmed: boolean;
  api_last_error: string | null;
  api_http_status: number | null;
}

export interface PublicState extends PersistedState {
  ui_status: UiStatus;
  frame_connected: boolean;
  api_token_present: boolean;
  campaign_count: number;
  observed_count: number;
  stale_count: number;
  warnings: string[];
}

export const ACTION_KINDS: ActionKind[] = ["reply", "retweet", "quote"];

export function emptyActions(): Record<ActionKind, ActionState> {
  return {
    reply: { status: "unknown", displayedPoints: null },
    retweet: { status: "unknown", displayedPoints: null },
    quote: { status: "unknown", displayedPoints: null },
  };
}

export function createInitialState(): PersistedState {
  return {
    mode: "idle",
    data_source: "api",
    campaigns: {},
    campaign_order: [],
    last_dom_scan_at: null,
    last_data_change_at: null,
    linked_account: null,
    frame: { found: false, url: null, last_seen_at: null },
    login_required: false,
    feed_visible: false,
    ever_connected: false,
    profile_confirmed: false,
    api_last_error: null,
    api_http_status: null,
  };
}
