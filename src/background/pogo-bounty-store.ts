/**
 * Cache bounty Pogo + tự join khi bật.
 */

import { claimPogoBounty, fetchPogoBounties, fetchPogoMeEconomy } from "../api/bounties-client.ts";
import {
  bountyTelegramAlerts,
  bountyAlert,
  bountyTelegramReason,
  mergeBountyObservation,
  isBountyClaimed,
  canClaimBounty,
  skipReasonForAutoJoin,
  skipReasonForClaim,
  skipReasonLabel,
  type BountyTelegramAlert,
  type PogoAccountEconomy,
  type PogoBounty,
  type PogoBountyPublicState,
  type PogoBountyView,
} from "../domain/pogo-bounty.ts";
import { getApiSessionTokenAsync, getApiSessionRevision } from "./api-session.ts";
import { notifyTelegram, queueBountyTelegram, flushBountyNotifications } from "./telegram-notify.ts";

const KEY = "xContentCreator.pogoBounties.v1";
export const POGO_BOUNTY_ALARM = "pogo-bounty-poll";

export type { PogoBountyPublicState };

interface Stored {
  accountKey: string | null;
  autoJoin: boolean;
  primed: boolean;
  scannedAt: number | null;
  error: string | null;
  hops: number | null;
  debtOwed: number;
  walletType: string | null;
  items: PogoBounty[];
}

const emptyStored = (): Stored => ({
  accountKey: null,
  autoJoin: false,
  primed: false,
  scannedAt: null,
  error: null,
  hops: null,
  debtOwed: 0,
  walletType: null,
  items: [],
});

let cache: Stored | null = null;
let syncing: Promise<PogoBountyPublicState> | null = null;
const claiming = new Map<string, Promise<PogoBounty>>();
let loading: Promise<Stored> | null = null;
let writes: Promise<unknown> = Promise.resolve();
let onEvent: ((level: "info" | "warn" | "error", message: string) => void) | null = null;

export function onPogoBountyEvent(cb: (level: "info" | "warn" | "error", message: string) => void): void {
  onEvent = cb;
}

export function resetPogoBountyStore(): void {
  cache = null;
  syncing = null;
  claiming.clear();
  loading = null;
}

function accountFrom(stored: Stored): PogoAccountEconomy {
  return { balance: stored.hops, debtOwed: stored.debtOwed, walletType: stored.walletType };
}

function toView(bounty: PogoBounty, stored: Stored): PogoBountyView {
  const skip = skipReasonForClaim(bounty);
  const autoSkip = skip ?? skipReasonForAutoJoin(bounty, accountFrom(stored));
  return {
    id: bounty.id,
    title: bounty.title,
    description: bounty.description,
    claimFee: bounty.claimFee,
    slotsLeft: bounty.slotsLeft,
    maxSlots: bounty.maxSlots,
    eligible: bounty.eligible,
    canJoin: skip == null,
    skipReason: skip,
    skipLabel: skipReasonLabel(stored.autoJoin ? autoSkip : skip),
    claimed: skip === "already_claimed",
    invited: bounty.invited,
    requiredTag: bounty.requiredTag,
    targetTweetUrl: bounty.targetTweetUrl,
    expiresAt: bounty.expiresAt,
    rewardPoints: bounty.rewardPoints,
    cryptoToken: bounty.cryptoToken,
    cryptoAmount: bounty.cryptoAmount,
    minPlacement: bounty.requirements.minPlacement,
    minFollowers: bounty.requirements.minFollowers,
    requiredWalletType: bounty.requiredWalletType,
    series: bounty.series
      ? { currentStep: bounty.series.currentStep, stepCount: bounty.series.stepCount, runState: bounty.series.runState }
      : null,
    lastJoin: bounty.lastJoin,
  };
}

function publicState(stored: Stored = cache ?? emptyStored()): PogoBountyPublicState {
  const items = stored.items.map((b) => toView(b, stored));
  return {
    autoJoin: stored.autoJoin,
    scannedAt: stored.scannedAt,
    error: stored.error,
    hops: stored.hops,
    joinableCount: items.filter((b) => b.canJoin).length,
    claimedCount: items.filter((b) => b.claimed).length,
    items,
  };
}

async function load(): Promise<Stored> {
  if (cache) return cache;
  if (!loading) loading = readStored().finally(() => { loading = null; });
  return loading;
}

