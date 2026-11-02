/**
 * Bounty Pogo từ GET /api/bounties — cùng rule Mini App dùng để hiện CTA Join/Claim.
 */

export const POGO_CLAIMED_STATUSES = new Set(["claimed", "completed", "exported", "paid", "reversed"]);

export type PogoBountySkipReason =
  | "placement"
  | "followers"
  | "followers_unknown"
  | "ineligible"
  | "no_slots"
  | "already_claimed"
  | "join_closed"
  | "expired"
  | "not_enough_hops"
  | "in_debt"
  | "wallet_required";

export interface PogoBountyRequirements {
  minPlacement: number | null;
  minFollowers: number | null;
}

export interface PogoBountySeries {
  joinOpen: boolean;
  runState: string;
  currentStep: number | null;
  stepCount: number;
  potentialCryptoAmount: number | null;
  cryptoToken: string | null;
  payRule: string | null;
}

export interface PogoBountyLastJoin {
  at: number;
  ok: boolean;
  error?: string;
}

export interface PogoBounty {
  id: number;
  title: string;
  description: string | null;
  claimFee: number;
  slotsLeft: number;
  maxSlots: number | null;
  eligible: boolean;
  ineligibleReasons: string[];
  invited: boolean;
  myClaimStatus: string | null;
  requiredWalletType: "arbitrum" | "solana" | null;
  requiredTag: string | null;
  targetTweetUrl: string | null;
  targetAuthorHandle: string | null;
  expiresAt: string | null;
  rewardPoints: number;
  cryptoToken: string | null;
  cryptoAmount: number | null;
  requirements: PogoBountyRequirements;
  series: PogoBountySeries | null;
  lastJoin: PogoBountyLastJoin | null;
}

export interface PogoAccountEconomy {
  balance: number | null;
  debtOwed: number;
  walletType: string | null;
}

function intField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return null;
}

