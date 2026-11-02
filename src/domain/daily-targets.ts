import { defaultDailyTargets, todayKey, type AgentSettings, type AgentDailyStats, type AgentQuota } from "./agent-settings.ts";
import type { AgentJobKind } from "./agent-queue.ts";

export const TARGET_KINDS = ["reply", "like", "follow", "retweet", "quote"] as const;
export function dailyTarget(settings: AgentSettings, stats: AgentDailyStats, kind: keyof AgentQuota): number {
  if (kind === "retweet") return 0;
  const goals = settings.dailyTargets ?? defaultDailyTargets();
  if (!goals.enabled) return 0;
  return Math.max(0, goals.ranges[kind].max);
}

export function dailyActionReached(settings: AgentSettings, stats: AgentDailyStats, kind: AgentJobKind): boolean {
  const metric = kind === "post_reply" || kind === "draft_reply" ? "reply" : kind === "post_quote" || kind === "draft_quote" ? "quote"
    : kind === "scroll_home" ? null : kind;
  if (!metric || stats.date !== todayKey()) return false;
  const limit = dailyTarget(settings, stats, metric);
  return limit > 0 && stats[metric] >= limit;
}

export function allDailyTargetsReached(settings: AgentSettings, stats: AgentDailyStats): boolean {
  const active = TARGET_KINDS.filter((kind) => settings.actions[kind]);
  return stats.date === todayKey() && active.length > 0 && active.every((kind) => {
    const target = dailyTarget(settings, stats, kind);
    return target > 0 && stats[kind] >= target;
  });
}

export function withDailyTargets(settings: AgentSettings, stats: AgentDailyStats): AgentSettings {
  const actions = { ...settings.actions };
  for (const kind of TARGET_KINDS) {
    const jobKind = kind === "reply" ? "post_reply" : kind === "quote" ? "post_quote" : kind;
    if (dailyActionReached(settings, stats, jobKind)) actions[kind] = false;
  }
  return { ...settings, actions };
}
