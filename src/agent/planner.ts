import type { AgentDailyStats, AgentSettings, BrowseSurface } from "../domain/agent-settings.ts";
import type { AgentJob, AgentQueueState } from "../domain/agent-queue.ts";
import { findReadyDraft, makeJob } from "../domain/agent-queue.ts";
import type { FollowFilters } from "../domain/follow-settings.ts";
import type { Campaign } from "../domain/types.ts";
import type { TimelineTweet } from "../x/timeline.ts";
import { isCampaignLocked } from "../domain/campaign-lock.ts";
import { prioritizeBoosted } from "../domain/merge.ts";
import { actionHandled } from "../domain/action-progress.ts";
import { dailyActionReached, withDailyTargets } from "../domain/daily-targets.ts";
import { pogoRetweetFull } from "../domain/pogo-retweet.ts";
import {
  anyBrowseModuleOn,
  browseSurfaceLabel,
  enabledBrowseSurfaces,
  pickBrowseSurface,
} from "../x/browse-nav.ts";

export type PlannedAction =
  | { type: "idle"; reason: string }
  | { type: "job"; job: AgentJob }
  /** Một task Pogo: làm hết like → RT → follow → draft theo thứ tự. */
  | { type: "bundle"; jobs: AgentJob[]; tweetId: string };

function tweetUrlOf(c: Campaign): string | null {
  return c.tweet_url;
}

function actionOn(settings: AgentSettings, key: keyof AgentSettings["actions"]): boolean {
  return settings.actions[key] === true;
}

/** Bound local follow failures per author, including older jobs already in storage. */
export function followRetryLimitReached(queue: AgentQueueState, handle: string): boolean {
  const target = handle.replace(/^@/, "").toLowerCase();
  return queue.jobs.filter((job) =>
    job.kind === "follow" &&
    job.authorHandle?.replace(/^@/, "").toLowerCase() === target &&
    (job.status === "failed" || job.status === "skipped") &&
    ["follow_btn_missing", "follow_not_confirmed", "follow_disabled", "follow_click_failed", "no_handle", "follow_profile_unverified"].includes(job.error ?? ""),
  ).length >= 1;
}

import { isOwnPost } from "../domain/own-post.ts";

