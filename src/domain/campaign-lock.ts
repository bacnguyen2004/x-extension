import type { Campaign } from "./types.ts";

/** Preserve the server's lock state; a local Follow is not proof of earning eligibility. */
export function readCampaignLock(raw: {
  locked?: unknown;
  is_locked?: unknown;
  locked_points?: unknown;
  follows_author?: unknown;
}): { locked: boolean | null; locked_points: number | null } {
  const value = typeof raw.locked_points === "string" && /^\d+$/.test(raw.locked_points.trim())
    ? Number(raw.locked_points) : raw.locked_points;
  const points = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const locked = raw.locked === true || raw.is_locked === true || (points != null && points > 0)
    ? true
    : points === 0 || raw.locked === false || raw.is_locked === false
      ? false
      : raw.follows_author === false ? true : raw.follows_author === true ? false : null;
  return { locked, locked_points: points };
}

export function isCampaignLocked(campaign: Pick<Campaign, "follows_author" | "locked" | "locked_points">): boolean {
  return readCampaignLock(campaign).locked === true;
}
