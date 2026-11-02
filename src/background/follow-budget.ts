import { createEmptyDailyStats, sanitizeAgentSettings, todayKey, type AgentSettings } from "../domain/agent-settings.ts";
import { dailyTarget } from "../domain/daily-targets.ts";
import { sanitizeFollowSettings } from "../domain/follow-settings.ts";

const KEY = "xContentCreator.sharedFollow.v1";
const AGENT_STATS = "xContentCreator.agentStats.v1";
export interface FollowUsage { account: string; day: string; count: number; timestamps: number[] }
let tail: Promise<unknown> = Promise.resolve();
const reads = new Map<string, Promise<FollowUsage>>();
export function followAccount(handle: string): string { return handle.replace(/^@/, "").trim().toLowerCase() || "unknown"; }

export async function loadFollowUsage(handle: string): Promise<FollowUsage> {
  const account = followAccount(handle);
  const pending = reads.get(account);
  if (pending) return pending;
  const request = readFollowUsage(account).finally(() => { if (reads.get(account) === request) reads.delete(account); });
  reads.set(account, request);
  return request;
}

async function readFollowUsage(handle: string): Promise<FollowUsage> {
  const account = followAccount(handle), day = todayKey(), key = `${KEY}.${account}`;
  if (account === "unknown") return { account, day, count: 0, timestamps: [] };
  const saved = (await chrome.storage.local.get(key))[key] as FollowUsage | undefined;
  if (saved) return { account, day,
    count: saved.day === day && Number.isFinite(saved.count) ? Math.max(0, saved.count) : 0,
    timestamps: Array.isArray(saved.timestamps)
      ? saved.timestamps.filter(at => Number.isFinite(at) && at <= Date.now() && at > Date.now() - 1800000) : [] };
  // Claim old account-less Follow counters once, without copying them to every account.
  const owner = (await chrome.storage.local.get(`${KEY}.legacyOwner`))[`${KEY}.legacyOwner`];
  const legacy = (await chrome.storage.local.get("xContentCreator.followRuntime.v1"))["xContentCreator.followRuntime.v1"] as { day?: string; followedToday?: number; followTimestamps?: number[] } | undefined;
  const specific = (await chrome.storage.local.get(`${AGENT_STATS}.${account}`))[`${AGENT_STATS}.${account}`];
  const agent = (specific ?? (await chrome.storage.local.get(AGENT_STATS))[AGENT_STATS]) as { date?: string; account?: string; follow?: number } | undefined;
  const ownLegacy = !owner || owner === account;
  const usage: FollowUsage = { account, day,
    count: (agent?.date === day && (!agent.account || agent.account === account) ? Number(agent.follow) || 0 : 0)
      + (ownLegacy && legacy?.day === day ? Number(legacy.followedToday) || 0 : 0),
    timestamps: ownLegacy && Array.isArray(legacy?.followTimestamps)
      ? legacy.followTimestamps.filter(at => Number.isFinite(at) && at <= Date.now() && at > Date.now() - 1800000) : [] };
  await chrome.storage.local.set({ [key]: usage, ...(!owner ? { [`${KEY}.legacyOwner`]: account } : {}) });
  return usage;
}

export async function resetFollowUsage(handle: string): Promise<void> {
  const account = followAccount(handle), old = await loadFollowUsage(account);
  await chrome.storage.local.set({ [`${KEY}.${account}`]: { ...old, day: todayKey(), count: 0 } });
}

/** One lock covers the final limit check, X request and accounting in both runners. */
export function guardedFollow<T extends { ok: boolean; detail?: string; error?: string }>(options: {
  account: () => string; cancelled: () => boolean; origin: "agent" | "follow";
  settings?: AgentSettings; action: () => Promise<T>;
}): Promise<T | { ok: false; error: string; detail?: string }> {
  const run = async () => {
    const account = followAccount(options.account());
    if (options.cancelled()) return { ok: false as const, error: "stopped" };
    if (account === "unknown") return { ok: false as const, error: "follow_identity_missing" };
    const usage = await loadFollowUsage(account);
    const agent = options.settings ?? sanitizeAgentSettings((await chrome.storage.local.get("xContentCreator.agentSettings.v1"))["xContentCreator.agentSettings.v1"]);
    const follow = sanitizeFollowSettings((await chrome.storage.local.get("xContentCreator.follow.v1"))["xContentCreator.follow.v1"]);
    const cap = dailyTarget(agent, { ...createEmptyDailyStats(), account }, "follow");
    if ((cap > 0 && usage.count >= cap) || (options.origin === "follow" && usage.count >= follow.pace.dailyTarget))
      return { ok: false as const, error: "daily_target_reached" };
    if (usage.timestamps.filter(at => at > Date.now() - 1800000).length >= follow.pace.maxPer30Min)
      return { ok: false as const, error: "follow_rate_30m" };
    if (options.cancelled() || followAccount(options.account()) !== account) return { ok: false as const, error: "stopped" };
    const result = await options.action();
    if (result.ok && !["already_following", "own_profile"].includes(result.detail ?? "")) {
      // Requests to private accounts consume the budget too: a real Follow click occurred.
      const latest = await loadFollowUsage(account);
      const now = Date.now();
      await chrome.storage.local.set({ [`${KEY}.${account}`]: { ...latest, count: latest.count + 1,
        timestamps: [...latest.timestamps.filter(at => at > now - 1800000), now] } });
    }
    return result;
  };
  const result = tail.then(run, run);
  tail = result.catch(() => {});
  return result;
}