async function readStored(): Promise<Stored> {
  if (cache) return cache;
  try {
    const raw = (await chrome.storage.local.get(KEY))[KEY];
    if (raw && typeof raw === "object") {
      const o = raw as Partial<Stored>;
      cache = {
        accountKey: typeof o.accountKey === "string" ? o.accountKey : null,
        autoJoin: o.autoJoin === true,
        primed: o.primed === true,
        scannedAt: typeof o.scannedAt === "number" ? o.scannedAt : null,
        error: typeof o.error === "string" ? o.error : null,
        hops: typeof o.hops === "number" && Number.isFinite(o.hops) ? o.hops : null,
        debtOwed: typeof o.debtOwed === "number" && Number.isFinite(o.debtOwed) ? Math.max(0, o.debtOwed) : 0,
        walletType: typeof o.walletType === "string" ? o.walletType : null,
        items: Array.isArray(o.items) ? o.items.filter((b): b is PogoBounty => !!b && typeof b === "object" && typeof b.id === "number") : [],
      };
      return cache;
    }
  } catch {
    /* Memory fallback. */
  }
  cache = emptyStored();
  return cache;
}

async function save(next: Stored): Promise<void> {
  cache = next;
  try {
    await chrome.storage.local.set({ [KEY]: next });
  } catch {
    /* Memory fallback. */
  }
  broadcast();
}

// Every patch reads the latest state, including changes made during network requests.
function update(patch: (latest: Stored) => Stored): Promise<void> {
  const run = writes.then(async () => {
    const latest = await load();
    const next = patch(latest);
    if (next !== latest) await save(next);
  });
  writes = run.catch(() => {});
  return run;
}

// Partition local receipts by JWT subject, retaining them across token renewal.
// This is a cache key only, never authentication. Opaque tokens use their digest.
async function accountKey(token: string): Promise<string> {
  let identity = token;
  try {
    const body = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof body.sub === "string" || typeof body.sub === "number") {
      identity = JSON.stringify([body.iss ?? "", body.sub]);
    }
  } catch { /* Opaque token. */ }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function session() {
  const token = await getApiSessionTokenAsync();
  const revision = getApiSessionRevision();
  if (!token) return null;
  const key = await accountKey(token);
  if (revision !== getApiSessionRevision()) return null;
  await update(latest => revision !== getApiSessionRevision() || latest.accountKey === key ? latest
    : { ...emptyStored(), autoJoin: latest.autoJoin, accountKey: key });
  return { token, key, valid: () => revision === getApiSessionRevision() && cache?.accountKey === key };
}

function broadcast(): void {
  try {
    void chrome.runtime.sendMessage({ type: "pogo_bounties", bounties: publicState() }).catch(() => {});
  } catch {
    /* Sidepanel may be closed. */
  }
}

async function ownHandle(): Promise<string | undefined> {
  try {
    const raw = (await chrome.storage.local.get("xContentCreator.agentSettings.v1"))["xContentCreator.agentSettings.v1"];
    const handle = raw && typeof raw === "object" ? (raw as { ownHandle?: unknown }).ownHandle : null;
    return typeof handle === "string" && handle.trim() ? handle.replace(/^@/, "") : undefined;
  } catch {
    return undefined;
  }
}

async function emitTelegram(alerts: BountyTelegramAlert[], scope: string): Promise<void> {
  if (!alerts.length) return;
  const account = await ownHandle();
  // Queue and initiate delivery, never wait for the bot/network response.
  for (const bounty of alerts) await queueBountyTelegram({ account, bounty, scope });
}

export async function getPogoBountyPublicState(): Promise<PogoBountyPublicState> {
  return publicState(await load());
}

export async function setPogoBountyAutoJoin(enabled: boolean): Promise<PogoBountyPublicState> {
  await update(latest => ({ ...latest, autoJoin: enabled }));
  if (enabled) return syncPogoBounties({ autoJoin: true });
  return publicState();
}

function applyClaimLocal(bounty: PogoBounty, status: string, at: number): PogoBounty {
  return {
    ...bounty,
    myClaimStatus: status,
    slotsLeft: Math.max(0, bounty.slotsLeft - 1),
    series: bounty.series ? { ...bounty.series, runState: "joined", joinOpen: false } : null,
    lastJoin: { at, ok: true },
  };
}

