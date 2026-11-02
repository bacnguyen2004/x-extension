/**
 * Persist list link bài X (tab Nguồn → tương tác theo link).
 */

import { emptyActions, type Campaign } from "../domain/types.ts";
import {
  handleFromTweetUrl,
  MAX_LINK_LIST,
  parseTweetUrlList,
  sanitizeTweetUrl,
  tweetIdFromTweetUrl,
} from "../domain/url.ts";

const STORAGE_KEY = "xContentCreator.linkList.v1";

export interface LinkListState {
  urls: string[];
  updatedAt: number | null;
}

let cache: LinkListState | null = null;

function emptyState(): LinkListState {
  return { urls: [], updatedAt: null };
}

function sanitizeUrls(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return parseTweetUrlList(raw.map(String).join("\n"), MAX_LINK_LIST);
  }
  if (typeof raw === "string") return parseTweetUrlList(raw, MAX_LINK_LIST);
  return [];
}

export async function loadLinkList(): Promise<LinkListState> {
  if (cache) return cache;
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const saved = raw[STORAGE_KEY];
  if (saved && typeof saved === "object") {
    const o = saved as Record<string, unknown>;
    cache = {
      urls: sanitizeUrls(o.urls),
      updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : null,
    };
  } else {
    cache = emptyState();
  }
  return cache;
}

export async function saveLinkListFromText(text: string): Promise<LinkListState> {
  const urls = parseTweetUrlList(text, MAX_LINK_LIST);
  cache = { urls, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: cache });
  return cache;
}

export async function saveLinkListUrls(urls: string[]): Promise<LinkListState> {
  return saveLinkListFromText(urls.join("\n"));
}

export async function clearLinkList(): Promise<LinkListState> {
  cache = emptyState();
  await chrome.storage.local.set({ [STORAGE_KEY]: cache });
  return cache;
}

/** Convert stored URLs → synthetic campaigns cho planner. */
export function linksAsCampaigns(urls: string[], observedAt = Date.now()): Campaign[] {
  const out: Campaign[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const url = sanitizeTweetUrl(raw);
    if (!url) continue;
    const tweetId = tweetIdFromTweetUrl(url);
    const handle = handleFromTweetUrl(url);
    if (!tweetId || !handle || seen.has(tweetId)) continue;
    seen.add(tweetId);
    const actions = emptyActions();
    actions.reply = { status: "not_recorded", displayedPoints: null };
    actions.retweet = { status: "not_recorded", displayedPoints: null };
    actions.quote = { status: "not_recorded", displayedPoints: null };
    out.push({
      tweet_id: tweetId,
      author_handle: handle,
      tweet_url: url,
      tweet_url_source: "constructed",
      text: null,
      actions,
      follows_author: false,
      author_tier: null,
      author_division: null,
      pinned: false,
      boosted: false,
      bonus_label: null,
      last_observed_at: observedAt,
      source: "api",
      stale: false,
    });
  }
  return out;
}

export async function loadLinkCampaigns(): Promise<Campaign[]> {
  const state = await loadLinkList();
  return linksAsCampaigns(state.urls);
}
