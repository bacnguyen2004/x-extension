// Separate from the display queue: clearing old jobs must not allow another reply.
const PREFIX = "xcc.reply-attempt.v1.";
const pending = new Map<string, Promise<unknown>>();
export type ReplyEvidence = { attemptedAt: number; state: "reserved" | "submitted" | "confirmed" };

function historyKey(tweetId: string, handle: string, kind: "reply" | "quote" = "reply"): string | null {
  const own = handle.trim().replace(/^@/, "").toLowerCase();
  return /^\d{1,30}$/.test(tweetId) && /^[a-z0-9_]{1,15}$/.test(own)
    ? `${kind === "reply" ? PREFIX : "xcc.quote-attempt.v1."}${own}.${tweetId}` : null;
}

export async function hasReplyAttempt(tweetId: string, handle: string): Promise<boolean> {
  return !!await readReplyAttempt(tweetId, handle);
}

export async function readReplyAttempt(tweetId: string, handle: string, kind: "reply" | "quote" = "reply"): Promise<ReplyEvidence | null> {
  const key = historyKey(tweetId, handle, kind);
  if (!key) return null;
  const value = (await chrome.storage.local.get(key))[key];
  if (!value) return null;
  return { attemptedAt: typeof value.attemptedAt === "number" ? value.attemptedAt : 0,
    state: value.state === "confirmed" || value.state === "submitted" ? value.state : "reserved" };
}

export async function confirmOwnReply(tweetId: string, handle: string, kind: "reply" | "quote" = "reply"): Promise<void> {
  const key = historyKey(tweetId, handle, kind);
  if (!key) throw new Error("reply_identity_missing");
  await chrome.storage.local.set({ [key]: { attemptedAt: Date.now(), state: "confirmed" } });
}

/** Record BEFORE clicking: a lost bridge response must never cause another Post. */
export async function submitReplyOnce(
  tweetId: string, handle: string, submit: () => boolean, kind: "reply" | "quote" = "reply",
): Promise<"submitted" | "exists" | "click_failed"> {
  const key = historyKey(tweetId, handle, kind);
  if (!key) throw new Error("reply_identity_missing");
  const run = async () => {
    if (await readReplyAttempt(tweetId, handle, kind)) return "exists" as const;
    await chrome.storage.local.set({ [key]: { attemptedAt: Date.now(), state: "reserved" } });
    // Keep the marker even if the tab disappears or cancellation interrupts click.
    if (!submit()) return "click_failed" as const;
    await chrome.storage.local.set({ [key]: { attemptedAt: Date.now(), state: "submitted" } });
    return "submitted" as const;
  };
  // X tabs share the same origin; serialize their read/reserve/click operations.
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(key, run);
  }
  const previous = pending.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  pending.set(key, next);
  try { return await next; } finally { if (pending.get(key) === next) pending.delete(key); }
}