async function claimOne(ctx: NonNullable<Awaited<ReturnType<typeof session>>>, bounty: PogoBounty, source: "auto" | "manual"): Promise<PogoBounty> {
  const key = `${ctx.key}:${bounty.id}`;
  const pending = claiming.get(key);
  if (pending) return pending;
  const run = performClaim(ctx, bounty, source).finally(() => {
    if (claiming.get(key) === run) claiming.delete(key);
  });
  claiming.set(key, run);
  return run;
}

async function performClaim(ctx: NonNullable<Awaited<ReturnType<typeof session>>>, bounty: PogoBounty, source: "auto" | "manual"): Promise<PogoBounty> {
  const at = Date.now();
  if (!ctx.valid() || (source === "auto" && !cache?.autoJoin)) return bounty;
  // A worker termination after POST must not cause an automatic duplicate claim.
  await update(latest => !ctx.valid() ? latest : {
    ...latest, items: latest.items.map(item => item.id === bounty.id
      ? { ...item, lastJoin: { at, ok: false, error: "join_uncertain" } } : item),
  });
  if (!ctx.valid() || (source === "auto" && !cache?.autoJoin)) {
    await update(latest => !ctx.valid() ? latest : { ...latest,
      items: latest.items.map(item => item.id === bounty.id ? bounty : item) });
    return bounty;
  }
  const result = await claimPogoBounty(ctx.token, bounty.id);
  if (!ctx.valid()) return bounty;
  let updated: PogoBounty;
  if (result.ok || result.code === "already_claimed") {
    onEvent?.("info", source === "auto"
      ? `Đã tự join bounty #${bounty.id}: ${bounty.title}`
      : `Đã join bounty #${bounty.id}: ${bounty.title}`);
    updated = applyClaimLocal(bounty, result.ok ? result.status : "claimed", at);
    await emitTelegram([bountyAlert(updated, "joined")], ctx.key);
  } else {
    const uncertain = result.httpStatus == null || result.httpStatus >= 500 || result.code === "claim_response_uncertain";
    const error = uncertain ? "join_uncertain" : result.code || result.error;
    onEvent?.(result.login_required ? "error" : "warn", `Join bounty #${bounty.id}: ${error}`);
    updated = { ...bounty, lastJoin: { at, ok: false, error } };
    await emitTelegram([bountyAlert(updated, uncertain ? "uncertain" : "failed",
      result.login_required ? "session_expired" : result.httpStatus == null ? "network_error" : bountyTelegramReason(result.code))], ctx.key);
  }
  await update(latest => !ctx.valid() ? latest : {
    ...latest,
    error: updated.lastJoin?.ok ? null : updated.lastJoin?.error ?? null,
    items: latest.items.map(item => item.id === updated.id ? updated : item),
  });
  return updated;
}

