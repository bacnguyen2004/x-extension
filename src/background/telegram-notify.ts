import type { AgentDailyStats } from "../domain/agent-settings.ts";
import { todayKey } from "../domain/agent-settings.ts";
import type { BountyTelegramAlert, BountyTelegramReason } from "../domain/pogo-bounty.ts";

export const TELEGRAM_SUMMARY_ALARM = "telegram-hourly-summary";
const KEY = "xContentCreator.telegramNotify.v1";
type Event = "agent_started" | "agent_stopped" | "agent_error" | "pogo_auth_error" | "pogo_bounty_error" | "hourly_summary" | "daily_target_reached" | "pogo_bounty";
const pending = new Set<string>();
const BOUNTY_REASONS = new Set<BountyTelegramReason>([
  "placement", "followers", "followers_unknown", "ineligible", "no_slots",
  "already_claimed", "join_closed", "expired", "not_enough_hops", "in_debt",
  "wallet_required", "join_failed", "session_expired", "network_error", "service_error",
]);
const BOUNTY_KINDS = new Set(["new", "joined", "blocked", "failed", "uncertain"]);

const BOUNTY_QUEUE_KEY = "xContentCreator.bountyNotifications.v1";
interface BountyNotice {
  key: string;
  account: string;
  bounty: BountyTelegramAlert;
  at: number;
  nextAt: number;
  delivered: boolean;
}
let queueWrites: Promise<unknown> = Promise.resolve();
const delivering = new Set<string>();

function updateNotices<T>(work: (notices: BountyNotice[]) => Promise<T>): Promise<T> {
  const run = queueWrites.then(async () => {
    const raw = (await chrome.storage.local.get(BOUNTY_QUEUE_KEY))[BOUNTY_QUEUE_KEY];
    return work(Array.isArray(raw) ? raw.filter(n => n && typeof n.key === "string" && sanitizeBounty(n.bounty)) : []);
  });
  queueWrites = run.catch(() => {});
  return run;
}

/** Persist then start the native send; never wait for Telegram before joining. */
export async function queueBountyTelegram(data: { account?: string; bounty: BountyTelegramAlert; scope?: string }): Promise<void> {
  const bounty = sanitizeBounty(data.bounty);
  if (!bounty) return;
  const account = (data.account || "").replace(/^@/, "");
  const key = `${data.scope ?? account}:${bounty.kind}:${bounty.id}:${bounty.reason ?? ""}`;
  try {
    const notice = await updateNotices(async notices => {
      const now = Date.now();
      const recent = notices.filter(n => now - n.at < 86400000);
      const existing = recent.find(n => n.key === key);
      if (existing) return existing;
      const entry: BountyNotice = { key, account, bounty, at: now, nextAt: now, delivered: false };
      await chrome.storage.local.set({ [BOUNTY_QUEUE_KEY]: [...recent, entry] });
      return entry;
    });
    startDelivery(notice);
  } catch {
    // Storage failure must not prevent either the first send or Auto Join.
    try { void Promise.resolve(chrome.runtime.sendNativeMessage("com.xcontentcreator.pogo_auth", { action: "notify", event: "pogo_bounty", account, bounty })).catch(() => {}); } catch {}
  }
}

function startDelivery(notice: BountyNotice): void {
  if (notice.delivered || notice.nextAt > Date.now() || delivering.has(notice.key)) return;
  delivering.add(notice.key);
  // Invoke synchronously here so discovery delivery starts before the claim POST.
  let send: Promise<unknown>;
  try {
    send = Promise.resolve(chrome.runtime.sendNativeMessage("com.xcontentcreator.pogo_auth", {
      action: "notify", event: "pogo_bounty", account: notice.account, bounty: notice.bounty, at: notice.at,
    }));
  } catch { send = Promise.resolve({ ok: false }); }
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        send.catch(() => ({ ok: false })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false }), 20000); }),
      ]) as { ok?: boolean; skipped?: boolean } | undefined;
      await updateNotices(async notices => {
        const next = notices.map(n => n.key === notice.key ? {
          ...n, delivered: result?.ok === true && result.skipped !== true, nextAt: Date.now() + 30000,
        } : n);
        await chrome.storage.local.set({ [BOUNTY_QUEUE_KEY]: next });
      });
    } catch { /* Leave the persisted notice for the next poll. */ }
    finally { if (timer) clearTimeout(timer); delivering.delete(notice.key); }
  })();
}

export async function flushBountyNotifications(): Promise<void> {
  try {
    const notices = await updateNotices(async notices => notices);
    for (const notice of notices) if (Date.now() - notice.at < 86400000) startDelivery(notice);
  } catch { /* Bot retries are independent of bounty polling. */ }
}

function sanitizeBounty(raw: BountyTelegramAlert | undefined): BountyTelegramAlert | null {
  if (!raw || !Number.isInteger(raw.id) || raw.id <= 0 || raw.id > 100000000) return null;
  if (!BOUNTY_KINDS.has(raw.kind)) return null;
  const reason = raw.reason && BOUNTY_REASONS.has(raw.reason) ? raw.reason : undefined;
  const fee = Number.isInteger(raw.fee) && raw.fee >= 0 && raw.fee <= 100000000 ? raw.fee : 0;
  const slots = Number.isInteger(raw.slots) && raw.slots >= 0 && raw.slots <= 100000000 ? raw.slots : 0;
  return {
    kind: raw.kind,
    id: raw.id,
    title: String(raw.title || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 80),
    fee,
    slots,
    ...(reason ? { reason } : {}),
  };
}

function notifyKey(event: Event, account: string): string {
  return `${event}:${account}${event === "daily_target_reached" ? `:${todayKey()}` : ""}`;
}

function cooldownMs(event: Event): number {
  if (event === "daily_target_reached") return 86400000;
  if (event === "hourly_summary") return 3600000;
  return 900000;
}

/** Notification failures must never stop the agent. Never forward logs or tokens. */
export async function notifyTelegram(event: Event, data: {
  account?: string;
  stats?: AgentDailyStats;
  status?: string;
  bounty?: BountyTelegramAlert;
} = {}): Promise<void> {
  if (event === "pogo_bounty") {
    if (data.bounty) await queueBountyTelegram({ account: data.account, bounty: data.bounty });
    return;
  }
  const account = (data.account || "").replace(/^@/, "");
  const key = notifyKey(event, account);
  if (pending.has(key)) return;
  pending.add(key);
  try {
    const raw = (await chrome.storage.local.get(KEY))[KEY];
    const sent = raw && typeof raw === "object" ? raw as Record<string, number> : {};
    const now = Date.now();
    if (typeof sent[key] === "number" && now - sent[key] < cooldownMs(event)) return;
    // Persist before sending to bound retries even after worker restarts.
    const recent = Object.fromEntries(Object.entries(sent).filter(([, at]) => typeof at === "number" && now - at < 86400000));
    await chrome.storage.local.set({ [KEY]: { ...recent, [key]: now } });
    const stats = data.stats ? Object.fromEntries(["reply", "follow", "retweet", "like", "quote"].map(k => [k, data.stats![k as keyof AgentDailyStats]])) : undefined;
    const payload: Record<string, unknown> = { action: "notify", event, account, status: data.status, stats };
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 20000);
      Promise.resolve().then(() => chrome.runtime.sendNativeMessage("com.xcontentcreator.pogo_auth", payload))
        .then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
  } catch { /* Notifications are best effort. */ }
  finally { pending.delete(key); }
}
