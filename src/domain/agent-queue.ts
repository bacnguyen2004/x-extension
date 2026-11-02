/** Hàng đợi hành động Agent (Phase 2–3). */

import type { BrowseSurface } from "./agent-settings.ts";
import { sanitizeOwnerPost, type OwnerPost } from "./reply-conversation.ts";

export type AgentJobKind =
  | "scroll_home"
  | "like"
  | "retweet"
  | "follow"
  | "draft_reply"
  | "draft_quote"
  | "post_reply"
  | "post_quote";

export type AgentJobStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface AgentJob {
  id: string;
  kind: AgentJobKind;
  status: AgentJobStatus;
  createdAt: number;
  updatedAt: number;
  tweetId: string | null;
  authorHandle: string | null;
  tweetUrl: string | null;
  tweetText: string | null;
  draftText: string | null;
  error: string | null;
  source: "pogo" | "browse" | "manual";
  /** Why this job was selected, shown in the queue and activity log. */
  reason?: string;
  /** Browse feed surface (Home / Following / Lists / Mentions). */
  browseSurface?: BrowseSurface;
  notificationKind?: "direct" | "post";
  notificationBatchId?: string;
  autoPost?: boolean;
  parentText?: string;
  ownerPost?: OwnerPost;
  conversationContext?: string;
  expectedAccount?: string;
  authorFollow?: boolean;
  postFollow?: boolean;
  /** Only for standalone Home likes; never navigate to a status page. */
  likeOnFeed?: boolean;
  verification?: "submitted" | "x_confirmed" | "pogo_recorded" | "uncertain" | "blocked";
  pogoUnlock?: { state: "pending" | "unlocked" | "exhausted"; attempts: number; nextCheckAt: number };
  pogoVerify?: { attempts: number; nextCheckAt: number; submittedAt?: number };
}

export interface AgentQueueState {
  jobs: AgentJob[];
}

export function createEmptyQueue(): AgentQueueState {
  return { jobs: [] };
}