function numField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function strField(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function isSeriesBounty(bounty: Pick<PogoBounty, "series">): boolean {
  return bounty.series != null;
}

export function isBountyClaimed(bounty: PogoBounty): boolean {
  if (bounty.series) return bounty.series.runState !== "not_joined";
  return bounty.myClaimStatus != null && POGO_CLAIMED_STATUSES.has(bounty.myClaimStatus);
}

export function bountyExpired(bounty: PogoBounty, now = Date.now()): boolean {
  if (!bounty.expiresAt) return false;
  const at = Date.parse(bounty.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/** Cùng điều kiện Mini App `hd()`: đủ điều kiện + còn slot + chưa join. */
export function canClaimBounty(bounty: PogoBounty, now = Date.now()): boolean {
  return skipReasonForClaim(bounty, now) == null;
}

export function skipReasonForClaim(bounty: PogoBounty, now = Date.now()): PogoBountySkipReason | null {
  if (bounty.eligible === false) {
    const reasons = bounty.ineligibleReasons;
    if (reasons.includes("placement")) return "placement";
    if (reasons.includes("followers")) return "followers";
    if (reasons.includes("followers_unknown")) return "followers_unknown";
    return "ineligible";
  }
  if (bountyExpired(bounty, now)) return "expired";
  if (bounty.series) {
    if (bounty.series.runState !== "not_joined") return "already_claimed";
    if (!bounty.series.joinOpen) return "join_closed";
    if (bounty.slotsLeft <= 0) return "no_slots";
    return null;
  }
  if (isBountyClaimed(bounty)) return "already_claimed";
  if (bounty.slotsLeft <= 0) return "no_slots";
  return null;
}

/** Gate thêm cho tự join: phí Hops và ví payout. */
export function skipReasonForAutoJoin(
  bounty: PogoBounty,
  account: PogoAccountEconomy,
  now = Date.now(),
): PogoBountySkipReason | null {
  const base = skipReasonForClaim(bounty, now);
  if (base) return base;
  if (bounty.claimFee > 0) {
    if (account.debtOwed > 0) return "in_debt";
    if (account.balance == null || account.balance < bounty.claimFee) return "not_enough_hops";
  }
  if (bounty.requiredWalletType && account.walletType !== bounty.requiredWalletType) {
    return "wallet_required";
  }
  return null;
}

export function skipReasonLabel(reason: PogoBountySkipReason | null): string {
  switch (reason) {
    case "placement":
      return "Rank chưa đủ";
    case "followers":
      return "Chưa đủ follower";
    case "followers_unknown":
      return "Chưa đo được follower";
    case "ineligible":
      return "Không đủ điều kiện";
    case "no_slots":
      return "Hết slot";
    case "already_claimed":
      return "Đã join";
    case "join_closed":
      return "Đã đóng join";
    case "expired":
      return "Đã hết hạn";
    case "not_enough_hops":
      return "Không đủ Hops";
    case "in_debt":
      return "Đang nợ Hops";
    case "wallet_required":
      return "Cần ví payout";
    default:
      return "";
  }
}

export function normalizePogoBounty(raw: unknown, prev?: PogoBounty | null): PogoBounty | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = intField(o.id);
  if (id == null || id <= 0) return null;

  const reqRaw = o.requirements && typeof o.requirements === "object" && !Array.isArray(o.requirements)
    ? (o.requirements as Record<string, unknown>)
    : null;
  const seriesRaw = o.series && typeof o.series === "object" && !Array.isArray(o.series)
    ? (o.series as Record<string, unknown>)
    : null;

  const wallet = strField(o.required_wallet_type);
  const ineligible = Array.isArray(o.ineligible_reasons)
    ? o.ineligible_reasons.filter((x): x is string => typeof x === "string")
    : [];

  return {
    id,
    title: strField(o.title) || `Bounty #${id}`,
    description: strField(o.description),
    claimFee: Math.max(0, intField(o.claim_fee) ?? 0),
    slotsLeft: Math.max(0, intField(o.slots_left) ?? 0),
    maxSlots: intField(o.max_slots),
    eligible: o.eligible !== false,
    ineligibleReasons: ineligible,
    invited: o.invited === true,
    myClaimStatus: strField(o.my_claim_status),
    requiredWalletType: wallet === "arbitrum" || wallet === "solana" ? wallet : null,
    requiredTag: strField(o.required_tag),
    targetTweetUrl: strField(o.target_tweet_url),
    targetAuthorHandle: strField(o.target_author_handle),
    expiresAt: strField(o.expires_at),
    rewardPoints: Math.max(0, intField(o.reward_points) ?? 0),
    cryptoToken: strField(o.crypto_token) ?? (seriesRaw ? strField(seriesRaw.crypto_token) : null),
    cryptoAmount:
      numField(o.crypto_amount)
      ?? (seriesRaw ? numField(seriesRaw.total_crypto_amount) ?? numField(seriesRaw.potential_crypto_amount) : null),
    requirements: {
      minPlacement: reqRaw ? intField(reqRaw.min_placement) : null,
      minFollowers: reqRaw ? intField(reqRaw.min_followers) : null,
    },
    series: seriesRaw
      ? {
          joinOpen: seriesRaw.join_open === true,
          runState: strField(seriesRaw.run_state) || "not_joined",
          currentStep: intField(seriesRaw.current_step),
          stepCount: Math.max(0, intField(seriesRaw.step_count) ?? 0),
          potentialCryptoAmount: numField(seriesRaw.potential_crypto_amount),
          cryptoToken: strField(seriesRaw.crypto_token),
          payRule: strField(seriesRaw.pay_rule),
        }
      : null,
    lastJoin: prev?.id === id ? prev.lastJoin : null,
  };
}

/** Giữ claim local khi API list chưa kịp đánh dấu đã join. */
export function mergeBountyObservation(next: PogoBounty, prev?: PogoBounty | null): PogoBounty {
  if (!prev?.lastJoin?.ok) return { ...next, lastJoin: next.lastJoin ?? prev?.lastJoin ?? null };
  if (isBountyClaimed(next)) return { ...next, lastJoin: prev.lastJoin };
  return {
    ...next,
    myClaimStatus: prev.myClaimStatus ?? "claimed",
    slotsLeft: Math.min(next.slotsLeft, prev.slotsLeft),
    series: next.series && prev.series
      ? { ...next.series, runState: prev.series.runState, joinOpen: prev.series.joinOpen }
      : next.series,
    lastJoin: prev.lastJoin,
  };
}

export function extractBountyArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const o = body as Record<string, unknown>;
  if (Array.isArray(o.bounties)) return o.bounties;
  return [];
}

export type BountyTelegramKind = "new" | "joined" | "blocked" | "failed" | "uncertain";
export type BountyTelegramReason = PogoBountySkipReason | "join_failed" | "session_expired" | "network_error" | "service_error";

export interface BountyTelegramAlert {
  kind: BountyTelegramKind;
  id: number;
  title: string;
  reason?: BountyTelegramReason;
  fee: number;
  slots: number;
}

const CLAIM_ERROR_REASON: Record<string, BountyTelegramReason> = {
  placement: "placement",
  placement_too_low: "placement",
  followers: "followers",
  followers_too_few: "followers",
  followers_unknown: "followers_unknown",
  ineligible: "ineligible",
  no_slots: "no_slots",
  already_claimed: "already_claimed",
  join_closed: "join_closed",
  expired: "expired",
  not_enough_hops: "not_enough_hops",
  insufficient_points: "not_enough_hops",
  in_debt: "in_debt",
  wallet_required: "wallet_required",
};

export function bountyTelegramReason(code: string | null | undefined): BountyTelegramReason {
  if (!code) return "join_failed";
  if (/http_40[13]/.test(code)) return "session_expired";
  if (/http_5\d\d/.test(code)) return "service_error";
  return CLAIM_ERROR_REASON[code] ?? "join_failed";
}

export function bountyAlert(bounty: PogoBounty, kind: BountyTelegramKind, reason?: BountyTelegramReason): BountyTelegramAlert {
  return {
    kind,
    id: bounty.id,
    title: bounty.title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80),
    reason,
    fee: bounty.claimFee,
    slots: bounty.slotsLeft,
  };
}