function normalizePlanHandle(handle: string | null | undefined): string {
  return String(handle || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
}

/**
 * Next username from the Follow-tab list that the agent has not already
 * followed / skipped / queued this session.
 */
export function nextBrowseFollowListHandle(
  handles: string[],
  queue: AgentQueueState,
  ownHandle: string | null,
  filters?: FollowFilters | null,
): string | null {
  const own = normalizePlanHandle(ownHandle);
  const seen = new Set(
    queue.jobs
      .filter((j) => j.kind === "follow" && j.authorHandle)
      .map((j) => normalizePlanHandle(j.authorHandle)),
  );
  for (const raw of handles) {
    const handle = normalizePlanHandle(raw);
    if (!handle || (own && handle === own) || seen.has(handle)) continue;
    if (followRetryLimitReached(queue, handle)) continue;
    if (filters) {
      if (filters.blacklist.includes(handle)) continue;
      if (filters.whitelist.length && !filters.whitelist.includes(handle)) continue;
    }
    return handle;
  }
  return null;
}

const PERMANENT_REPLY_ERRORS = new Set([
  "reply_too_old",
  "reply_restricted",
  "reply_subscribers_only",
  "submit_disabled",
  "composer_missing",
  "reply_composer_missing",
  "composer_set_failed",
  "reply_composer_set_failed",
  "reply_btn_missing",
  "empty_text",
  "navigate_timeout",
  "feature_disabled",
]);

/** Không mở được bài / acc sus — bỏ cả campaign, không tạo Like/RT/Follow lại. */
export const PERMANENT_TWEET_ERRORS = new Set([
  "navigate_timeout",
  "tweet_not_found",
  "tweet_unavailable",
  "profile_suspended",
  "profile_restricted",
  "profile_missing",
  "profile_unavailable",
]);

/** Reply đã fail/skip lỗi “không sửa được” — đừng tạo post_reply lại. */
export function replyGaveUp(queue: AgentQueueState, tweetId: string): boolean {
  const posts = queue.jobs.filter((j) => j.kind === "post_reply" && j.tweetId === tweetId);
  if (posts.some((j) => j.status === "skipped" && j.error !== "campaign_locked")) return true;
  if (posts.some((j) => j.status === "failed" && PERMANENT_REPLY_ERRORS.has(j.error ?? ""))) {
    return true;
  }
  // Fail thường ≥ 2 lần → bỏ, không quay vòng.
  return posts.filter((j) => j.status === "failed").length >= 2;
}

/** Bài không mở được (navigate_timeout…) — đừng xếp lại bất kỳ job nào cho tweet này. */
export function tweetUnreachable(queue: AgentQueueState, tweetId: string): boolean {
  return queue.jobs.some(
    (j) =>
      j.tweetId === tweetId &&
      (j.status === "failed" || j.status === "skipped") &&
      PERMANENT_TWEET_ERRORS.has(j.error ?? ""),
  );
}

/** Đã làm / đang làm / đang navigate / đã skip — không tạo job trùng. */
export function alreadyTracked(
  queue: AgentQueueState,
  kind: AgentJob["kind"],
  tweetId: string,
): boolean {
  if (tweetUnreachable(queue, tweetId)) return true;
  if (
    (kind === "post_reply" || kind === "draft_reply") &&
    replyGaveUp(queue, tweetId)
  ) {
    return true;
  }
  return queue.jobs.some((j) => {
    if (j.tweetId !== tweetId || j.kind !== kind) return false;
    if (j.status === "skipped" && j.error === "campaign_locked") return false;
    if (kind === "like" && j.status === "skipped" && ["feed_tweet_missing", "feed_not_home"].includes(j.error ?? "")) return false;
    if (
      j.status === "done" ||
      j.status === "running" ||
      j.status === "pending" ||
      j.status === "skipped"
    ) {
      return true;
    }
    // Fail vĩnh viễn (navigate_timeout…) — không tạo lại cùng kind.
    if (j.status === "failed" && PERMANENT_TWEET_ERRORS.has(j.error ?? "")) return true;
    // Like/RT fail ≥ 2 lần → thôi.
    if (
      j.status === "failed" &&
      (kind === "like" || kind === "retweet") &&
      queue.jobs.filter(
        (x) => x.tweetId === tweetId && x.kind === kind && x.status === "failed",
      ).length >= 2
    ) {
      return true;
    }
    return false;
  });
}

function isNavigateError(error: string | null): boolean {
  if (!error) return false;
  return (
    error.includes("navigating") ||
    error.includes("need_navigate") ||
    error === "navigating_home_back" ||
    error === "timeout" ||
    error === "busy" ||
    error === "port_closed"
    || error === "x_account_requires_attention" || error === "x_rate_limited"
    || error === "sw_interrupted" || error === "stopped" || error === "daily_target_reached" || error === "follow_rate_30m" || error === "pogo_retweet_window_full" || error === "x_page_cooling_down"
  );
}

function findResumablePending(queue: AgentQueueState): AgentJob | null {
  return (
    queue.jobs.find(
      (j) => !j.postFollow && j.status === "pending" && isNavigateError(j.error) && j.kind !== "scroll_home",
    ) || null
  );
}

type JobSource = "pogo" | "manual" | "browse";

export type BrowseRolls = {
  /** Legacy caller/storage field; never gates scanning or action selection. */
  engage: boolean;
  like: boolean;
  reply: boolean;
  retweet: boolean;
  follow: boolean;
  listFollow?: boolean;
  /** Legacy field; standalone and bundled Likes now share like. */
  feedLike?: boolean;
};

export function defaultBrowseRolls(settings: AgentSettings, rng = Math.random): BrowseRolls {
  const h = settings.humanize;
  const roll = (pct: number) => rng() * 100 < Math.max(0, Math.min(100, pct));
  return {
    engage: true,
    like: roll(h.likePct),
    reply: roll(h.replyPct),
    retweet: roll(h.retweetPct),
    follow: roll(h.followPct),
    listFollow: roll(h.listFollowPct ?? h.followPct),
    feedLike: false,
  };
}

function campaignToBase(c: Campaign, jobSource: JobSource = "pogo") {
  return {
    tweetId: c.tweet_id,
    authorHandle: c.author_handle,
    tweetUrl: tweetUrlOf(c),
    tweetText: c.text,
    source: jobSource,
  };
}

/** Sticky chỉ khi còn việc dở (pending/running) — không dính mãi tweet đã skip hết. */
function stickyTweetId(queue: AgentQueueState, source: JobSource = "pogo"): string | null {
  for (const j of queue.jobs) {
    if (j.source !== source || !j.tweetId) continue;
    if (j.status === "pending" || j.status === "running") {
      return j.tweetId;
    }
  }
  return null;
}

/**
 * Action còn thiếu của 1 campaign.
 * Chỉ theo bật/tắt Behavior — không giới hạn số/ngày.
 */
export function buildCampaignJobs(input: {
  campaign: Campaign;
  settings: AgentSettings;
  queue: AgentQueueState;
  executeActions: boolean;
  hasApiKey: boolean;
  jobSource?: JobSource;
}): AgentJob[] {
  const { campaign: c, settings, queue, executeActions, hasApiKey } = input;
  const jobSource = input.jobSource ?? "pogo";
  if (jobSource === "pogo" && isCampaignLocked(c)) {
    if (!executeActions || !actionOn(settings, "follow") || !c.author_handle ||
        followRetryLimitReached(queue, c.author_handle) || alreadyTracked(queue, "follow", c.tweet_id)) return [];
    // Unlock first; never draft/like/repost while the server gate is still closed.
    return [makeJob({ kind: "follow", ...campaignToBase(c, jobSource), reason: "Follow tác giả để mở khóa task Pogo, rồi Check now" })];
  }
  // Đã navigate_timeout / bài mất → bỏ hết task của campaign này.
  if (tweetUnreachable(queue, c.tweet_id)) return [];
  const base = campaignToBase(c, jobSource);
  const jobs: AgentJob[] = [];

  if (
    executeActions &&
    actionOn(settings, "retweet") &&
    jobSource === "pogo" &&
    c.actions.retweet.status === "not_recorded" && !actionHandled(c.actions.retweet) &&
    c.tweet_url &&
    !alreadyTracked(queue, "retweet", c.tweet_id)
  ) {
    jobs.push(makeJob({ kind: "retweet", ...base }));
  }

  const needReply =
    actionOn(settings, "reply") &&
    c.actions.reply.status === "not_recorded" && !actionHandled(c.actions.reply) &&
    !!c.tweet_url &&
    !alreadyTracked(queue, "post_reply", c.tweet_id);
  if (needReply && hasApiKey) {
    const readyReply = findReadyDraft({ jobs: queue.jobs.filter((j) => j.tweetId === c.tweet_id) }, "draft_reply");
    const readyForThis =
      readyReply?.tweetId === c.tweet_id && readyReply.draftText?.trim()
        ? readyReply
        : null;
    let draftingNow = false;
    if (!readyForThis && !alreadyTracked(queue, "draft_reply", c.tweet_id)) {
      jobs.push(makeJob({ kind: "draft_reply", ...base }));
      draftingNow = true;
    }
    // Chỉ xếp post_reply khi đã có text hoặc sẽ soạn ngay trong bundle.
    if (executeActions && (readyForThis || draftingNow)) {
      jobs.push(
        makeJob({
          kind: "post_reply",
          ...base,
          draftText: readyForThis?.draftText ?? null,
        }),
      );
    }
    // Like không phải task điểm — chỉ đi kèm Reply cho tự nhiên.
    if (
      executeActions &&
      actionOn(settings, "like") &&
      c.tweet_url &&
      !alreadyTracked(queue, "like", c.tweet_id)
    ) {
      jobs.push(makeJob({ kind: "like", ...base }));
    }
  }

  if (
    executeActions &&
    actionOn(settings, "follow") &&
    c.follows_author === false &&
    c.author_handle &&
    !followRetryLimitReached(queue, c.author_handle) &&
    !alreadyTracked(queue, "follow", c.tweet_id)
  ) {
    jobs.push(makeJob({ kind: "follow", ...base }));
  }

  const needQuote =
    actionOn(settings, "quote") &&
    !actionHandled(c.actions.quote) &&
    !!c.tweet_url &&
    !alreadyTracked(queue, "post_quote", c.tweet_id);
  if (needQuote && hasApiKey) {
    const readyQuote = findReadyDraft({ jobs: queue.jobs.filter((j) => j.tweetId === c.tweet_id) }, "draft_quote");
    const readyForThis =
      readyQuote?.tweetId === c.tweet_id && readyQuote.draftText?.trim()
        ? readyQuote
        : null;
    let draftingNow = false;
    if (!readyForThis && !alreadyTracked(queue, "draft_quote", c.tweet_id)) {
      jobs.push(makeJob({ kind: "draft_quote", ...base }));
      draftingNow = true;
    }
    if (executeActions && (readyForThis || draftingNow)) {
      jobs.push(
        makeJob({
          kind: "post_quote",
          ...base,
          draftText: readyForThis?.draftText ?? null,
        }),
      );
    }
  }

  return jobs;
}

function campaignHasWork(
  c: Campaign,
  settings: AgentSettings,
  queue: AgentQueueState,
  executeActions: boolean,
  hasApiKey: boolean,
  jobSource: JobSource = "pogo",
): boolean {
  return buildCampaignJobs({
    campaign: c,
    settings,
    queue,
    executeActions,
    hasApiKey,
    jobSource,
  }).length > 0;
}

function pickCampaignBundle(
  open: Campaign[],
  queue: AgentQueueState,
  settings: AgentSettings,
  executeActions: boolean,
  hasApiKey: boolean,
  jobSource: JobSource,
): PlannedAction | null {
  const sticky = jobSource === "pogo" ? null : stickyTweetId(queue, jobSource);
  const ordered = [
    ...(sticky ? open.filter((c) => c.tweet_id === sticky) : []),
    ...open.filter((c) => c.tweet_id !== sticky),
  ];
  for (const c of ordered) {
    if (!campaignHasWork(c, settings, queue, executeActions, hasApiKey, jobSource)) continue;
    const jobs = buildCampaignJobs({
      campaign: c,
      settings,
      queue,
      executeActions,
      hasApiKey,
      jobSource,
    });
    if (!jobs.length) continue;
    if (jobs.length === 1) return { type: "job", job: jobs[0]! };
    return { type: "bundle", jobs, tweetId: c.tweet_id };
  }
  return null;
}

function actionAllowedForJob(settings: AgentSettings, kind: AgentJob["kind"]): boolean {
  if (kind === "like") return actionOn(settings, "like");
  if (kind === "retweet") return actionOn(settings, "retweet");
  if (kind === "follow") return actionOn(settings, "follow");
  if (kind === "draft_reply" || kind === "post_reply") return actionOn(settings, "reply");
  if (kind === "draft_quote" || kind === "post_quote") return actionOn(settings, "quote");
  return true;
}

export function planNextAction(input: {
  settings: AgentSettings;
  stats: AgentDailyStats;
  queue: AgentQueueState;
  campaigns: Campaign[];
  /** Synthetic campaigns từ list link đã dán (tab Nguồn). */
  linkCampaigns?: Campaign[];
  /** Bài visible trên feed browse (scan trong tick). */
  browseCandidates?: TimelineTweet[];
  /** Inject rolls trong test; production dùng Math.random. */
  browseRolls?: BrowseRolls;
  /** Surface đã chọn / sticky từ runner; null → picker tự chọn. */
  browseSurface?: BrowseSurface | null;
  /** Mentions còn candidate → cộng weight. */
  mentionsBoost?: number;
  /** New notification batch may enter All; false/unknown must not navigate there. */
  notificationsAllowed?: boolean;
  browseCooldowns?: Partial<Record<BrowseSurface, number>>;
  /** Handles từ tab Follow · Nhập danh sách (khi modules.following). */
  followListHandles?: string[];
  /** Filters Sorsa/verified từ tab Follow. */
  followFilters?: FollowFilters | null;
  executeActions: boolean;
  ownHandle: string | null;
  hasApiKey?: boolean;
}): PlannedAction {
  const { campaigns, executeActions } = input;
  const settings = withDailyTargets(input.settings, input.stats);
  const pogoSettings = { ...settings, actions: { ...settings.actions, retweet: settings.actions.retweet && !pogoRetweetFull(input.stats.pogoRetweets) } };
  const lockedIds = new Set(campaigns.filter(isCampaignLocked).map((c) => c.tweet_id));
  // Covers every planning path: resumed navigation, ready drafts and new bundles.
  const queue = { jobs: input.queue.jobs.filter((job) => !(job.kind === "retweet" && (job.source === "manual" || (job.source === "browse" && !settings.homeRetweet) || (job.source === "pogo" && !pogoSettings.actions.retweet))) && !(job.source === "pogo" && job.tweetId && lockedIds.has(job.tweetId) &&
    !(job.kind === "follow" && actionOn(settings, "follow")))) };
  queue.jobs = queue.jobs.filter(job => job.browseSurface !== "mentions" || (settings.modules.notifications &&
    job.expectedAccount?.replace(/^@/, "").toLowerCase() === (input.ownHandle || settings.ownHandle || "").replace(/^@/, "").toLowerCase() &&
    ((job.kind === "draft_reply" && (job.status === "done" || !!job.notificationBatchId)) || (job.kind === "post_reply"))));
  const hasApiKey = input.hasApiKey !== false;
  const own = (input.ownHandle || settings.ownHandle || "").replace(/^@/, "").toLowerCase();
  queue.jobs = queue.jobs.filter(job => !((job.source === "pogo" || job.source === "manual") && isOwnPost(own, job.authorHandle, job.tweetUrl)));
  const open = prioritizeBoosted(campaigns.filter((c) => !c.stale && !isOwnPost(own, c.author_handle, c.tweet_url) && (!isCampaignLocked(c) || actionOn(settings, "follow"))));
  const linkOpen = (input.linkCampaigns ?? []).filter((c) => {
    if (c.stale) return false;
    return !isOwnPost(own, c.author_handle, c.tweet_url);
  });
  const browseCandidates = input.browseCandidates ?? [];

  const replyRecorded = (tweetId: string | null | undefined, source: AgentJob["source"] = "pogo"): boolean => {
    if (!tweetId || source === "browse") return false;
    const c = source === "manual" ? linkOpen.find((x) => x.tweet_id === tweetId) : campaigns.find((x) => x.tweet_id === tweetId);
    return !!c && actionHandled(c.actions.reply);
  };

  const allowPogo = settings.modules.pogoTasks && settings.priority !== "browse_only";
  const allowLinks = settings.modules.linkList === true;
  const allowBrowse = anyBrowseModuleOn(settings);
  const allowDraftPost =
    executeActions && (allowPogo || allowLinks || allowBrowse);

  // 0) Resume navigate
  const pendingMention = queue.jobs.find(job => job.browseSurface === "mentions" && job.kind === "post_reply" && job.status === "pending");
  if (pendingMention && executeActions && settings.modules.notifications && actionOn(settings, "reply") &&
      !dailyActionReached(input.settings, input.stats, "post_reply") && pendingMention.expectedAccount?.toLowerCase() === own) {
    return { type: "job", job: pendingMention };
  }
  const selectedNotification = queue.jobs.find(job => job.browseSurface === "mentions" && job.kind === "draft_reply" && job.status === "pending" && !!job.notificationBatchId);
  if (selectedNotification && executeActions && hasApiKey && actionOn(settings, "reply") && !dailyActionReached(input.settings, input.stats, "draft_reply")) return { type: "job", job: selectedNotification };
  if (executeActions) {
    const resume = findResumablePending({ jobs: queue.jobs.filter((j) => !dailyActionReached(input.settings, input.stats, j.kind)) });
    if (resume) {
      const replyJob =
        resume.kind === "draft_reply" || resume.kind === "post_reply" || resume.kind === "like";
      if (resume.kind === "follow" && resume.authorHandle && followRetryLimitReached(queue, resume.authorHandle)) {
        // Continue with other work after bounded failures for this author.
      } else if (!actionAllowedForJob(settings, resume.kind)) {
        // Action đã tắt
      } else if (replyJob && replyRecorded(resume.tweetId, resume.source)) {
        // Reply Pogo đã xong — không resume Soạn/Reply/Like kèm.
      } else if (settings.priority === "browse_only" && resume.source === "pogo") {
        // skip
      } else if (!allowLinks && resume.source === "manual") {
        // Module list link đã tắt — bỏ resume manual.
      } else if (!allowBrowse && resume.source === "browse") {
        // Mọi nguồn lướt X đã tắt.
      } else if (
        (resume.source === "pogo" || resume.source === "manual") &&
        resume.tweetId &&
        (resume.kind === "like" || resume.kind === "retweet" || resume.kind === "follow")
      ) {
        const pool = resume.source === "manual" ? linkOpen : open;
        const camp = pool.find((c) => c.tweet_id === resume.tweetId);
        if (camp) {
          const rest = buildCampaignJobs({
            campaign: camp,
            settings: resume.source === "pogo" ? pogoSettings : settings,
            queue,
            executeActions,
            hasApiKey,
            jobSource: resume.source,
          }).filter((j) => j.kind !== resume.kind);
          return { type: "bundle", jobs: [resume, ...rest], tweetId: resume.tweetId };
        }
        return { type: "job", job: resume };
      } else {
        return { type: "job", job: resume };
      }
    }
  }

  // 1) Post draft sẵn (Pogo / list link / browse)
  if (allowDraftPost) {
    // Ready drafts lower in the feed must not jump ahead of the top task.
    const pogoHead = allowPogo ? open.find((c) =>
      campaignHasWork(c, pogoSettings, queue, executeActions, hasApiKey, "pogo") ||
      queue.jobs.some((j) => j.source === "pogo" && j.tweetId === c.tweet_id &&
        j.status === "pending" && actionAllowedForJob(settings, j.kind) &&
        !((j.kind === "post_reply" || j.kind === "draft_reply") && replyRecorded(j.tweetId))))?.tweet_id : null;
    const draftQueue = { jobs: queue.jobs.filter((j) => j.source !== "pogo" || !pogoHead || j.tweetId === pogoHead) };
    const sourceOk = (source: AgentJob["source"]) =>
      (source === "pogo" && allowPogo) ||
      (source === "manual" && allowLinks) ||
      (source === "browse" && allowBrowse);
    const pending = draftQueue.jobs.find(
      (j) =>
        !j.postFollow &&
        j.status === "pending" &&
        j.draftText &&
        j.tweetUrl &&
        sourceOk(j.source) &&
        ((j.kind === "post_reply" && actionOn(settings, "reply") && !replyRecorded(j.tweetId, j.source)) ||
          (j.kind === "post_quote" && actionOn(settings, "quote"))),
    );
    if (pending) return { type: "job", job: pending };
    if (actionOn(settings, "reply")) {
      const ready = findReadyDraft(draftQueue, "draft_reply");
      if (
        ready?.draftText &&
        ready.tweetUrl &&
        ready.tweetId &&
        sourceOk(ready.source) &&
        !replyRecorded(ready.tweetId, ready.source) &&
        !alreadyTracked(queue, "post_reply", ready.tweetId)
      ) {
        return {
          type: "job",
          job: makeJob({
            kind: "post_reply",
            tweetId: ready.tweetId,
            authorHandle: ready.authorHandle,
            tweetUrl: ready.tweetUrl,
            tweetText: ready.tweetText,
            draftText: ready.draftText,
            source: ready.source,
            browseSurface: ready.browseSurface,
            expectedAccount: ready.expectedAccount,
            notificationKind: ready.notificationKind,
            notificationBatchId: ready.notificationBatchId,
            parentText: ready.parentText,
            ownerPost: ready.ownerPost,
            conversationContext: ready.conversationContext,
            autoPost: true,
          }),
        };
      }
    }
    if (actionOn(settings, "quote")) {
      const ready = findReadyDraft(draftQueue, "draft_quote");
      if (
        ready?.draftText &&
        ready.tweetUrl &&
        ready.tweetId &&
        sourceOk(ready.source) &&
        !alreadyTracked(queue, "post_quote", ready.tweetId)
      ) {
        return {
          type: "job",
          job: makeJob({
            kind: "post_quote",
            tweetId: ready.tweetId,
            authorHandle: ready.authorHandle,
            tweetUrl: ready.tweetUrl,
            tweetText: ready.tweetText,
            draftText: ready.draftText,
            source: ready.source,
            browseSurface: ready.browseSurface,
          }),
        };
      }
    }
  }

  // 2) Bundle list link (ưu tiên trước Pogo)
  if (allowLinks && linkOpen.length) {
    const fromLinks = pickCampaignBundle(
      linkOpen,
      queue,
      settings,
      executeActions,
      hasApiKey,
      "manual",
    );
    if (fromLinks) return fromLinks;
  }

  // 3) Bundle 1 task Pogo
  if (allowPogo) {
    const fromPogo = pickCampaignBundle(open, queue, pogoSettings, executeActions, hasApiKey, "pogo");
    if (fromPogo) return fromPogo;
  }

  if (settings.priority === "pogo_only" && !allowLinks) {
    if (!open.length && lockedIds.size) return { type: "idle", reason: "pogo_tasks_locked_wait_for_unlock" };
    if (!hasApiKey && actionOn(settings, "reply")) {
      return { type: "idle", reason: "missing_api_key_save_in_ai_tab" };
    }
    return { type: "idle", reason: "pogo_queue_empty_scan_tasks_or_enable_home_scroll" };
  }

  if (allowLinks && !linkOpen.length && settings.priority === "pogo_only" && !allowPogo) {
    return { type: "idle", reason: "link_list_empty" };
  }

  if (allowBrowse) {
    const stickyFromQueue = queue.jobs.find(
      (j) =>
        j.source === "browse" &&
        j.status === "pending" &&
        j.kind !== "scroll_home" &&
        j.browseSurface,
    )?.browseSurface;
    const enabled = enabledBrowseSurfaces(settings).filter(surface =>
      (input.browseCooldowns?.[surface] ?? 0) <= Date.now() && (surface !== "mentions" || input.notificationsAllowed === true));
    if (!enabled.length) return { type: "idle", reason: enabledBrowseSurfaces(settings).some(surface =>
      (input.browseCooldowns?.[surface] ?? 0) > Date.now()) ? "browse_sources_cooling_down" : "notifications_waiting_for_unread" };
    const surface =
      (input.browseSurface && enabled.includes(input.browseSurface) ? input.browseSurface : null) ||
      (enabled.includes("mentions") ? "mentions" : null) ||
      pickBrowseSurface({
        enabled,
        sticky: stickyFromQueue ?? null,
      }) ||
      enabled[0] ||
      "home";
    return browseAction({
      settings,
      queue,
      executeActions,
      hasApiKey,
      ownHandle: input.ownHandle,
      candidates: browseCandidates,
      scanned: input.browseCandidates !== undefined,
      rolls: input.browseRolls,
      browseSurface: surface,
      followListHandles: input.followListHandles ?? [],
      followFilters: input.followFilters ?? null,
    });
  }

  if (allowLinks && !linkOpen.length) {
    return { type: "idle", reason: "link_list_empty_or_done" };
  }

  return { type: "idle", reason: "nothing_to_do" };
}

function scrollHomeJob(reason: string, browseSurface: BrowseSurface = "home"): PlannedAction {
  return {
    type: "job",
    job: makeJob({
      kind: "scroll_home",
      tweetId: null,
      authorHandle: null,
      tweetUrl: null,
      tweetText: null,
      source: "browse",
      browseSurface,
      reason,
    }),
  };
}

function candidateEligible(
  c: TimelineTweet,
  settings: AgentSettings,
  queue: AgentQueueState,
  ownHandle: string | null,
): boolean {
  if (!c.tweetId || !c.authorHandle || !c.tweetUrl) return false;
  if (c.promoted) return false;
  if (tweetUnreachable(queue, c.tweetId)) return false;
  const own = (ownHandle || settings.ownHandle || "").replace(/^@/, "").toLowerCase();
  if (settings.skipOwnPosts && own && c.authorHandle.replace(/^@/, "").toLowerCase() === own) {
    return false;
  }
  return true;
}

/**
 * Tạo job browse cho 1 bài timeline — tôn trọng action + rolls humanize.
 * Không ép đủ mọi action như Pogo.
 */
export function buildBrowseJobs(input: {
  candidate: TimelineTweet;
  settings: AgentSettings;
  queue: AgentQueueState;
  executeActions: boolean;
  hasApiKey: boolean;
  rolls: BrowseRolls;
  browseSurface?: BrowseSurface;
  /** Khi true và list còn handle, không Follow author feed (list là nguồn chính). */
  preferFollowList?: boolean;
}): AgentJob[] {
  const { candidate: c, settings, queue, executeActions, hasApiKey, rolls } = input;
  if (!executeActions || tweetUnreachable(queue, c.tweetId)) return [];
  const browseSurface = input.browseSurface ?? "home";

  const base = {
    tweetId: c.tweetId,
    authorHandle: c.authorHandle,
    tweetUrl: c.tweetUrl,
    tweetText: c.text,
    source: "browse" as const,
    browseSurface,
  };
  const jobs: AgentJob[] = [];
  const textOk = !!(c.text && c.text.trim().length >= 8);

  const wantReply =
    actionOn(settings, "reply") &&
    rolls.reply &&
    hasApiKey &&
    textOk &&
    !alreadyTracked(queue, "post_reply", c.tweetId);

  if (wantReply) {
    const readyReply = findReadyDraft({ jobs: queue.jobs.filter((j) => j.tweetId === c.tweetId) }, "draft_reply");
    const readyForThis =
      readyReply?.tweetId === c.tweetId && readyReply.draftText?.trim() ? readyReply : null;
    let draftingNow = false;
    if (!readyForThis && !alreadyTracked(queue, "draft_reply", c.tweetId)) {
      jobs.push(makeJob({ kind: "draft_reply", ...base }));
      draftingNow = true;
    }
    if ((readyForThis || draftingNow)) {
      jobs.push(
        makeJob({
          kind: "post_reply",
          ...base,
          draftText: readyForThis?.draftText ?? null,
        }),
      );
    }
    if (actionOn(settings, "like") && rolls.like && !c.alreadyLiked && !alreadyTracked(queue, "like", c.tweetId)) {
      jobs.push(makeJob({ kind: "like", ...base }));
    }
  } else if (
    actionOn(settings, "like") &&
    rolls.like &&
    !c.alreadyLiked &&
    !alreadyTracked(queue, "like", c.tweetId)
  ) {
    jobs.push(makeJob({ kind: "like", ...base, likeOnFeed: browseSurface === "home" || browseSurface === "following" }));
  }


  if (settings.homeRetweet && actionOn(settings, "retweet") && rolls.retweet &&
      !c.alreadyRetweeted && !alreadyTracked(queue, "retweet", c.tweetId)) {
    jobs.push(makeJob({ kind: "retweet", ...base }));
  }

  if (
    (!input.preferFollowList || settings.randomAuthorFollow) &&
    (!settings.randomAuthorFollow || jobs.some(j => ["like", "post_reply", "retweet", "post_quote"].includes(j.kind))) &&
    actionOn(settings, "follow") &&
    rolls.follow &&
    c.authorHandle &&
    !c.alreadyFollowing &&
    !queue.jobs.some((j) => j.kind === "follow" && j.authorHandle?.replace(/^@/, "").toLowerCase() === c.authorHandle.toLowerCase() &&
      (j.status === "done" || (j.status === "skipped" && ["already_following", "follow_requested"].includes(j.error ?? "")))) &&
    !followRetryLimitReached(queue, c.authorHandle) &&
    !alreadyTracked(queue, "follow", c.tweetId)
  ) {
    jobs.push(makeJob({ kind: "follow", ...base, authorFollow: settings.randomAuthorFollow === true,
      reason: settings.randomAuthorFollow ? `Follow tác giả sau tương tác · chỉ Sorsa >${settings.randomAuthorFollowSorsaMin ?? 500}` : "Follow author trên feed" }));
  }

  if (jobs.some(j => j.kind !== "like" && !(j.kind === "follow" && j.authorFollow))) {
    for (const job of jobs) delete job.likeOnFeed;
  }
  return jobs;
}

/**
 * Direct mentions/replies only: draft and post automatically.
 */
export function buildMentionJobs(input: {
  candidate: TimelineTweet; settings: AgentSettings; queue: AgentQueueState;
  executeActions: boolean; hasApiKey: boolean; ownHandle?: string | null;
}): AgentJob[] {
  const { candidate: c, settings, queue } = input;
  if (!input.executeActions || !input.hasApiKey || !actionOn(settings, "reply") ||
      c.directedToOwn !== true || !c.text?.trim() || tweetUnreachable(queue, c.tweetId)) return [];
  const own = (input.ownHandle || settings.ownHandle || "").replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(own)) return [];
  if (alreadyTracked(queue, "draft_reply", c.tweetId) || alreadyTracked(queue, "post_reply", c.tweetId)) return [];
  return [makeJob({ kind: "draft_reply", source: "browse", browseSurface: "mentions", expectedAccount: own,
    tweetId: c.tweetId, authorHandle: c.authorHandle, tweetUrl: c.tweetUrl, tweetText: c.text,
    reason: "Mentions: soạn phản hồi" })];
}

