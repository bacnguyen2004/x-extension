import type { BrowseSurface } from "../domain/agent-settings.ts";
import { sanitizeListUrlOrName } from "../domain/agent-settings.ts";
import { pathMatchesBrowseSurface } from "./identity.ts";
import { click, sleep, waitFor } from "./dom-utils.ts";
import { assertActionActive } from "./action-control.ts";

/** Use X's own Back arrow; X retains the originating feed and its scroll. */
export async function backToBrowse(opts: { surface: BrowseSurface; tweetId: string; listUrl?: string | null; followedProfile?: string }): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const atSource = () => {
    if (!pathMatchesBrowseSurface(location.pathname, opts.surface)) return false;
    if (opts.surface !== "lists") return true;
    const list = sanitizeListUrlOrName(opts.listUrl || "");
    return !!list && location.pathname.replace(/\/+$/, "").toLowerCase() === new URL(list).pathname.toLowerCase();
  };
  const onPost = () => /^\d{1,30}$/.test(opts.tweetId) && new RegExp(`/status/${opts.tweetId}(?:/|$)`).test(location.pathname);
  const followedProfile = opts.followedProfile?.replace(/^@/, "").toLowerCase();
  const fromProfile = !!followedProfile && /^[a-z0-9_]{1,15}$/.test(followedProfile) && location.pathname.replace(/\/+$/, "").toLowerCase() === `/${followedProfile}`;
  assertActionActive();
  if (atSource()) return { ok: true, detail: "browse_back_already" };
  // Follow can add one profile page after the post, requiring one extra Back.
  for (let step = 0; step < (fromProfile ? 2 : 1); step++) {
    assertActionActive();
    const arrow = [...document.querySelectorAll<HTMLElement>('[data-testid="app-bar-back"]')]
      .find(button => !button.closest('[aria-hidden="true"], [hidden]'));
    if (!arrow) return { ok: false, error: "back_arrow_missing" };
    const before = location.href;
    if (!click(arrow)) return { ok: false, error: "back_arrow_click_failed" };
    await waitFor(() => atSource() || location.href !== before ? true : null, 4000, 100);
    assertActionActive();
    if (atSource()) return { ok: true, detail: "browse_back_done" };
    if (!fromProfile || step > 0 || !onPost()) break;
    await sleep(3000 + Math.floor(Math.random() * 2001));
  }
  return { ok: false, error: "back_not_at_source" };
}