export async function syncPogoBounties(opts: { autoJoin?: boolean } = {}): Promise<PogoBountyPublicState> {
  if (syncing) return syncing;
  const run = (async () => {
    const ctx = await session();
    if (!ctx) {
      await update(latest => ({ ...latest, error: "Chưa có phiên Pogo." }));
      if (cache?.autoJoin) void notifyTelegram("pogo_auth_error");
      return publicState();
    }
    const stored = await load();
    const list = await fetchPogoBounties(ctx.token, stored.items);
    if (!ctx.valid()) return publicState();
    if (!list.ok) {
      await update(latest => !ctx.valid() ? latest : ({ ...latest, error: list.login_required ? "Phiên Pogo hết hạn." : list.error }));
      void notifyTelegram("pogo_bounty_error", { status: list.login_required ? "session_expired" : "fetch_failed" });
      return publicState();
    }

    // Announce discoveries before economy checks or claims. Bot delivery is independent.
    // Merge with the latest receipts: a manual claim may finish during the list fetch.
    const observedItems = (latest: Stored) => list.bounties.map(item => {
        const previous = latest.items.find(old => old.id === item.id);
        const merged = mergeBountyObservation(item, previous);
        return isBountyClaimed(item) && previous?.lastJoin?.error === "join_uncertain"
          ? { ...merged, lastJoin: { at: Date.now(), ok: true } } : merged;
    });
    const discovery = bountyTelegramAlerts(stored.items, observedItems(await load()), {
      primed: stored.primed, autoJoin: false, account: accountFrom(cache!),
    }).filter(alert => alert.kind !== "failed");
    // Save the notice before advancing the baseline, so a worker restart cannot
    // permanently skip a discovery between the two storage writes.
    await emitTelegram(discovery, ctx.key);
    if (!ctx.valid()) return publicState();
    await update(latest => !ctx.valid() ? latest : {
      ...latest, items: observedItems(latest),
      scannedAt: Date.now(), error: null, primed: true,
    });
    const items = cache!.items;

    const wantsAuto = () => opts.autoJoin !== false && cache?.autoJoin === true && ctx.valid();
    if (wantsAuto()) {
      let economy: Awaited<ReturnType<typeof fetchPogoMeEconomy>> | null = null;
      // Free bounties without wallet requirements can join immediately.
      // Process these first, so /api/me cannot delay them behind a paid bounty.
      const ordered = [...items].sort((a, b) => Number(a.claimFee > 0 || !!a.requiredWalletType) - Number(b.claimFee > 0 || !!b.requiredWalletType));
      for (const observed of ordered) {
        if (!wantsAuto()) break;
        const bounty = cache!.items.find(item => item.id === observed.id)!;
        if (!canClaimBounty(bounty) || bounty.lastJoin?.ok) continue;
        // An ambiguous POST is reconciled from the next authoritative list, never blindly retried.
        if (bounty.lastJoin?.error === "join_uncertain") continue;
        if (bounty.claimFee > 0 || bounty.requiredWalletType) {
          if (!economy) economy = await fetchPogoMeEconomy(ctx.token);
          if (!wantsAuto()) break;
          if (!economy.ok) {
            await emitTelegram([bountyAlert(bounty, "blocked", economy.login_required ? "session_expired" : "service_error")], ctx.key);
            continue;
          }
          const skip = skipReasonForAutoJoin(bounty, economy.account);
          if (skip) {
            await emitTelegram([bountyAlert(bounty, "blocked", skip)], ctx.key);
            continue;
          }
        }
        const updated = await claimOne(ctx, bounty, "auto");
        if (economy?.ok && updated.lastJoin?.ok && bounty.claimFee > 0 && economy.account.balance != null) {
          economy.account.balance = Math.max(0, economy.account.balance - bounty.claimFee);
        }
      }
      if (economy?.ok && ctx.valid()) {
        const account = economy.account;
        await update(latest => !ctx.valid() ? latest : ({ ...latest, hops: account.balance, debtOwed: account.debtOwed, walletType: account.walletType }));
      }
    }
    return publicState();
  })().finally(() => {
    if (syncing === run) syncing = null;
  });
  syncing = run;
  return run;
}

/** Demand-feed: chỉ gọi mạng khi đang bật tự join. */
export async function maybeAutoJoinPogoBounties(): Promise<void> {
  const stored = await load();
  if (!stored.autoJoin) return;
  await syncPogoBounties({ autoJoin: true });
}

/** Chrome 120+: quét bounty mỗi 30 giây, độc lập với Agent. */
export async function pollPogoBounties(): Promise<void> {
  await flushBountyNotifications();
  if (!await getApiSessionTokenAsync()) {
    if ((await load()).autoJoin) void notifyTelegram("pogo_auth_error");
    return;
  }
  await syncPogoBounties();
}

export async function ensurePogoBountyAlarm(): Promise<void> {
  try {
    const alarm = await chrome.alarms.get(POGO_BOUNTY_ALARM);
    if (alarm?.periodInMinutes !== 0.5) {
      await chrome.alarms.create(POGO_BOUNTY_ALARM, { periodInMinutes: 0.5 });
    }
  } catch {
    /* Tests without chrome.alarms. */
  }
}

export async function claimPogoBountyById(id: number): Promise<PogoBountyPublicState> {
  const ctx = await session();
  if (!ctx) {
    await update(latest => ({ ...latest, error: "Chưa có phiên Pogo." }));
    return publicState();
  }
  const stored = await load();
  const pending = claiming.get(`${ctx.key}:${id}`);
  if (pending) {
    await pending;
    return publicState();
  }
  const current = stored.items.find(item => item.id === id);
  if (!current || !canClaimBounty(current) || current.lastJoin?.error === "join_uncertain") {
    await update(latest => !ctx.valid() ? latest : ({ ...latest, error: !current ? "Không thấy bounty này. Quét lại danh sách."
      : current.lastJoin?.error === "join_uncertain" ? "Chưa rõ kết quả join. Mở Pogo kiểm tra trước khi thử lại."
      : skipReasonLabel(skipReasonForClaim(current)) || "Không join được bounty này." }));
    return publicState();
  }
  await claimOne(ctx, current, "manual");
  return publicState();
}