/** Cảnh báo bot: bounty mới / vừa mở slot, đã join, hoặc join thất bại. Lần quét đầu bỏ bounty không join được. */
export function bountyTelegramAlerts(
  prev: PogoBounty[],
  next: PogoBounty[],
  opts: { primed: boolean; autoJoin: boolean; account: PogoAccountEconomy },
): BountyTelegramAlert[] {
  const prevById = new Map(prev.map((b) => [b.id, b]));
  const alerts: BountyTelegramAlert[] = [];
  for (const bounty of next) {
    const before = prevById.get(bounty.id);
    const isNew = !before;
    const justJoined = !!(bounty.lastJoin?.ok && !before?.lastJoin?.ok);
    const justFailed = !!(bounty.lastJoin && !bounty.lastJoin.ok && bounty.lastJoin.at !== before?.lastJoin?.at);
    const opened = !!(
      before
      && skipReasonForClaim(before)
      && skipReasonForClaim(before) !== "already_claimed"
      && canClaimBounty(bounty)
    );

    if (justJoined) {
      alerts.push(bountyAlert(bounty, "joined"));
      continue;
    }
    if (justFailed) {
      alerts.push(bountyAlert(bounty, "failed", bountyTelegramReason(bounty.lastJoin?.error)));
      continue;
    }
    if (!isNew && !opened) continue;
    if (!opts.primed && !canClaimBounty(bounty) && !opened) continue;
    if (isBountyClaimed(bounty)) continue;

    const skip = opts.autoJoin
      ? skipReasonForAutoJoin(bounty, opts.account)
      : skipReasonForClaim(bounty);
    if (skip) alerts.push(bountyAlert(bounty, "blocked", skip));
    else alerts.push(bountyAlert(bounty, "new"));
  }
  return alerts;
}

export interface PogoBountyView {
  id: number;
  title: string;
  description: string | null;
  claimFee: number;
  slotsLeft: number;
  maxSlots: number | null;
  eligible: boolean;
  canJoin: boolean;
  skipReason: PogoBountySkipReason | null;
  skipLabel: string;
  claimed: boolean;
  invited: boolean;
  requiredTag: string | null;
  targetTweetUrl: string | null;
  expiresAt: string | null;
  rewardPoints: number;
  cryptoToken: string | null;
  cryptoAmount: number | null;
  minPlacement: number | null;
  minFollowers: number | null;
  requiredWalletType: "arbitrum" | "solana" | null;
  series: { currentStep: number | null; stepCount: number; runState: string } | null;
  lastJoin: PogoBountyLastJoin | null;
}

export interface PogoBountyPublicState {
  autoJoin: boolean;
  scannedAt: number | null;
  error: string | null;
  hops: number | null;
  joinableCount: number;
  claimedCount: number;
  items: PogoBountyView[];
}
