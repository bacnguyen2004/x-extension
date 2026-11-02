/** Đọc / cập nhật campaigns Pogo đã cache trong storage (không phụ thuộc UI). */

import {
  createInitialState,
  type ActionKind,
  type Campaign,
  type PersistedState,
  type ScanSnapshot,
} from "../domain/types.ts";
import { applyScan, campaignList } from "../domain/merge.ts";
import { syncPogoFeedMeta } from "./pogo-feed-meta.ts";

const STORAGE_KEY = "pogoTaskReader.state";

/** SW đăng ký để đồng bộ memory + broadcast UI sau khi agent đánh dấu done. */
let onPatched: ((state: PersistedState) => void) | null = null;
/** SW đăng ký refresh chip RW / settlement sau feed API. */
let onFeedMeta: (() => void) | null = null;

export function onPogoStatePatched(cb: (state: PersistedState) => void): void {
  onPatched = cb;
}

export function onPogoFeedMetaSynced(cb: () => void): void {
  onFeedMeta = cb;
}

async function loadPersisted(): Promise<PersistedState | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const saved = raw[STORAGE_KEY];
  if (!saved || typeof saved !== "object") return null;
  return { ...createInitialState(), ...(saved as PersistedState) };
}

export async function loadPogoCampaigns(): Promise<Campaign[]> {
  const state = await loadPersisted();
  if (!state) return [];
  let changed = false;
  for (const c of Object.values(state.campaigns || {})) {
    // Older builds marked this pre-submit failure as an attempted reply.
    if (c.actions.reply.local?.error === "reply_identity_missing" && c.actions.reply.local.state === "uncertain") {
      delete c.actions.reply.local;
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    onPatched?.(state);
  }
  return campaignList(state);
}

export async function pogoSessionRequiresLogin(): Promise<boolean> {
  return (await loadPersisted())?.login_required === true;
}

/** Merge against the latest disk state so a refresh retains completed actions. */
export async function applyPogoFeedRefresh(snapshot: ScanSnapshot): Promise<Campaign[]> {
  const latest = await loadPersisted() ?? createInitialState();
  const next = { ...applyScan(latest, snapshot), login_required: false, api_last_error: null, api_http_status: 200 };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  onPatched?.(next);
  await syncPogoFeedMeta(snapshot, { publish: () => onFeedMeta?.() });
  return campaignList(next);
}

export async function reportPogoFeedError(loginRequired: boolean, httpStatus: number | null): Promise<void> {
  const latest = await loadPersisted() ?? createInitialState();
  const next = { ...latest, login_required: loginRequired, api_http_status: httpStatus,
    api_last_error: loginRequired ? "Phiên API Pogo hết hạn. Dán Bearer token mới ở tab Nguồn rồi Quét lại; hàng đợi được giữ." : "Không tải được task Pogo. Tool sẽ thử lại sau." };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  onPatched?.(next);
}

/** Đánh dấu đã follow trên cache Pogo để planner không chọn lại. */
export async function markPogoAlreadyFollowing(
  tweetId: string,
  authorHandle: string | null,
): Promise<void> {
  await markPogoProgress(tweetId, authorHandle, { follow: true });
}

export type PogoProgressPatch = {
  follow?: boolean;
  reply?: boolean;
  retweet?: boolean;
  quote?: boolean;
  localState?: NonNullable<Campaign["actions"]["reply"]["local"]>["state"];
  error?: string;
};

/** Sau engage thành công — cập nhật cache để không làm lại cùng action. */
export async function markPogoProgress(
  tweetId: string,
  authorHandle: string | null,
  patch: PogoProgressPatch,
): Promise<void> {
  const state = await loadPersisted();
  if (!state) return;
  const campaigns = { ...(state.campaigns || {}) };
  let changed = false;
  const handle = authorHandle?.replace(/^@/, "").toLowerCase() || null;

  for (const [id, c] of Object.entries(campaigns)) {
    const sameTweet = c.tweet_id === tweetId;
    const sameAuthor =
      handle != null && (c.author_handle || "").replace(/^@/, "").toLowerCase() === handle;
    if (!sameTweet && !(patch.follow && sameAuthor)) continue;

    let next = c;
    if (patch.follow && (sameTweet || sameAuthor)) {
      if (next.follows_author !== true) {
        next = { ...next, follows_author: true };
        changed = true;
      }
    }
    if (sameTweet) {
      for (const kind of ["reply", "retweet", "quote"] as ActionKind[]) {
        if (!patch[kind]) continue;
        if (next.actions[kind].status === "recorded") continue;
        if (next.actions[kind].local?.state === "confirmed" && (!patch.localState || patch.localState === "submitted")) continue;
        next = {
          ...next,
          actions: {
            ...next.actions,
            [kind]: { ...next.actions[kind], local: {
              state: patch.localState ?? "submitted", at: Date.now(), ...(patch.error ? { error: patch.error } : {}),
            } },
          },
        };
        changed = true;
      }
    }
    if (next !== c) campaigns[id] = next;
  }

  if (!changed) return;
  const nextState: PersistedState = { ...state, campaigns };
  await chrome.storage.local.set({
    [STORAGE_KEY]: nextState,
  });
  onPatched?.(nextState);
}
