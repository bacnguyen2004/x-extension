import { click, findTweetArticle, waitFor } from "./dom-utils.ts";
import type { EngageResult } from "./actions/engage.ts";

/** Only the target post's menu is opened; ambiguous submission never falls back to another click. */
export async function followFromPost(handle: string, tweetId: string): Promise<EngageResult> {
  const fallback: EngageResult = { ok: false, error: "inline_follow_unavailable" };
  if (!/^[a-z0-9_]{1,15}$/i.test(handle) || !/^\d+$/.test(tweetId)) return fallback;
  const article = findTweetArticle(tweetId);
  if (!article || article.closest('[hidden], [aria-hidden="true"]')) return fallback;
  const ownsPost = [...article.querySelectorAll('a[href]')].some(a =>
    a.closest('article[data-testid="tweet"]') === article && !a.closest('[data-testid="quoteTweet"]') &&
    new RegExp(`^(?:https://(?:www\\.)?(?:x|twitter)\\.com)?/${handle}/status/${tweetId}(?:[/?#]|$)`, "i").test(a.getAttribute("href") || ""));
  const caret = [...article.querySelectorAll<HTMLElement>('[data-testid="caret"]')].find(el =>
    el.closest('article[data-testid="tweet"]') === article && !el.closest('[data-testid="quoteTweet"]'));
  // Do not reuse a menu opened by the user or by a different action.
  if (!ownsPost || !caret || document.querySelector('[role="menu"]')) return fallback;
  const currentMenu = () => document.querySelector('[role="menu"]');
  const state = () => {
    for (const item of currentMenu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []) {
      const label = (item.textContent || "").replace(/\s+/g, " ").trim();
      if (new RegExp(`^(?:unfollow|hủy theo dõi|bỏ theo dõi) @${handle}$`, "i").test(label)) return { item, kind: "following" as const };
      if (new RegExp(`^(?:requested|đã yêu cầu|đã gửi yêu cầu|cancel follow request|hủy yêu cầu theo dõi) @${handle}$`, "i").test(label)) return { item, kind: "requested" as const };
      if (new RegExp(`^(?:follow|theo dõi) @${handle}$`, "i").test(label)) return { item, kind: "follow" as const };
    }
    return null;
  };
  try {
    if (!click(caret)) return fallback;
    const option = await waitFor(state, 1500);
    if (!option) return fallback;
    if (option.kind !== "follow") return { ok: true, detail: option.kind === "following" ? "already_following" : "follow_requested" };
    if (option.item.getAttribute("aria-disabled") === "true" || option.item.hasAttribute("disabled")) return { ok: false, error: "follow_disabled" };
    if (!click(option.item)) return { ok: false, error: "follow_click_failed" };
    let confirmed = await waitFor(() => { const s = state(); return s && s.kind !== "follow" ? s : null; }, 1000);
    if (!confirmed && !currentMenu()) {
      // Read the menu again to verify. Never click Follow a second time.
      click(caret);
      confirmed = await waitFor(() => { const s = state(); return s && s.kind !== "follow" ? s : null; }, 2000);
    }
    if (!confirmed) return { ok: false, error: "follow_not_confirmed", detail: "inline_follow_unverified" };
    return { ok: true, detail: confirmed.kind === "requested" ? "follow_requested" : "follow_confirmed" };
  } finally {
    // Only dismiss the menu belonging to this operation; never click an Unfollow option.
    if (currentMenu()) click(caret);
  }
}
