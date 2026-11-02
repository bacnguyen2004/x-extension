export type XWorker = "agent" | "follow" | "unfollow" | "smm" | "manual";
let active: { owner: XWorker; token: symbol } | null = null;
let starting: XWorker | null = null;
const names: Record<XWorker, string> = { agent: "Agent", follow: "Follow", unfollow: "Unfollow", smm: "SMM", manual: "tác vụ X" };
export function getXWorker(): XWorker | null { return active?.owner ?? null; }
export function busyXMessage(owner: XWorker): string { return `Hãy dừng ${names[owner]} trước khi bật chế độ khác.`; }

async function persistedWorkers(): Promise<XWorker[]> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const keys = ["xContentCreator.agentRuntime.v1", "xContentCreator.followRuntime.v1", "xContentCreator.unfollowRuntime.v1"];
  const values = await Promise.all(keys.map(async key => (await chrome.storage.local.get(key))[key]));
  const result: XWorker[] = [];
  if (["running", "waiting"].includes(values[0]?.status)) result.push("agent");
  if (values[1]?.running) result.push("follow");
  if (values[2]?.running) result.push("unfollow");
  return result;
}

/** Reserve startup synchronously: concurrent clicks are rejected, never queued. */
export async function startExclusiveX<T extends { ok: boolean; error?: string }>(owner: XWorker, start: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  if (starting || active) return { ok: false, error: busyXMessage(starting ?? active!.owner) };
  starting = owner;
  try {
    const existing = (await persistedWorkers())[0];
    if (existing) return { ok: false, error: busyXMessage(existing) };
    return await start();
  } finally { if (starting === owner) starting = null; }
}

/** Reject busy operations immediately. There is no job or mode waiting queue. */
export async function acquireXTurn(owner: XWorker, cancelled: () => boolean = () => false): Promise<(() => void) | null> {
  if (cancelled() || active || (starting && starting !== owner)) return null;
  const other = (await persistedWorkers()).find(worker => worker !== owner);
  if (other || cancelled() || active || (starting && starting !== owner)) return null;
  const token = Symbol(owner); active = { owner, token };
  return () => { if (active?.token === token) active = null; };
}

export async function withXTurn<T>(owner: XWorker, work: () => Promise<T>): Promise<T> {
  const release = await acquireXTurn(owner);
  if (!release) throw new Error(busyXMessage(active?.owner ?? starting ?? (await persistedWorkers())[0] ?? owner));
  try { return await work(); } finally { release(); }
}
