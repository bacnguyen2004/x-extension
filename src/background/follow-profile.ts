export interface ProfileResult {
  ok: boolean;
  error?: string;
  detail?: string;
  meta?: unknown;
}

export async function waitForFollowProfile(handle: string, deps: {
  read: (timeoutMs: number) => Promise<ProfileResult>;
  navigate: (url: string) => Promise<{ ok: boolean; error?: string }>;
  wait: (ms: number) => Promise<void>;
  cancelled: () => boolean;
}): Promise<ProfileResult> {
  const stopped = { ok: false, error: "stopped" };
  if (deps.cancelled()) return stopped;
  let result = await deps.read(5000);
  if (deps.cancelled()) return stopped;
  if (result.error === "need_navigate_profile") {
    const navigated = await deps.navigate(`https://x.com/${handle.replace(/^@/, "")}`);
    if (deps.cancelled()) return stopped;
    if (navigated.error === "stopped") return stopped;
    if (!navigated.ok) return { ok: false, error: navigated.error || "follow_profile_unverified" };
  }
  const deadline = Date.now() + 25000;
  for (let attempt = 0; attempt < 25; attempt++) {
    if (deps.cancelled()) return stopped;
    const meta = result.meta as { onProfile?: boolean; verified?: boolean; hasFollowButton?: boolean; alreadyFollowing?: boolean; ownProfile?: boolean } | undefined;
    if (result.ok && meta?.onProfile === true && typeof meta.verified === "boolean" &&
      (meta.hasFollowButton || meta.alreadyFollowing || meta.ownProfile)) return result;
    if (result.error && ["profile_unavailable", "profile_suspended", "profile_restricted"].includes(result.error)) return result;
    if (Date.now() >= deadline) break;
    for (let step = 0; step < 4; step++) {
      if (deps.cancelled()) return stopped;
      await deps.wait(250);
    }
    if (deps.cancelled()) return stopped;
    result = await deps.read(Math.max(1, Math.min(5000, deadline - Date.now())));
  }
  return { ok: false, error: "follow_profile_unverified" };
}
