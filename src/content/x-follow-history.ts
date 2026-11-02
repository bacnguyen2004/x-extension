import { collectVisibleTimelineTweets, findVisibleTimelineTweetArticle } from "../x/timeline.ts";
import { scanFollowUserCells, readFollowProfileMeta, isVerifiedInRoot, detectFollowsYou } from "./x-follow-scan.ts";
import { extensionContextAlive } from "./extension-context.ts";

export function collectFollowingObservations(): Array<{ handle: string; verified?: boolean; followsYou?: boolean | null }> {
  const observations: Array<{ handle: string; verified?: boolean; followsYou?: boolean | null }> = scanFollowUserCells().filter(candidate => candidate.alreadyFollowing).map(candidate => ({
    handle: candidate.handle, verified: candidate.verified, followsYou: candidate.followsYou,
  }));
  const profileName = document.querySelector('[data-testid="UserName"]');
  if (profileName && !profileName.closest("article")) {
    const profile = readFollowProfileMeta();
    if (profile.onProfile && profile.alreadyFollowing && !profile.ownProfile)
      observations.push({ handle: profile.handle, verified: profile.verified, followsYou: profile.followsYou });
  }
  for (const tweet of collectVisibleTimelineTweets()) {
    if (!tweet.alreadyFollowing) continue;
    const article = findVisibleTimelineTweetArticle(tweet.tweetId);
    const name = [...(article?.querySelectorAll('[data-testid="User-Name"]') ?? [])].find(element =>
      element.closest('article[data-testid="tweet"]') === article && !element.closest('[data-testid="quoteTweet"], div[role="link"]'));
    observations.push({ handle: tweet.authorHandle, verified: name ? isVerifiedInRoot(name) : undefined,
      followsYou: name ? detectFollowsYou(name) : null });
  }
  return observations;
}

export function startFollowingObserver(): void {
  const sent = new Map<string, string>();
  let busy = false;
  const scan = async () => {
    if (busy || !extensionContextAlive()) return;
    busy = true;
    try {
      const changed = collectFollowingObservations().filter(entry => sent.get(entry.handle.toLowerCase()) !== JSON.stringify(entry)).slice(0, 50);
      if (!changed.length) return;
      const result = await chrome.runtime.sendMessage({ type: "x_following_observed", entries: changed });
      if (result?.ok) for (const entry of changed) sent.set(entry.handle.toLowerCase(), JSON.stringify(entry));
    } catch {} finally { busy = false; }
  };
  const timer = setInterval(() => {
    if (!extensionContextAlive()) { clearInterval(timer); return; }
    void scan();
  }, 5000);
  void scan();
}