function browseAction(input: {
  settings: AgentSettings;
  queue: AgentQueueState;
  executeActions: boolean;
  hasApiKey: boolean;
  ownHandle: string | null;
  candidates: TimelineTweet[];
  scanned?: boolean;
  rolls?: BrowseRolls;
  browseSurface: BrowseSurface;
  followListHandles?: string[];
  followFilters?: FollowFilters | null;
}): PlannedAction {
  const { settings, queue, executeActions, hasApiKey, ownHandle, candidates } = input;
  const surface = input.browseSurface;
  const eligible = candidates.filter((c) => candidateEligible(c, settings, queue, ownHandle));
  // Decide actions only after checking the available posts. No extra open-post roll.
  const rolls = input.rolls ?? (eligible.length || input.scanned ? defaultBrowseRolls(settings)
    : { engage: true, like: false, reply: false, retweet: false, follow: false });
  const followListHandles = input.followListHandles ?? [];
  const listFollowOn =
    settings.modules.following === true && (surface === "home" || surface === "following");
  const label = browseSurfaceLabel(surface);

  // Resume / tiếp pending browse (không phải scroll).
  const pendingBrowse = queue.jobs.find(
    (j) =>
      j.source === "browse" &&
      !j.postFollow &&
      j.status === "pending" &&
      j.kind !== "scroll_home" &&
      actionAllowedForJob(settings, j.kind),
  );
  if (pendingBrowse && executeActions) return { type: "job", job: pendingBrowse };

  if (!executeActions) return scrollHomeJob("Chế độ chỉ lướt, không thực hiện tương tác", surface);

  // Thông báo · All: reply-first, không feed-like / list-follow.
  if (surface === "mentions") {
    return scrollHomeJob("Có thông báo mới · đọc một đợt để chọn tối đa 3 nháp", surface);
  }

  // List and author rolls are independent. Alternate priority after a list attempt
  // so 100% list Follow cannot starve selected post interactions.
  const listHandle =
    listFollowOn && executeActions && actionOn(settings, "follow") && (rolls.listFollow ?? rolls.follow)
      ? nextBrowseFollowListHandle(followListHandles, queue, ownHandle, input.followFilters)
      : null;
  const listPlan: PlannedAction | null = listHandle ? {
      type: "job",
      job: makeJob({
        kind: "follow",
        source: "browse",
        browseSurface: surface,
        tweetId: null,
        authorHandle: listHandle,
        tweetUrl: null,
        tweetText: null,
        reason: `Follow từ list · @${listHandle}`,
      }),
    } : null;
  const lastWork = queue.jobs.filter(j => j.source === "browse" && j.browseSurface === surface &&
    ["done", "skipped", "failed"].includes(j.status) && j.kind !== "scroll_home" && !j.kind.startsWith("draft_") && !j.postFollow)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const lastWasList = lastWork?.kind === "follow" && !lastWork.tweetId;
  if (listPlan && !lastWasList) return listPlan;

  // Preserve legacy author fallback; the explicit author mode can coexist with the list.
  const preferFollowList =
    listFollowOn &&
    !!nextBrowseFollowListHandle(followListHandles, queue, ownHandle, input.followFilters);

  if (!candidates.length) {
    return listPlan ?? scrollHomeJob(`Chưa thấy bài trên ${label}, tìm nội dung tiếp theo`, surface);
  }

  if (!eligible.length) {
    return listPlan ?? scrollHomeJob(`Các bài trên ${label} chưa đủ điều kiện tương tác`, surface);
  }

  while (eligible.length) {
    const [pick] = eligible.splice(Math.floor(Math.random() * eligible.length), 1);
    const jobs = buildBrowseJobs({
      candidate: pick!,
      settings,
      queue,
      executeActions,
      hasApiKey,
      rolls,
      browseSurface: surface,
      preferFollowList,
    });
    if (!jobs.length) continue;
    if (jobs.length === 1) return { type: "job", job: jobs[0]! };
    return { type: "bundle", jobs, tweetId: pick!.tweetId };
  }
  return listPlan ?? scrollHomeJob(`Đã kiểm tra bài trên ${label} · không chọn hành động theo tỷ lệ hoặc hành động đã xử lý`, surface);
}
