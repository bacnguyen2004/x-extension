/**
 * Chuẩn hóa phần tử campaign từ GET https://pogo.social/api/feed.
 * Caller (feed-client / service worker) mới được gọi mạng. Không lưu token, không đoán refresh, không sửa JWT.
 *
 * Đã xác minh my_interactions: "reply", "retweet".
 * Giá trị quote hoàn thành chưa có mẫu — không đánh dấu quote recorded từ API.
 */

import type { ActionKind, Campaign } from "../domain/types.ts";
import { emptyActions } from "../domain/types.ts";
import { readCampaignLock } from "../domain/campaign-lock.ts";
import { constructTweetUrl, isHandle, isTweetId, sanitizeTweetUrl } from "../domain/url.ts";

const VERIFIED_INTERACTIONS = new Set(["reply", "retweet"]);

export function normalizeApiCampaign(raw: unknown, observedAt = Date.now()): Campaign | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // tweet_id phải là string. Số JSON lớn đã mất độ chính xác trước khi tới đây.
  if (typeof o.tweet_id !== "string" || !isTweetId(o.tweet_id)) return null;

  const handle =
    typeof o.author_handle === "string" && isHandle(o.author_handle) ? o.author_handle : null;

  const actions = emptyActions();
  const interactions = Array.isArray(o.my_interactions) ? o.my_interactions : [];
  const recorded = new Set(
    interactions.filter((x): x is string => typeof x === "string" && VERIFIED_INTERACTIONS.has(x)),
  );

  for (const kind of ["reply", "retweet"] as ActionKind[]) {
    actions[kind] = {
      status: recorded.has(kind) ? "recorded" : "not_recorded",
      ...(recorded.has(kind) ? { recordedBy: "pogo" as const } : {}),
      displayedPoints: null,
    };
  }
  // Quote: chưa xác minh token API → unknown.
  actions.quote = { status: "unknown", displayedPoints: null };

  const earned =
    o.earned_points && typeof o.earned_points === "object"
      ? (o.earned_points as Record<string, unknown>)
      : {};
  for (const kind of ["reply", "retweet", "quote"] as ActionKind[]) {
    const p = earned[kind];
    if (typeof p === "number" && Number.isInteger(p) && p >= 0) {
      actions[kind].displayedPoints = p;
    }
  }

  let url = sanitizeTweetUrl(typeof o.tweet_url === "string" ? o.tweet_url : null);
  let urlSource: Campaign["tweet_url_source"] = url ? "dom" : "unknown";
  if (!url && handle) {
    url = constructTweetUrl(handle, o.tweet_id);
    urlSource = url ? "constructed" : "unknown";
  }

  const division =
    o.author_division && typeof o.author_division === "object"
      ? (o.author_division as Record<string, unknown>).number
      : null;

  const bonus = o.bonus && typeof o.bonus === "object" ? o.bonus as Record<string, unknown> : null;
  const boosted = o.boosted === true && !(bonus && typeof bonus.left === "number" && bonus.left <= 0);
  const rate = boosted && bonus && typeof bonus.rate === "number" && Number.isFinite(bonus.rate) && bonus.rate > 0 ? bonus.rate : null;

  return {
    tweet_id: o.tweet_id,
    author_handle: handle,
    tweet_url: url,
    tweet_url_source: urlSource,
    text: typeof o.text === "string" ? o.text.slice(0, 32000) : null,
    actions,
    ...readCampaignLock(o),
    follows_author:
      o.follows_author === true ? true : o.follows_author === false ? false : null,
    author_tier: typeof o.author_tier === "string" ? o.author_tier : null,
    author_division:
      typeof division === "number" && Number.isInteger(division) ? division : null,
    pinned: o.pinned === true,
    boosted,
    bonus_label: rate == null ? null : `+${Math.round(rate * 100)}% Hops`,
    last_observed_at: observedAt,
    source: "api",
    stale: false,
  };
}