let jobSequence = 0;
export function newJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${(jobSequence++).toString(36)}`;
}

const BROWSE_SURFACES = new Set<BrowseSurface>(["home", "following", "lists", "mentions"]);

export function makeJob(
  partial: Omit<AgentJob, "id" | "createdAt" | "updatedAt" | "status" | "error" | "draftText"> & {
    status?: AgentJobStatus;
    draftText?: string | null;
    error?: string | null;
  },
): AgentJob {
  const now = Date.now();
  return {
    id: newJobId(),
    status: partial.status ?? "pending",
    createdAt: now,
    updatedAt: now,
    draftText: partial.draftText ?? null,
    error: partial.error ?? null,
    kind: partial.kind,
    tweetId: partial.tweetId,
    authorHandle: partial.authorHandle,
    tweetUrl: partial.tweetUrl,
    tweetText: partial.tweetText,
    source: partial.source,
    ...(partial.notificationKind ? { notificationKind: partial.notificationKind } : {}),
    ...(partial.notificationBatchId ? { notificationBatchId: partial.notificationBatchId } : {}),
    ...(partial.autoPost ? { autoPost: true } : {}),
    ...(partial.parentText != null ? { parentText: partial.parentText.slice(0, 4000) } : {}),
    ...(sanitizeOwnerPost(partial.ownerPost) ? { ownerPost: sanitizeOwnerPost(partial.ownerPost) } : {}),
    ...(partial.conversationContext != null ? { conversationContext: partial.conversationContext.slice(0, 6000) } : {}),
    ...(partial.expectedAccount ? { expectedAccount: partial.expectedAccount } : {}),
    ...(partial.authorFollow ? { authorFollow: true } : {}),
    ...(partial.postFollow ? { postFollow: true } : {}),
    ...(partial.reason ? { reason: partial.reason } : {}),
    ...(partial.browseSurface && BROWSE_SURFACES.has(partial.browseSurface)
      ? { browseSurface: partial.browseSurface }
      : {}),
    ...(partial.kind === "like" && partial.source === "browse" && partial.likeOnFeed ? { likeOnFeed: true } : {}),
    ...(partial.verification ? { verification: partial.verification } : {}),
    ...(partial.pogoUnlock ? { pogoUnlock: partial.pogoUnlock } : {}),
    ...(partial.pogoVerify ? { pogoVerify: partial.pogoVerify } : {}),
  };
}

export function sanitizeQueue(raw: unknown): AgentQueueState {
  if (!raw || typeof raw !== "object") return createEmptyQueue();
  const jobsRaw = (raw as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobsRaw)) return createEmptyQueue();
  const jobs: AgentJob[] = [];
  for (const item of jobsRaw.slice(0, 300)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o.kind;
    if (
      kind !== "scroll_home" &&
      kind !== "like" &&
      kind !== "retweet" &&
      kind !== "follow" &&
      kind !== "draft_reply" &&
      kind !== "draft_quote" &&
      kind !== "post_reply" &&
      kind !== "post_quote"
    ) {
      continue;
    }
    jobs.push({
      id: typeof o.id === "string" ? o.id : newJobId(),
      kind,
      status:
        o.status === "running" ||
        o.status === "done" ||
        o.status === "failed" ||
        o.status === "skipped" ||
        o.status === "pending"
          ? o.status
          : "pending",
      createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
      updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
      tweetId: typeof o.tweetId === "string" ? o.tweetId : null,
      authorHandle: typeof o.authorHandle === "string" ? o.authorHandle : null,
      tweetUrl: typeof o.tweetUrl === "string" ? o.tweetUrl : null,
      tweetText: typeof o.tweetText === "string" ? o.tweetText.slice(0, 32000) : null,
      draftText: typeof o.draftText === "string" ? o.draftText.slice(0, 4000) : null,
      error: typeof o.error === "string" ? o.error.slice(0, 500) : null,
      source: o.source === "browse" || o.source === "manual" || o.source === "pogo" ? o.source : "pogo",
      ...(o.autoPost === true ? { autoPost: true } : {}),
      ...(typeof o.parentText === "string" ? { parentText: o.parentText.slice(0, 4000) } : {}),
      ...(o.notificationKind === "direct" || o.notificationKind === "post" ? { notificationKind: o.notificationKind } : {}),
      ...(typeof o.notificationBatchId === "string" ? { notificationBatchId: o.notificationBatchId.slice(0, 100) } : {}),
      ...(sanitizeOwnerPost(o.ownerPost) ? { ownerPost: sanitizeOwnerPost(o.ownerPost) } : {}),
      ...(typeof o.conversationContext === "string" ? { conversationContext: o.conversationContext.slice(0, 6000) } : {}),
      ...(typeof o.expectedAccount === "string" && /^@?[A-Za-z0-9_]{1,15}$/.test(o.expectedAccount) ? { expectedAccount: o.expectedAccount } : {}),
      ...(o.authorFollow === true ? { authorFollow: true } : {}),
      ...(o.postFollow === true ? { postFollow: true } : {}),
      ...(typeof o.reason === "string" ? { reason: o.reason.slice(0, 300).replace(/chờ duyệt/gi, "tự đăng sau khi soạn").replace(/đã được duyệt/gi, "tự động") } : {}),
      ...(typeof o.browseSurface === "string" && BROWSE_SURFACES.has(o.browseSurface as BrowseSurface)
        ? { browseSurface: o.browseSurface as BrowseSurface }
        : {}),
      ...(kind === "like" && o.source === "browse" && o.likeOnFeed === true ? { likeOnFeed: true } : {}),
      ...(["submitted", "x_confirmed", "pogo_recorded", "uncertain", "blocked"].includes(String(o.verification))
        ? { verification: o.verification as AgentJob["verification"] } : {}),
      ...(sanitizeUnlock(o.pogoUnlock) ? { pogoUnlock: sanitizeUnlock(o.pogoUnlock)! } : {}),
      ...(o.pogoVerify && typeof o.pogoVerify === "object" ? { pogoVerify: sanitizeVerify(o.pogoVerify) } : {}),
    });
  }
  return { jobs };
}

function sanitizeUnlock(raw: unknown): AgentJob["pogoUnlock"] {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (o.state !== "pending" && o.state !== "unlocked" && o.state !== "exhausted") return undefined;
  return { state: o.state, attempts: typeof o.attempts === "number" && Number.isFinite(o.attempts) ? Math.min(3, Math.max(0, Math.floor(o.attempts))) : 0,
    nextCheckAt: typeof o.nextCheckAt === "number" && Number.isFinite(o.nextCheckAt) ? Math.max(0, o.nextCheckAt) : 0 };
}

function sanitizeVerify(raw: object): NonNullable<AgentJob["pogoVerify"]> {
  const o = raw as Record<string, unknown>;
  return { attempts: typeof o.attempts === "number" && Number.isFinite(o.attempts) ? Math.min(100000, Math.max(0, Math.floor(o.attempts))) : 0,
    nextCheckAt: typeof o.nextCheckAt === "number" && Number.isFinite(o.nextCheckAt) ? Math.max(0, o.nextCheckAt) : 0,
    ...(typeof o.submittedAt === "number" && Number.isFinite(o.submittedAt) ? { submittedAt: o.submittedAt } : {}) };
}

export function upsertJob(queue: AgentQueueState, job: AgentJob): AgentQueueState {
  const rest = queue.jobs.filter((j) => j.id !== job.id);
  const all = [job, ...rest];
  return { jobs: all.slice(0, 300) };
}

export function markJob(
  queue: AgentQueueState,
  id: string,
  patch: Partial<Pick<AgentJob, "status" | "draftText" | "error" | "verification" | "pogoUnlock" | "pogoVerify">>,
): AgentQueueState {
  return {
    jobs: queue.jobs.map((j) =>
      j.id === id ? { ...j, ...patch, updatedAt: Date.now() } : j,
    ),
  };
}

/** Cancel Pogo work that is not currently eligible for points. Keep completed history. */
export function pruneLockedPogoJobs(queue: AgentQueueState, tweetIds: Iterable<string>, allowFollow = false): { queue: AgentQueueState; skipped: number } {
  const locked = new Set(tweetIds);
  let skipped = 0;
  const jobs = queue.jobs.map((job) => {
    if (job.source !== "pogo" || !job.tweetId || !locked.has(job.tweetId)) return job;
    if (allowFollow && job.kind === "follow") return job;
    if (job.status !== "pending" && job.status !== "running") return job;
    skipped++;
    return { ...job, status: "skipped" as const, error: "campaign_locked", updatedAt: Date.now() };
  });
  return { queue: { jobs }, skipped };
}

/** Behavior tắt action → job kind đó bị disable. */
export function jobKindDisabledByActions(
  kind: AgentJobKind,
  actions: { like: boolean; retweet: boolean; follow: boolean; reply: boolean; quote: boolean },
): boolean {
  if (kind === "like") return !actions.like;
  if (kind === "retweet") return !actions.retweet;
  if (kind === "follow") return !actions.follow;
  if (kind === "draft_reply" || kind === "post_reply") return !actions.reply;
  if (kind === "draft_quote" || kind === "post_quote") return !actions.quote;
  return false;
}

/**
 * Bỏ pending/running khi Behavior tắt action.
 * Like lẻ (không kèm reply) cũng bỏ — Like chỉ đi kèm Reply.
 */
export function pruneDisabledActionJobs(
  queue: AgentQueueState,
  actions: { like: boolean; retweet: boolean; follow: boolean; reply: boolean; quote: boolean },
): { queue: AgentQueueState; skipped: number } {
  let skipped = 0;
  let jobs = queue.jobs;
  for (const j of queue.jobs) {
    if (j.status !== "pending" && j.status !== "running") continue;
    let reason: string | null = null;
    if (jobKindDisabledByActions(j.kind, actions)) {
      reason = "action_disabled";
    } else if (j.kind === "like" && j.source !== "browse") {
      // Like Pogo/manual: chỉ giữ khi cùng tweet còn reply đang chờ/chạy.
      // Like browse được đứng một mình (humanize likePct).
      const replyBuddy = j.tweetId
        ? jobs.some(
            (o) =>
              o.tweetId === j.tweetId &&
              (o.kind === "draft_reply" || o.kind === "post_reply") &&
              (o.status === "pending" || o.status === "running"),
          )
        : false;
      if (!replyBuddy) reason = "like_not_a_task";
    }
    if (!reason) continue;
    jobs = jobs.map((x) =>
      x.id === j.id ? { ...x, status: "skipped" as const, error: reason, updatedAt: Date.now() } : x,
    );
    skipped += 1;
  }
  return { queue: { jobs }, skipped };
}

/**
 * Pogo đã recorded reply → bỏ Soạn/Reply/Like kèm của tweet đó (tránh 3 job treo như ảnh).
 */
export function pruneJobsForRecordedReplies(
  queue: AgentQueueState,
  recordedTweetIds: Iterable<string>,
  reason = "reply_already_recorded",
  verification: AgentJob["verification"] = "pogo_recorded",
): { queue: AgentQueueState; skipped: number } {
  const done = new Set(recordedTweetIds);
  if (!done.size) return { queue, skipped: 0 };
  let skipped = 0;
  const jobs = queue.jobs.map((j) => {
    if (j.source !== "pogo") return j;
    if (j.status !== "pending" && j.status !== "running") return j;
    if (!j.tweetId || !done.has(j.tweetId)) return j;
    if (j.kind !== "draft_reply" && j.kind !== "post_reply" && j.kind !== "like") return j;
    skipped += 1;
    return {
      ...j,
      status: "skipped" as const,
      error: reason,
      verification,
      updatedAt: Date.now(),
    };
  });
  return { queue: { jobs }, skipped };
}

/** Draft sẵn để đăng. */
export function findReadyDraft(
  queue: AgentQueueState,
  kind: "draft_reply" | "draft_quote",
): AgentJob | null {
  const postKind = kind === "draft_reply" ? "post_reply" : "post_quote";
  // Draft done còn text, chưa có post tương ứng (done/pending/running/skipped).
  // skipped = đã thử (reply_restricted / too_old…) — không tạo post lại mãi.
  for (const j of queue.jobs) {
    if (j.postFollow || j.kind !== kind || j.status !== "done" || !j.draftText || !j.tweetId) continue;
    // Không dùng draft là chữ SKIP.
    if (/^SKIP\.?$/i.test(j.draftText.trim())) continue;
    const already = queue.jobs.some((p) => {
      if (p.kind !== postKind || p.tweetId !== j.tweetId) return false;
      if (p.status === "skipped" && p.error === "campaign_locked") return false;
      if (
        p.status === "done" ||
        p.status === "running" ||
        p.status === "pending" ||
        p.status === "skipped"
      ) {
        return true;
      }
      // Fail vĩnh viễn / đã thử — không tạo post từ draft nữa.
      if (p.status === "failed") {
        const err = p.error ?? "";
        return (
          err === "reply_too_old" ||
          err === "reply_restricted" ||
          err === "reply_subscribers_only" ||
          err === "submit_disabled" ||
          err === "navigate_timeout" ||
          err === "empty_text" ||
          err === "composer_missing" ||
          err === "reply_composer_missing" ||
          err === "composer_set_failed" ||
          err === "reply_composer_set_failed" ||
          err === "reply_btn_missing"
        );
      }
      return false;
    });
    if (!already) return j;
  }
  return null;
}
