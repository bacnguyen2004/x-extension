/**
 * Orchestrator tick Phase 2–3: plan → AI draft → thực thi X.
 * Each task reads the post, then executes and records one action at a time.
 */

import { draftKindForJobSource, generateDraft, type AiGenerateResult } from "../agent/ai-client.ts";
import { notifyTelegram } from "./telegram-notify.ts";
import { isAiSkip } from "../agent/prompts.ts";
import { ownerPostReplyContext } from "../domain/reply-conversation.ts";
import { isOwnPost } from "../domain/own-post.ts";
import { observeNotificationBatch, notificationBatchCanOpen, startNotificationBatch, finishNotificationBatch, notificationCooldownMs } from "../domain/notification-batch.ts";
import { selectNotificationDrafts, isLowValueNotification } from "../agent/notification-selection.ts";
import { planNextAction } from "../agent/planner.ts";
import type { AgentJob } from "../domain/agent-queue.ts";
import {
  markJob,
  makeJob,
  pruneDisabledActionJobs,
  pruneJobsForRecordedReplies,
  pruneLockedPogoJobs,
  upsertJob,
  type AgentQueueState,
} from "../domain/agent-queue.ts";
import type { AgentDailyStats, AgentRuntime, AgentSettings, BrowseSurface } from "../domain/agent-settings.ts";
import { createEmptyDailyStats, todayKey } from "../domain/agent-settings.ts";
import { allDailyTargetsReached, dailyActionReached } from "../domain/daily-targets.ts";
import { adaptiveErrorDelay, idlePogoDelay, periodicRest, readAdaptiveRest, recordActiveWork, restReasonLabel, waitForRest, type RestReason } from "../domain/adaptive-rest.ts";
import { guardedFollow } from "./follow-budget.ts";
import { acquireXTurn } from "./x-coordinator.ts";
import { pullPogoWhenEmpty, deferPogoDemandPull } from "./pogo-demand-feed.ts";
import { loadPogoSettlementClock, nextPogoSettlementCheck } from "./pogo-settlement-store.ts";
import { pogoSettlementCheckAt } from "../domain/pogo-settlement.ts";
import { loadFollowHistory } from "./follow-history.ts";
import { inspectFollowProfile } from "./x-bridge.ts";
import { xPageRetryDelay } from "./x-page-health.ts";
import { guardedPogoRetweet, loadPogoRetweetPower } from "./pogo-retweet-store.ts";
import { retweetPolicyError } from "../domain/pogo-retweet.ts";
import type { AiSettings } from "../domain/ai-settings.ts";
import { loadAiSettings } from "./ai-settings-store.ts";
import { postPogoFollowCheck } from "../api/follow-check-client.ts";
import { fetchPogoFeed } from "../api/feed-client.ts";
import { getApiSessionTokenAsync, getApiSessionRevision } from "./api-session.ts";
import { applyPogoFeedRefresh, loadPogoCampaigns, markPogoProgress as writePogoProgress, reportPogoFeedError, pogoSessionRequiresLogin } from "./pogo-state-access.ts";
import { loadLinkCampaigns } from "./link-list-store.ts";
import { loadFollowSettings } from "./follow-store.ts";
import { fetchSorsaScore } from "./sorsa-store.ts";
import { sanitizeTimelineTweets } from "../x/timeline.ts";
import { isCampaignLocked } from "../domain/campaign-lock.ts";
import {
  evaluateFollowCandidate,
  parseHandleList,
  type FollowCandidate,
} from "../domain/follow-settings.ts";
import {
  getXConnection,
  navigateXTab,
  pingAllXTabs,
  requestFollow,
  requestFollowProfileMeta,
  requestLike,
  requestQuote,
  requestReply,
  requestRetweet,
  requestScrollBurst,
  requestPrepareTweet,
  requestBackToBrowse,
  requestTimelineScan,
  ensureXTabsConnected,
  type XActionResult,
} from "./x-bridge.ts";
import { isAccountUnavailableError } from "../x/account-status.ts";
import {
  anyBrowseModuleOn,
  enabledBrowseSurfaces,
  browseActivityPrefix,
  browseSurfaceLabel,
} from "../x/browse-nav.ts";
import {
  activeFeedSource,
  anyFeedRotationOn,
  browseScheduleOf,
  clearExhaustedRound,
  confirmSourceReady,
  ensureFeedRotation,
  feedRotationBlocksNotifications,
  feedSurfaceLabel,
  migrateLegacyBrowseSession,
  noteEligibleScan,
  noteNavigationFailure,
  notePostUnit,
  noteScrollUnit,
  pauseScanClock,
  resumeScanClock,
  sanitizeFeedRotationState,
  switchToNextSource,
  tickScanClock,
  type FeedRotationState,
} from "../domain/feed-rotation.ts";
import type { TimelineTweet } from "../x/timeline.ts";

function isBrowseNavigatingError(error: string | null | undefined): boolean {
  if (!error) return false;
  return (
    error === "navigating_home" ||
    error === "navigating_home_back" ||
    error.startsWith("navigating_following") ||
    error.startsWith("navigating_lists") ||
    error.startsWith("navigating_mentions") ||
    error.startsWith("navigating_home") ||
    error === "navigation_locked"
  );
}

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function returnBrowseSurface(runtime: AgentRuntime, settings: AgentSettings): BrowseSurface {
  const enabled = enabledBrowseSurfaces(settings).filter(surface => surface !== "mentions");
  const fromRotation = activeFeedSource(runtime.browseRotation);
  const remembered = runtime.notificationReturn ?? fromRotation ?? runtime.lastBrowseSurface;
  return remembered && remembered !== "mentions" && enabled.includes(remembered) ? remembered : enabled[0] ?? "home";
}

function resolveBrowseRotation(runtime: AgentRuntime, settings: AgentSettings, now: number): FeedRotationState {
  const existing = sanitizeFeedRotationState(runtime.browseRotation)
    ?? migrateLegacyBrowseSession(runtime.browseSession, settings, now);
  if (runtime.browseSession) runtime.browseSession = undefined;
  const schedule = browseScheduleOf(settings);
  return ensureFeedRotation(existing, settings, {
    now,
    preferred: runtime.lastBrowseSurface,
    keepSourceOnResume: schedule.keepSourceOnResume,
  });
}

function countConsiderableTweets(
  tweets: TimelineTweet[],
  settings: AgentSettings,
  queue: AgentQueueState,
  ownHandle: string | null,
): number {
  const own = (ownHandle || settings.ownHandle || "").replace(/^@/, "").toLowerCase();
  return tweets.filter((c) => {
    if (!c.tweetId || !c.authorHandle || !c.tweetUrl || c.promoted) return false;
    if (settings.skipOwnPosts && own && c.authorHandle.replace(/^@/, "").toLowerCase() === own) return false;
    if (queue.jobs.some((j) => j.tweetId === c.tweetId && j.kind !== "scroll_home" &&
      ["done", "skipped", "pending", "running", "failed"].includes(j.status))) return false;
    return true;
  }).length;
}

function isProcessingBrowsePost(job: AgentJob | undefined): boolean {
  if (!job || job.source !== "browse") return false;
  if (job.browseSurface === "mentions") return false;
  if (job.kind === "scroll_home") return false;
  if (job.likeOnFeed) return false;
  return !!job.tweetId || job.kind === "follow";
}

function feedWaitMessage(error: string): string | null {
  return ({
    notification_composer_open: "Đang mở ô soạn bài/trả lời · đợi hoàn tất trước khi chuyển thông báo.",
    feed_surface_wait: "Đang chờ đúng tab/nguồn và nội dung sẵn sàng · chưa quét bài.",
    feed_loading: "X đang tải timeline · giữ nguyên nguồn và chờ.",
    feed_end_loaded: "Đã tới cuối phần nội dung đang tải · chờ bài mới, chưa kết luận hết feed.",
    scroll_no_progress: "Cuộn chưa phản hồi sau khi đo lại · giữ nguồn và thử phục hồi.",
    feed_content_changed: "Feed vừa tải thêm hoặc thay bài · đọc lại trước khi cuộn tiếp.",
    feed_recovery_top: "Feed kẹt liên tiếp · đã về đầu nguồn, chờ tải lại nội dung.",
    feed_recovery_reload: "Feed vẫn kẹt · tải lại nguồn một lần, tối đa một lần mỗi 5 phút.",
    feed_recovery_cooldown: "Nguồn chưa phục hồi · tạm bỏ nguồn này 2 phút, tránh lặp cuộn/reload.",
  } as Record<string, string>)[error] ?? null;
}

/** Chuẩn hóa lỗi reply (acc sus đôi khi về dạng reply_composer_missing). */
function normalizeReplyError(error: string | undefined): string {
  const e = (error ?? "").trim();
  if (e === "reply_composer_missing") return "composer_missing";
  if (e === "reply_composer_set_failed") return "composer_set_failed";
  if (e === "reply_btn_missing") return "reply_btn_missing";
  return e;
}

/**
 * Lỗi reply không sửa được (acc sus / restricted / composer) → bỏ tweet, sang task tiếp.
 * Không cộng consecutiveErrors / không pause cả agent.
 */
function isReplyAudienceBlocked(error: string | undefined): boolean {
  const e = normalizeReplyError(error);
  return (
    e === "reply_too_old" ||
    e === "reply_restricted" ||
    e === "reply_subscribers_only" ||
    e === "feature_disabled" ||
    e === "submit_disabled" ||
    e === "composer_missing" ||
    e === "composer_set_failed" ||
    e === "reply_btn_missing" ||
    e === "empty_text" ||
    e === "navigate_timeout"
  );
}

function replyBlockMessage(error: string, tweetId: string | null | undefined): string {
  const id = tweetId ?? "";
  const e = normalizeReplyError(error);
  if (e === "reply_too_old") return `Bỏ reply — X không cho comment bài quá cũ (${id})`;
  if (e === "reply_subscribers_only") {
    return `Bỏ reply — cần Subscribe (Follow thường không đủ) (${id})`;
  }
  if (e === "submit_disabled") {
    return `Bỏ reply — nút Post không bật / X chặn comment (${id})`;
  }
  if (e === "navigate_timeout") {
    return `Bỏ reply — không mở được tweet (${id})`;
  }
  if (e === "empty_text") {
    return `Bỏ reply — nội dung draft không hợp lệ (${id})`;
  }
  if (e === "composer_missing" || e === "composer_set_failed" || e === "reply_btn_missing") {
    return `Bỏ reply — không mở được ô comment (acc sus / X chặn) (${id}) → task tiếp`;
  }
  return `Bỏ reply — X hạn chế ai được comment (“Only some accounts…”) (${id})`;
}

/** Gắn draftText từ draft_* đã done cùng tweet vào post_* đang trống. */
function attachDraftText(queue: AgentQueueState, post: AgentJob): AgentQueueState | null {
  if (!(post.kind === "post_reply" || post.kind === "post_quote")) return null;
  if (post.draftText?.trim()) return null;
  const draftKind = post.kind === "post_reply" ? "draft_reply" : "draft_quote";
  const draft = queue.jobs.find(
    (d) =>
      d.kind === draftKind &&
      d.tweetId === post.tweetId &&
      d.status === "done" &&
      !!d.draftText?.trim(),
  );
  if (!draft?.draftText) return null;
  return markJob(queue, post.id, { draftText: draft.draftText, error: null });
}

function noteSuccess(runtime: AgentRuntime): void {
  runtime.consecutiveErrors = 0;
  runtime.lastError = null;
}

function noteFailure(runtime: AgentRuntime, error: string | undefined): number {
  runtime.consecutiveErrors = (runtime.consecutiveErrors || 0) + 1;
  runtime.lastError = error ?? "failed";
  return runtime.consecutiveErrors;
}

/** Delay sau lỗi liên tiếp — tránh spam X. */
function backoffDelayMs(consecutiveErrors: number, settings: AgentSettings): number {
  if (settings.adaptiveRest !== false && consecutiveErrors > 0) return adaptiveErrorDelay(consecutiveErrors);
  if (consecutiveErrors >= 6) return randomBetween(180, 300) * 1000;
  if (consecutiveErrors >= 3) return randomBetween(90, 150) * 1000;
  return randomBetween(settings.delaySecMin, settings.delaySecMax) * 1000;
}

export interface RunnerDeps {
  settings: AgentSettings;
  runtime: AgentRuntime;
  stats: AgentDailyStats;
  queue: AgentQueueState;
  appendActivity: (level: "info" | "action" | "warn" | "error", message: string) => Promise<unknown>;
  isCancelled?: () => boolean;
  persistQueue: (q: AgentQueueState) => Promise<void>;
  persistStats: (s: AgentDailyStats) => Promise<void>;
  extensionId: string;
  waitForDelay?: (ms: number) => Promise<void>;
  onProgress?: (runtime: AgentRuntime) => Promise<void>;
  pullPogo?: typeof pullPogoWhenEmpty;
}

export interface RunnerTickResult {
  runtime: AgentRuntime;
  stats: AgentDailyStats;
  queue: AgentQueueState;
  nextDelayMs: number;
}

type JobOutcome = {
  ok: boolean;
  error?: string;
  detail?: string;
  draftText?: string;
  message: string;
  navigating?: boolean;
  skipped?: boolean;
  configurationError?: boolean;
};

function aiFailure(result: Extract<AiGenerateResult, { ok: false }>, preservePogo = true): JobOutcome {
  if (!preservePogo && ["reply_quality_failed", "reply_grounding_failed", "source_text_missing", "reply_context_invalid"].includes(result.error)) {
    return { ok: true, skipped: true, error: result.error, message: `Bỏ nội dung chưa đạt kiểm tra: ${result.detail || result.error}. Không gọi AI lại.` };
  }
  return {
    ok: false,
    error: result.detail ? `${result.error}: ${result.detail}` : result.error,
    message: "AI không soạn được nội dung",
    configurationError: result.configurationError,
  };
}

async function isLockedPogoJob(job: AgentJob): Promise<boolean> {
  if (job.source !== "pogo" || !job.tweetId) return false;
  const campaign = (await loadPogoCampaigns()).find((c) => c.tweet_id === job.tweetId);
  return campaign != null && isCampaignLocked(campaign);
}

async function isBlockedByPogoLock(job: AgentJob, settings: AgentSettings): Promise<boolean> {
  return !(job.kind === "follow" && settings.actions.follow) && await isLockedPogoJob(job);
}

function lockedOutcome(): JobOutcome {
  return { ok: true, skipped: true, error: "campaign_locked", message: "Bỏ qua task Pogo Locked — chưa đủ điều kiện nhận điểm" };
}

function progressWriter(source: AgentJob["source"] | undefined): typeof writePogoProgress {
  return (...args) => source === "pogo" ? writePogoProgress(...args) : Promise.resolve();
}

export async function runAgentTick(deps: RunnerDeps): Promise<RunnerTickResult> {
  if (deps.isCancelled?.() || deps.runtime.killSwitch || deps.runtime.status === "paused" || deps.runtime.status === "error") return { runtime: deps.runtime, stats: deps.stats, queue: deps.queue, nextDelayMs: 0 };
  const started = Date.now();
  const loopBefore = deps.runtime.loopCount;
  if (deps.settings.adaptiveRest !== false) {
    deps.runtime.adaptiveRest = readAdaptiveRest(deps.runtime.adaptiveRest, started);
    const rest = deps.runtime.adaptiveRest;
    if (!deps.isCancelled?.() && rest.resumeAt != null && rest.resumeAt > started) {
      deps.runtime.status = "waiting";
      deps.runtime.detail = `Đang nghỉ · ${restReasonLabel(rest.reason)} · tự tiếp tục; quản lý phiên vẫn hoạt động.`;
      return { runtime: deps.runtime, stats: deps.stats, queue: deps.queue, nextDelayMs: rest.resumeAt - started };
    }
  } else {
    deps.runtime.adaptiveRest = undefined;
  }
  const release = await acquireXTurn("agent", () => deps.isCancelled?.() === true);
  if (!release) {
    if (!deps.isCancelled?.()) {
      deps.runtime.status = "paused";
      deps.runtime.detail = "Đã dừng Agent: hãy dừng chế độ đang dùng tab X trước khi bật lại.";
    }
    return { runtime: deps.runtime, stats: deps.stats, queue: deps.queue, nextDelayMs: 0 };
  }
  try {
    const result = await runAgentTickOwned(deps);
    if (deps.settings.adaptiveRest !== false && result.nextDelayMs > 0 && !deps.isCancelled?.() && result.runtime.status !== "paused" && result.runtime.status !== "error") {
      const now = Date.now();
      const rest = result.runtime.adaptiveRest ?? readAdaptiveRest(undefined, now);
      if (!(rest.resumeAt != null && rest.resumeAt > now)) {
        if (result.runtime.consecutiveErrors > 0) {
          result.runtime.adaptiveRest = waitForRest(rest, "errors", now + result.nextDelayMs, now);
        } else if (result.runtime.loopCount > loopBefore) {
          const units = (["reply", "quote", "retweet", "follow", "like", "scrollSessions"] as const).reduce((sum, key) => sum + Math.max(0, result.stats[key] - deps.stats[key]), 0);
          result.runtime.adaptiveRest = recordActiveWork(rest, now - started, result.nextDelayMs, now, units);
        }
      }
    }
    return result;
  } finally { release(); }
}

function scheduledWait(deps: RunnerDeps, runtime: AgentRuntime, reason: RestReason, delay: number): AgentRuntime {
  if (deps.settings.adaptiveRest === false) return runtime;
  return { ...runtime, adaptiveRest: waitForRest(runtime.adaptiveRest ?? readAdaptiveRest(undefined, Date.now()), reason, Date.now() + delay, Date.now()) };
}

async function idleDelay(deps: RunnerDeps, queue: AgentQueueState, desired?: number): Promise<number> {
  if (deps.settings.adaptiveRest === false) return 30000;
  const now = Date.now();
  const clock = await loadPogoSettlementClock(getXConnection().handle || deps.settings.ownHandle || "unknown");
  let delay = desired != null ? Math.max(1000, desired - now) : idlePogoDelay(clock?.nextScanAt, now);
  // A due settlement receipt wakes the agent earlier than an empty-feed poll.
  for (const job of queue.jobs) {
    if (job.kind === "post_reply" || !job.pogoVerify || job.verification === "pogo_recorded" || job.verification === "blocked") continue;
    const first = pogoSettlementCheckAt(job.pogoVerify.submittedAt ?? job.updatedAt, clock);
    const at = job.pogoVerify.attempts === 0 ? first : Math.max(first, job.pogoVerify.nextCheckAt);
    if (at > now) delay = Math.min(delay, at - now);
  }
  return Math.max(1000, delay);
}

async function runAgentTickOwned(deps: RunnerDeps): Promise<RunnerTickResult> {
  const { settings, appendActivity } = deps;
  let { runtime, stats, queue } = deps;
  const cancelled = () => deps.isCancelled?.() === true;
  if (cancelled()) return { runtime, stats, queue, nextDelayMs: 0 };
  const pageDelay = settings.executeActions ? await xPageRetryDelay() : 0;
  if (pageDelay > 0) return { runtime: scheduledWait(deps, { ...runtime, detail: "X tải chậm nhiều lần — tạm nghỉ, không mở thêm link." }, "errors", pageDelay), stats, queue, nextDelayMs: pageDelay };

  let x = getXConnection();
  if (anyBrowseModuleOn(settings) || settings.executeActions) {
    if (!x.connected) {
      // SW MV3 ngủ → mất port trong memory. Nudge / inject lại content script trên tab X còn mở.
      const ensured = await ensureXTabsConnected(6000);
      x = getXConnection();
      if (!x.connected) {
        if (ensured.openTabs > 0) {
          runtime.detail = "Tab X đang mở nhưng chưa kết nối — đang thử lại; nếu kéo dài hãy F5 x.com.";
          if (runtime.lastError !== "x_tab_disconnected") {
            runtime.lastError = "x_tab_disconnected";
            await appendActivity("warn", runtime.detail);
          }
        } else {
          runtime.detail = "Chưa có tab X — mở x.com hoặc bấm Start / Mở X Home.";
          if (runtime.lastError !== "no_x_tab") {
            runtime.lastError = "no_x_tab";
            await appendActivity("warn", "Chưa có tab X — bỏ qua tick thực thi.");
          }
        }
        return {
          runtime,
          stats,
          queue,
          nextDelayMs: randomBetween(settings.delaySecMin, settings.delaySecMax) * 1000,
        };
      }
      if (runtime.lastError === "no_x_tab" || runtime.lastError === "x_tab_disconnected") {
        await appendActivity("info", "Đã kết nối lại tab X.");
      }
    }
    runtime.mockMode = false;
    if (runtime.lastError === "no_x_tab" || runtime.lastError === "x_tab_disconnected") {
      runtime.lastError = null;
    }
  }

  let campaigns = await loadPogoCampaigns();
  if (settings.executeActions && (x.accountBlock || x.loggedIn === false || /\/account\/access(?:[/?#]|$)|\/i\/flow\/login(?:[/?#]|$)/.test(x.url || ""))) {
    runtime.status = "paused";
    runtime.lastError = "x_account_requires_attention";
    runtime.detail = "X yêu cầu đăng nhập hoặc xác minh tài khoản — cần xử lý thủ công rồi bấm Bắt đầu.";
    await appendActivity("error", runtime.detail);
    return { runtime, stats, queue, nextDelayMs: 0 };
  }
  let pogoLoginRequired = await pogoSessionRequiresLogin();
  stats = { ...stats, pogoRetweets: await loadPogoRetweetPower(x.handle || settings.ownHandle || "unknown") };
  const linkCampaigns = settings.modules.linkList ? await loadLinkCampaigns() : [];
  const ai = await loadAiSettings(deps.extensionId);
  const hasApiKey = ai.apiKey.trim().length > 0;
  const notifCooldown = notificationCooldownMs(settings.notificationCooldownMin);
  runtime.notificationBatch = observeNotificationBatch(runtime.notificationBatch, x.handle || settings.ownHandle || "", x.notificationCount, Date.now(), notifCooldown);
  if (runtime.browseVisit && !enabledBrowseSurfaces(settings).includes(runtime.browseVisit.surface)) runtime.browseVisit = undefined;
  const tickNow = Date.now();
  runtime.browseRotation = resolveBrowseRotation(runtime, settings, tickNow);
  if (runtime.browseRotation.phase === "scanning" || runtime.browseRotation.phase === "switch_pending") {
    runtime.browseRotation = tickScanClock(runtime.browseRotation, tickNow);
  }
  if (runtime.browseRotation.phase === "error") {
    // Tạm dừng Feed Rotation; Pogo/list link vẫn chạy nếu còn việc.
    if (!settings.modules.pogoTasks && !settings.modules.linkList) {
      runtime.detail = `Feed Rotation lỗi điều hướng: ${runtime.browseRotation.error || "unknown"} — Pause rồi Start lại.`;
    }
  }
  let notificationQueueChanged = false;
  for (const job of queue.jobs) {
    if (job.browseSurface === "mentions" && job.kind === "draft_reply" && !job.notificationBatchId && (job.status === "pending" || job.status === "running")) {
      queue = markJob(queue, job.id, { status: "skipped", error: "notification_policy_changed" }); notificationQueueChanged = true;
    }
  }
  if (notificationQueueChanged) await deps.persistQueue(queue);
  const pendingNotificationDraft = queue.jobs.some(job => job.browseSurface === "mentions" &&
    (job.kind === "draft_reply" || (job.kind === "post_reply")) && !!job.notificationBatchId &&
    job.expectedAccount?.toLowerCase() === (x.handle || settings.ownHandle || "").toLowerCase() && (job.status === "pending" || job.status === "running"));
  if (runtime.notificationBatch.needsExit && !runtime.notificationBatch.active && (!pendingNotificationDraft || !settings.modules.notifications || !settings.actions.reply || !hasApiKey)) {
    const surface = returnBrowseSurface(runtime, settings);
    const restored = await requestScrollBurst({ browseSurface: surface, listUrl: settings.listUrlOrName,
      distancePx: 0, steps: 1, stepDelayMs: 100, readMs: 0, restoreNotificationPosition: true });
    if (cancelled()) return { runtime, stats, queue, nextDelayMs: 0 };
    if (!restored.ok) return { runtime: { ...runtime, detail: `Đang quay lại ${browseSurfaceLabel(surface)} sau thông báo · ${restored.error || "chờ tải"}` }, stats, queue, nextDelayMs: 3000 };
    runtime.notificationReturn = undefined;
    runtime.browseVisit = undefined;
    runtime.notificationBatch = { ...runtime.notificationBatch, needsExit: false, nextEligibleAt: Math.max(runtime.notificationBatch.nextEligibleAt, Date.now() + notifCooldown) };
    if (runtime.browseRotation.currentSource === surface) runtime.browseRotation = resumeScanClock(runtime.browseRotation, Date.now());
    return { runtime: { ...runtime, detail: `Đã xong thông báo · tiếp tục ${browseSurfaceLabel(surface)}` }, stats, queue, nextDelayMs: 2000 };
  }
  if (cancelled()) return { runtime, stats, queue, nextDelayMs: 0 };
  if (settings.executeActions && allDailyTargetsReached(settings, stats)) {
    await notifyTelegram("daily_target_reached", { account: x.handle || settings.ownHandle });
    if (settings.dailyTargets?.afterReached === "pause" || !anyBrowseModuleOn(settings)) {
      if (settings.continuousRun !== false) {
        const nextDay = Date.parse(`${todayKey(new Date(Date.now()))}T00:00:00+07:00`) + 86400000;
        runtime.status = "waiting";
        runtime.detail = "Đã đủ mục tiêu hôm nay — chờ 00:00 giờ Việt Nam để tự chạy tiếp.";
        const delay = Math.max(1000, nextDay - Date.now());
        return { runtime: scheduledWait(deps, runtime, "daily_goal", delay), stats, queue, nextDelayMs: delay };
      }
      runtime.status = "paused"; runtime.detail = "Đã đủ mục tiêu hôm nay — dừng agent.";
      await appendActivity("info", runtime.detail);
      return { runtime, stats, queue, nextDelayMs: 0 };
    }
    if (!anyFeedRotationOn(settings) || runtime.browseRotation.phase === "error") {
      return { runtime: { ...runtime, detail: "Đã đủ mục tiêu hôm nay · chờ nguồn lướt sẵn sàng, không mở thêm nguồn." }, stats, queue, nextDelayMs: 30000 };
    }
    if (runtime.browseRotation.phase === "waiting_round") {
      runtime.browseRotation = ensureFeedRotation(
        clearExhaustedRound(runtime.browseRotation),
        settings,
        { now: Date.now(), preferred: runtime.lastBrowseSurface },
      );
    }
    if (runtime.browseRotation.pendingSwitch && !runtime.browseVisit) {
      runtime.browseRotation = switchToNextSource(runtime.browseRotation, settings, {
        reason: runtime.browseRotation.emptyScrolls >= 3 ? "empty_content" : "time_elapsed",
        cooldowns: runtime.browseCooldowns,
        now: Date.now(),
      });
    }
    const surface = activeFeedSource(runtime.browseRotation);
    if (!surface) return { runtime: { ...runtime, detail: "Đã đủ mục tiêu hôm nay · chờ nguồn lướt sẵn sàng, không mở thêm nguồn." }, stats, queue, nextDelayMs: 30000 };
    runtime.lastBrowseSurface = surface;
    const job = makeJob({ kind: "scroll_home", source: "browse", browseSurface: surface, tweetId: null, tweetUrl: null, authorHandle: null, tweetText: null,
      reason: "Đã đủ mục tiêu hôm nay · chỉ lướt, không tương tác" });
    return finishBrowseVisit(deps, job, await runSingleJob(deps, job, ai, runtime, stats, queue));
  }

  // Behavior tắt / Reply đã recorded / Like lẻ → bỏ trước khi plan (tránh 3 job treo).
  let queueDirty = false;
  for (const job of queue.jobs) {
    if (job.kind === "post_reply" && job.pogoVerify) {
      queue = markJob(queue, job.id, { pogoVerify: undefined });
      queueDirty = true;
    }
    if (job.kind === "post_reply" && job.status === "skipped" && job.error === "reply_identity_missing") {
      queue = markJob(queue, job.id, { status: "pending", error: null, verification: undefined, pogoVerify: undefined });
      queueDirty = true;
    }
    if ((job.source === "pogo" || job.source === "manual") && ["pending", "running"].includes(job.status) &&
        isOwnPost(settings.ownHandle || x.handle, job.authorHandle, job.tweetUrl)) {
      queue = markJob(queue, job.id, { status: "skipped", error: "own_post", verification: undefined, pogoVerify: undefined });
      queueDirty = true;
    }
    if (job.kind === "retweet" && (job.source === "manual" || (job.source === "browse" && !settings.homeRetweet)) && ["pending", "running"].includes(job.status)) {
      queue = markJob(queue, job.id, { status: "skipped", error: job.source === "browse" ? "home_retweet_disabled" : "retweet_pogo_only" });
      queueDirty = true;
    }
  }
  const prunedLocked = pruneLockedPogoJobs(queue, campaigns.filter(isCampaignLocked).map((c) => c.tweet_id), settings.actions.follow);
  if (prunedLocked.skipped) {
    queue = prunedLocked.queue;
    queueDirty = true;
    await appendActivity("info", `Đã bỏ ${prunedLocked.skipped} việc từ task Pogo Locked (chưa đủ điều kiện nhận điểm).`);
  }
  const recordedIds = campaigns
    .filter((c) => c.actions.reply.status === "recorded")
    .map((c) => c.tweet_id);
  const prunedDone = pruneJobsForRecordedReplies(queue, recordedIds);
  if (prunedDone.skipped > 0) {
    queue = prunedDone.queue;
    queueDirty = true;
  }
  for (const state of ["submitted", "confirmed", "uncertain", "blocked"] as const) {
    const handled = campaigns.filter((c) => c.actions.reply.local?.state === state).map((c) => c.tweet_id);
    const localPruned = pruneJobsForRecordedReplies(queue, handled, "reply_already_handled",
      state === "confirmed" ? "x_confirmed" : state === "blocked" ? "blocked" : state === "submitted" ? "submitted" : "uncertain");
    if (localPruned.skipped) { queue = localPruned.queue; queueDirty = true; }
  }
  const pruned = pruneDisabledActionJobs(queue, settings.actions);
  if (pruned.skipped > 0) {
    queue = pruned.queue;
    queueDirty = true;
  }
  for (const j of queue.jobs) {
    if (j.status !== "pending" && j.status !== "running") continue;
    if (
      (j.kind === "post_reply" || j.kind === "post_quote") &&
      !(j.draftText && j.draftText.trim())
    ) {
      const draftKind = j.kind === "post_reply" ? "draft_reply" : "draft_quote";
      const filled = attachDraftText(queue, j);
      if (filled) {
        queue = filled;
        queueDirty = true;
        continue;
      }
      // Đang soạn draft cùng tweet → giữ post, bundle/tick sau sẽ gắn text.
      const drafting = queue.jobs.some(
        (d) =>
          d.kind === draftKind &&
          d.tweetId === j.tweetId &&
          (d.status === "pending" || d.status === "running"),
      );
      if (drafting) continue;
      // Không có draft và không đang soạn — bỏ orphan (tránh treo forever).
      queue = markJob(queue, j.id, { status: "skipped", error: "no_draft_text" });
      queueDirty = true;
    }
  }
  if (queueDirty) {
    await deps.persistQueue(queue);
    await appendActivity(
      "info",
      prunedDone.skipped > 0
        ? `Dọn queue: bỏ ${prunedDone.skipped} job vì Reply đã xong (không soạn lại).`
        : "Dọn queue: tắt action / Like lẻ / gắn draft / orphan.",
    );
  }

  // Reconcile server evidence independently of whether the job queue says done/skipped.
  for (const j of queue.jobs) {
    const kind = j.kind === "post_reply" ? "reply" : j.kind === "post_quote" ? "quote" : j.kind === "retweet" ? "retweet" : null;
    if (j.source !== "pogo" || !kind) continue;
    const campaign = campaigns.find((c) => c.tweet_id === j.tweetId);
    if (campaign?.actions[kind].status === "recorded") {
      const open = j.status === "pending" || j.status === "running";
      if (!open && j.verification === "pogo_recorded") continue;
      queue = markJob(queue, j.id, { verification: "pogo_recorded",
        ...(open ? { status: "skipped", error: "pogo_already_recorded" } : {}) });
      await deps.persistQueue(queue);
      if (j.verification !== "pogo_recorded") await appendActivity("info", `[pogo] @${j.authorHandle ?? "?"} #${j.tweetId} · ${kind} · Pogo đã ghi nhận.`);
    }
  }

  const pendingUnlock = !pogoLoginRequired && settings.executeActions && settings.actions.follow && settings.modules.pogoTasks && settings.priority !== "browse_only"
    ? queue.jobs.find((j) => j.source === "pogo" && j.kind === "follow" && j.pogoUnlock?.state === "pending") : null;
  if (pendingUnlock) {
    const result = await checkAndRefreshPogoUnlock(deps, pendingUnlock, queue);
    runtime.detail = result.unlocked ? "Pogo đã mở khóa task — tiếp tục ở lượt kế tiếp." : "Đã kết thúc lượt chờ mở khóa Pogo.";
    return { runtime, stats, queue: result.queue, nextDelayMs: cancelled() ? 0 : 2000 };
  }

  if (!pogoLoginRequired && settings.executeActions && settings.modules.pogoTasks && settings.priority !== "browse_only") {
    const clock = await loadPogoSettlementClock(x.handle || settings.ownHandle || "unknown");
    const due: AgentJob[] = [];
    let rescheduled = false;
    for (const j of queue.jobs) {
      if (j.kind === "post_reply" || j.source !== "pogo" || !j.pogoVerify || j.verification === "pogo_recorded" || j.verification === "blocked") continue;
      const submittedAt = j.pogoVerify.submittedAt ?? j.updatedAt;
      const earliest = pogoSettlementCheckAt(submittedAt, clock);
      const nextCheckAt = j.pogoVerify.attempts === 0 ? earliest : Math.max(earliest, j.pogoVerify.nextCheckAt);
      const progress = { ...j.pogoVerify, submittedAt, nextCheckAt };
      if (j.pogoVerify.submittedAt == null || j.pogoVerify.nextCheckAt !== nextCheckAt) {
        queue = markJob(queue, j.id, { pogoVerify: progress }); rescheduled = true;
      }
      if (nextCheckAt <= Date.now()) due.push({ ...j, pogoVerify: progress });
    }
    if (rescheduled) await deps.persistQueue(queue);
    if (cancelled()) return { runtime, stats, queue, nextDelayMs: 0 };
    if (due.length) {
      queue = await verifyPogoBatch(deps, due, queue);
      if (cancelled()) return { runtime, stats, queue, nextDelayMs: 0 };
      campaigns = await loadPogoCampaigns();
      pogoLoginRequired = await pogoSessionRequiresLogin();
    }
  }

  const listFollowSurfacesOn =
    settings.modules.following &&
    (settings.modules.homeScroll || settings.modules.followingFeed) &&
    settings.executeActions;
  const followSettings = listFollowSurfacesOn ? await loadFollowSettings() : null;
  const followedHandles = followSettings ? await loadFollowHistory(x.handle || settings.ownHandle || "") : new Set<string>();
  // Feed Rotation: xử lý chờ vòng mới / chuyển nguồn trước khi plan (không khi đang xử lý bài).
  if (anyFeedRotationOn(settings) && runtime.browseRotation.phase !== "error") {
    if (runtime.browseRotation.phase === "waiting_round") {
      runtime.detail = "Các nguồn tạm hết bài mới · chờ lượt quét tiếp theo, không chuyển tab liên tục.";
      // Cho phép notifications nếu đủ điều kiện; nếu không thì nghỉ ngắn rồi mở vòng mới.
      if (!(settings.executeActions && settings.actions.reply && hasApiKey && notificationBatchCanOpen(runtime.notificationBatch, x.notificationCount))) {
        runtime.browseRotation = ensureFeedRotation(clearExhaustedRound(runtime.browseRotation), settings, {
          now: Date.now(), preferred: runtime.lastBrowseSurface,
        });
        return { runtime: scheduledWait(deps, runtime, "no_tasks", 30000), stats, queue, nextDelayMs: 30000 };
      }
    } else if (
      runtime.browseRotation.pendingSwitch &&
      !queue.jobs.some((j) => j.source === "browse" && j.browseSurface === activeFeedSource(runtime.browseRotation) &&
        j.kind !== "scroll_home" && !j.likeOnFeed && ["pending", "running"].includes(j.status) && !dailyActionReached(settings, stats, j.kind))
    ) {
      const leaving = activeFeedSource(runtime.browseRotation);
      runtime.browseVisit = undefined;
      const reason = runtime.browseRotation.emptyScrolls >= 3 ? "empty_content" as const : "time_elapsed" as const;
      runtime.browseRotation = switchToNextSource(runtime.browseRotation, settings, {
        reason, cooldowns: runtime.browseCooldowns, now: Date.now(),
      });
      const next = activeFeedSource(runtime.browseRotation);
      if (runtime.browseRotation.phase === "waiting_round") {
        runtime.detail = "Tất cả nguồn đã hết bài mới trong vòng này · chờ rồi quét lại.";
        await appendActivity("info", runtime.detail);
        return { runtime: scheduledWait(deps, runtime, "no_tasks", 30000), stats, queue, nextDelayMs: 30000 };
      }
      if (next && next !== leaving) {
        await appendActivity("info", `[${feedSurfaceLabel(next)}] Chuyển nguồn · ${reason === "empty_content" ? "hết bài mới" : "hết thời gian quét"} · bỏ ${leaving ? feedSurfaceLabel(leaving) : "?"}.`);
      }
    }
  }
  const rotationSurface = activeFeedSource(runtime.browseRotation);
  const inFeedSession = feedRotationBlocksNotifications(runtime.browseRotation) || !!runtime.browseVisit;
  const notificationSafe = !queue.jobs.some(job => job.browseSurface !== "mentions" && job.kind !== "scroll_home" &&
    !job.postFollow && ["pending", "running"].includes(job.status) && !dailyActionReached(settings, stats, job.kind));
  const notificationDue = settings.modules.notifications && settings.executeActions && settings.actions.reply && hasApiKey &&
    !dailyActionReached(settings, stats, "post_reply") && (runtime.notificationBatch.active || notificationSafe) &&
    notificationBatchCanOpen(runtime.notificationBatch, x.notificationCount);
  const planningInput = {
    settings: pogoLoginRequired ? { ...settings, modules: { ...settings.modules, pogoTasks: false } } : settings,
    stats,
    queue: pogoLoginRequired ? { jobs: queue.jobs.filter(job => job.source !== "pogo") } : queue,
    campaigns: pogoLoginRequired ? [] : campaigns,
    linkCampaigns,
    followListHandles: followSettings ? parseHandleList(followSettings.usernameList).filter(handle => !followedHandles.has(handle.toLowerCase())) : [],
    followFilters: followSettings?.filters ?? null,
    executeActions: settings.executeActions,
    ownHandle: settings.ownHandle || x.handle,
    hasApiKey,
    browseCooldowns: runtime.browseCooldowns,
    notificationsAllowed: notificationDue,
    // Chỉ ép surface khi đang trong phiên quét; nếu không, để planner ưu tiên Notifications khi được phép.
    browseSurface: notificationDue
      ? "mentions" as const
      : runtime.browseVisit?.surface ?? (inFeedSession ? rotationSurface : null),
  };
  let planned = planNextAction(planningInput);
  // At a safe boundary, due Notifications may interrupt the scanning clock,
  // including a long feed session or a steady stream of new Pogo tasks.
  if (notificationDue && notificationSafe && settings.priority !== "pogo_only" && !pendingNotificationDraft) {
    planned = { type: "job", job: makeJob({ kind: "scroll_home", source: "browse", browseSurface: "mentions", tweetId: null, authorHandle: null, tweetUrl: null, tweetText: null, reason: "Đến lịch kiểm tra thông báo" }) };
  }
  const isPogoWork = (plan: typeof planned) => plan.type === "bundle" ? plan.jobs[0]?.source === "pogo" : plan.type === "job" && plan.job.source === "pogo";
  const isManualWork = (plan: typeof planned) => plan.type === "bundle" ? plan.jobs[0]?.source === "manual" : plan.type === "job" && plan.job.source === "manual";
  if (deps.pullPogo && settings.modules.pogoTasks && settings.priority !== "browse_only" && settings.executeActions &&
      !isPogoWork(planned) && !isManualWork(planned) && !(planned.type === "idle" && planned.reason.includes("missing_api_key"))) {
    const pulled = await deps.pullPogo(cancelled);
    if (cancelled()) return { runtime, stats, queue, nextDelayMs: 0 };
    if (pulled.campaigns) planned = planNextAction({ ...planningInput, campaigns: pulled.campaigns });
    if (planned.type === "idle" && pulled.kind === "login_required")
      return { runtime: scheduledWait(deps, { ...runtime, detail: "Phiên Pogo hết hạn — giữ hàng đợi; đang chờ tự cấp lại phiên Telegram." }, "session", 60000), stats, queue, nextDelayMs: 60000 };
    if (planned.type === "idle") {
      const detail = pulled.kind === "no_token" ? "Chưa có phiên Pogo — kiểm tra kết nối Telegram ở tab Nguồn."
        : pulled.kind === "failed" ? "Chưa tải được task Pogo — đang giãn nhịp thử lại."
          : "Pogo chưa có việc phù hợp — chờ rồi pull đợt tiếp theo.";
      const reason = pulled.kind === "no_token" ? "session" : pulled.waitReason || (pulled.kind === "failed" ? "errors" : "no_tasks");
      const delay = reason === "session" ? 60000 : reason === "errors" ? Math.max(1000, (pulled.retryAt ?? Date.now() + 60000) - Date.now()) : await idleDelay(deps, queue, pulled.retryAt);
      return { runtime: scheduledWait(deps, { ...runtime, detail }, reason, delay), stats, queue, nextDelayMs: delay };
    }
  }

  if (planned.type !== "idle" && settings.adaptiveRest !== false) {
    const open = campaigns.filter(c => !c.stale && (["reply", "retweet", "quote"] as const).some(kind => settings.actions[kind] && c.actions[kind].status === "not_recorded"));
    const backlog = new Set([...open.map(c => c.tweet_id), ...queue.jobs.filter(j => j.status === "pending" || j.status === "running").map(j => j.tweetId || j.id)]).size;
    const rest = periodicRest(runtime.adaptiveRest ?? readAdaptiveRest(undefined, Date.now()), backlog, Date.now());
    runtime.adaptiveRest = rest;
    if (rest.resumeAt != null && rest.resumeAt > Date.now()) {
      runtime.status = "waiting";
      runtime.detail = `Đang nghỉ · ${restReasonLabel(rest.reason)} · tự tiếp tục; quản lý phiên vẫn hoạt động.`;
      if (runtime.browseRotation) runtime.browseRotation = pauseScanClock(runtime.browseRotation, Date.now());
      return { runtime, stats, queue, nextDelayMs: rest.resumeAt - Date.now() };
    }
    runtime.adaptiveRest = { ...rest, waitStartedAt: null };
  }

  // Resume queued work and honor source priority before a scan can navigate.
  // Only a new browse interaction needs fresh timeline candidates.
  const selectedJob = planned.type === "bundle" ? planned.jobs[0] : planned.type === "job" ? planned.job : undefined;
  if (selectedJob?.browseSurface === "mentions" && !runtime.notificationReturn) runtime.notificationReturn = returnBrowseSurface(runtime, settings);
  if (selectedJob?.source === "browse" && selectedJob.browseSurface && selectedJob.browseSurface !== "mentions") {
    runtime.lastBrowseSurface = selectedJob.browseSurface;
    if (runtime.browseRotation.phase === "paused") {
      runtime.browseRotation = resumeScanClock(runtime.browseRotation, Date.now());
    }
  }
  if (selectedJob?.browseSurface === "mentions" || selectedJob?.source !== "browse") {
    if (runtime.browseRotation.currentSource || runtime.browseRotation.phase === "scanning" || runtime.browseRotation.phase === "switch_pending") {
      runtime.browseRotation = pauseScanClock(runtime.browseRotation, Date.now());
    }
  }
  if (isProcessingBrowsePost(selectedJob)) {
    runtime.browseRotation = pauseScanClock(runtime.browseRotation, Date.now());
  }
  let scannedFeedSurface: BrowseSurface | undefined;
  if (
    planned.type === "job" && planned.job.kind === "scroll_home" && settings.executeActions
  ) {
    const surface = (planned.job.browseSurface ?? "home") as BrowseSurface;
    if (surface === "mentions") {
      const fresh = getXConnection();
      runtime.notificationBatch = observeNotificationBatch(runtime.notificationBatch, fresh.handle || settings.ownHandle || "", fresh.notificationCount, Date.now(), notifCooldown);
      if (!notificationBatchCanOpen(runtime.notificationBatch, fresh.notificationCount)) {
        runtime.detail = "Chờ số thông báo mới trên X · không mở Notifications.";
        return { runtime, stats, queue, nextDelayMs: 10000 };
      }
      runtime.notificationBatch = startNotificationBatch(runtime.notificationBatch);
      await deps.onProgress?.(runtime);
    }
    const scan = await requestTimelineScan({
      browseSurface: surface,
      listUrl: settings.listUrlOrName ?? null,
      ownHandle: settings.ownHandle || x.handle,
      ...(surface === "mentions" ? { notificationTab: runtime.notificationBatch.scanTab ?? "mentions", notificationScroll: (runtime.notificationBatch.scanPass ?? 0) > 0 } : {}),
    });
    if (cancelled()) return { runtime, stats, queue, nextDelayMs: 0 };
    if (scan.ok) {
      runtime.browseVisit = undefined;
      if (surface === "mentions") {
        const scanned = sanitizeTimelineTweets(scan.tweets), fresh = getXConnection();
        runtime.notificationBatch = observeNotificationBatch(runtime.notificationBatch, fresh.handle || settings.ownHandle || "", fresh.notificationCount, Date.now(), notifCooldown);
        const before = runtime.notificationBatch.candidates ?? [];
        const merged = sanitizeTimelineTweets([...before, ...scanned]);
        runtime.notificationBatch.candidates = merged;
        const jobs = selectNotificationDrafts({ candidates: merged, settings, queue, account: fresh.handle || settings.ownHandle || "", seenIds: runtime.notificationBatch.seenIds,
          batchId: `${runtime.notificationBatch.account}:${runtime.notificationBatch.expiresAt}` });
        const tab = runtime.notificationBatch.scanTab ?? "mentions", pass = runtime.notificationBatch.scanPass ?? 0;
        const added = merged.length > before.length;
        if (jobs.length < 3 && ((added && pass < (tab === "mentions" ? 2 : 1)) || tab === "mentions")) {
          runtime.notificationBatch = { ...runtime.notificationBatch,
            scanTab: added && pass < (tab === "mentions" ? 2 : 1) ? tab : "all",
            scanPass: added && pass < (tab === "mentions" ? 2 : 1) ? pass + 1 : 0 };
          runtime.detail = `Thông báo: đã tìm ${merged.length} phản hồi/đề cập · tiếp tục ${runtime.notificationBatch.scanTab}`;
          return { runtime, stats, queue, nextDelayMs: 1000 };
        }
        for (const job of jobs) queue = upsertJob(queue, job);
        runtime.notificationBatch = finishNotificationBatch(runtime.notificationBatch, jobs.map(p => p.tweetId!).filter(Boolean), Date.now(), notifCooldown);
        await deps.persistQueue(queue);
        await appendActivity("info", `Thông báo: thấy ${merged.length} phản hồi/đề cập, chọn ${jobs.length}/3 hội thoại · tự đăng sau khi soạn.`);
        const returnSurface = returnBrowseSurface(runtime, settings);
        if (!jobs.length) return { runtime: { ...runtime, detail: `Thông báo không có hội thoại cần trả lời · quay lại ${browseSurfaceLabel(returnSurface)}` }, stats, queue, nextDelayMs: 1000 };
        planned = { type: "job", job: jobs[0] };
      } else {
        const scanned = sanitizeTimelineTweets(scan.tweets);
        scannedFeedSurface = surface;
        const schedule = browseScheduleOf(settings);
        if (surface === "home" || surface === "following" || surface === "lists") {
          if (runtime.browseRotation.targetSource !== surface && runtime.browseRotation.currentSource !== surface) {
            runtime.browseRotation = { ...runtime.browseRotation, targetSource: surface };
          }
          const wasNew = runtime.browseRotation.currentSource !== surface || runtime.browseRotation.phase === "navigating";
          runtime.browseRotation = confirmSourceReady(runtime.browseRotation, schedule, Date.now());
          runtime.browseRotation = noteEligibleScan(
            runtime.browseRotation,
            countConsiderableTweets(scanned, settings, queue, settings.ownHandle || x.handle),
          );
          if (wasNew) {
            await appendActivity("info", `[${feedSurfaceLabel(surface)}] Bắt đầu phiên quét ${Math.round(runtime.browseRotation.remainingScanTimeMs / 60000)} phút · hết giờ hoặc hết bài mới mới chuyển nguồn.`);
          }
        }
        planned = planNextAction({
          ...planningInput,
          browseSurface: surface,
          browseCandidates: scanned,
          mentionsBoost: 0,
        });
        if (isProcessingBrowsePost(planned.type === "bundle" ? planned.jobs[0] : planned.type === "job" ? planned.job : undefined)) {
          runtime.browseRotation = pauseScanClock(runtime.browseRotation, Date.now());
        }
      }
    } else if (feedWaitMessage(scan.error ?? "")) {
      runtime.browseVisit = { surface, rolls: { engage: true, like: false, reply: false, retweet: false, follow: false } };
      runtime.detail = feedWaitMessage(scan.error!)!;
      if (scan.error === "feed_recovery_cooldown") {
        runtime.browseCooldowns = { ...runtime.browseCooldowns, [surface]: Date.now() + 120000 };
        if (surface === "home" || surface === "following" || surface === "lists") {
          runtime.browseRotation = switchToNextSource(runtime.browseRotation, settings, {
            reason: "source_disabled", cooldowns: runtime.browseCooldowns, now: Date.now(),
          });
        }
        runtime.browseVisit = undefined;
        if (surface === "mentions") runtime.notificationBatch = finishNotificationBatch(runtime.notificationBatch, [], Date.now(), notifCooldown);
      } else {
        // Loading / network / DOM chưa sẵn — không coi là hết bài, không chuyển nguồn.
        runtime.browseRotation = pauseScanClock(runtime.browseRotation, Date.now());
      }
      await appendActivity("info", `[${browseSurfaceLabel(surface)}] ${runtime.detail}`);
      return { runtime, stats, queue, nextDelayMs: scan.error === "feed_recovery_cooldown" ? 30000 : 4000 };
    } else if (isBrowseNavigatingError(scan.error)) {
      runtime.browseVisit = { surface, rolls: { engage: true, like: false, reply: false, retweet: false, follow: false } };
      if (surface === "home" || surface === "following" || surface === "lists") {
        runtime.browseRotation = noteNavigationFailure(runtime.browseRotation, scan.error ?? "navigating");
        if (runtime.browseRotation.phase === "error") {
          runtime.detail = `Không chuyển được sang ${browseSurfaceLabel(surface)} — tạm dừng Feed Rotation.`;
          await appendActivity("error", runtime.detail);
          return { runtime, stats, queue, nextDelayMs: settings.modules.pogoTasks || settings.modules.linkList ? 5000 : 0 };
        }
      }
      const viaBack = (scan.error ?? "").endsWith("_back") || scan.detail === "history_back" || scan.detail === "back";
      const label = browseSurfaceLabel(surface);
      await appendActivity(
        "info",
        viaBack
          ? `Back về ${label} để quét timeline…`
          : `Mở ${label} qua tab/link X…`,
      );
      runtime.detail = viaBack ? `Back về ${label}…` : `Đang mở ${label}…`;
      return { runtime, stats, queue, nextDelayMs: randomBetween(2, 5) * 1000 };
    }
  }

  const resumableScroll = planned.type === "job" && planned.job.kind === "scroll_home"
    ? queue.jobs.find((j) => j.kind === "scroll_home" && (j.status === "pending" || j.status === "running")) : null;
  if (resumableScroll && planned.type === "job") planned = { type: "job", job: { ...resumableScroll, reason: planned.job.reason, browseSurface: planned.job.browseSurface } };
  let scrollQueueChanged = false;
  for (const j of queue.jobs) {
    if (j.kind !== "scroll_home" || (j.status !== "pending" && j.status !== "running") || j.id === resumableScroll?.id) continue;
    queue = markJob(queue, j.id, { status: "skipped", error: "scroll_superseded" });
    scrollQueueChanged = true;
  }
  if (scrollQueueChanged) await deps.persistQueue(queue);

  if (planned.type === "idle") {
    if (pogoLoginRequired && settings.modules.pogoTasks) return { runtime: scheduledWait(deps, { ...runtime, detail: "Phiên Pogo hết hạn — giữ hàng đợi; đang chờ kết nối Telegram." }, "session", 60000), stats, queue, nextDelayMs: 60000 };
    runtime.detail = planned.reason === "pogo_tasks_locked_wait_for_unlock"
      ? "Task Pogo đang Locked — chờ Pogo xác nhận mở khóa rồi quét lại."
      : planned.reason === "browse_sources_cooling_down" ? "Các nguồn đang nghỉ phục hồi · chờ 30 giây, không chuyển trang hoặc reload liên tục."
      : planned.reason === "notifications_waiting_for_unread" ? `Chờ lịch kiểm tra thông báo ${settings.notificationCooldownMin ?? 60} phút.` : `Idle: ${planned.reason}`;
    if (planned.reason.includes("missing_api_key")) {
      await appendActivity("warn", "Chưa có AI API key — vào tab AI → Lưu key (GPT).");
    } else {
      await appendActivity("info", runtime.detail);
    }
    const delay = planned.reason === "browse_sources_cooling_down" ? 30000 : settings.adaptiveRest === false ? randomBetween(settings.delaySecMin, settings.delaySecMax) * 1000 : await idleDelay(deps, queue);
    return { runtime: scheduledWait(deps, runtime, "no_tasks", delay), stats, queue, nextDelayMs: delay };
  }

  runtime.status = "running";
  runtime.loopCount += 1;

  if (planned.type === "bundle") {
    const result = await runBundle(deps, planned.jobs, planned.tweetId, ai, runtime, stats, queue);
    return finishBrowseVisit(deps, planned.jobs[0], result, scannedFeedSurface);
  }

  const result = await runSingleJob(deps, planned.job, ai, runtime, stats, queue);
  return finishBrowseVisit(deps, planned.job, result, scannedFeedSurface);
}

async function finishBrowseVisit(deps: RunnerDeps, job: AgentJob, result: RunnerTickResult, scannedSurface?: BrowseSurface): Promise<RunnerTickResult> {
  const surface = job.browseSurface;
  if (job.source !== "browse" || !surface || deps.isCancelled?.() || result.nextDelayMs <= 0 || ["paused", "error"].includes(result.runtime.status) ||
      result.queue.jobs.some(j => j.source === "browse" && j.browseSurface === surface && (job.tweetId ? j.tweetId === job.tweetId : j.id === job.id) && ["pending", "running"].includes(j.status))) return result;
  if (job.kind.startsWith("draft_") &&
      !result.queue.jobs.some(j => j.tweetId === job.tweetId && ["post_reply", "post_quote"].includes(j.kind))) return result;
  const completed = result.queue.jobs.find(j => j.id === job.id);
  if (!completed || !["done", "skipped"].includes(completed.status)) return result;
  if (job.kind === "scroll_home" && completed.status !== "done") return result;

  const schedule = browseScheduleOf(deps.settings);
  let rot = result.runtime.browseRotation ?? resolveBrowseRotation(result.runtime, deps.settings, Date.now());
  const now = Date.now();
  const unit = job.tweetId || job.id;
  const feedSurface = surface === "home" || surface === "following" || surface === "lists" ? surface : null;

  if (feedSurface && (activeFeedSource(rot) === feedSurface || rot.phase === "navigating")) {
    if (rot.phase === "navigating" || rot.currentSource !== feedSurface) {
      rot = { ...rot, targetSource: feedSurface };
      rot = confirmSourceReady(rot, schedule, now);
      await deps.appendActivity("info", `[${feedSurfaceLabel(feedSurface)}] Bắt đầu phiên quét ${Math.round(rot.remainingScanTimeMs / 60000)} phút · hết giờ hoặc hết bài mới mới chuyển nguồn.`);
    }
    rot = tickScanClock(rot, now);
    if (job.kind === "scroll_home") {
      rot = noteScrollUnit(rot, {
        foundNew: rot.sawEligible === true,
        feedUnreliable: scannedSurface !== feedSurface,
        earlySwitchOnEmpty: schedule.earlySwitchOnEmpty,
        unitId: unit,
      });
      const remainMin = Math.max(0, Math.ceil(rot.remainingScanTimeMs / 60000));
      await deps.appendActivity("info", `[${feedSurfaceLabel(feedSurface)}] Còn ~${remainMin} phút quét · empty ${rot.emptyScrolls}/3${rot.pendingSwitch ? " · chờ chuyển nguồn." : "."}`);
    } else {
      rot = notePostUnit(rot, unit);
    }
  }
  result.runtime.browseRotation = rot;

  const hasAuthorFollow = result.queue.jobs.some(j => j.authorFollow && j.tweetId === job.tweetId && j.source === "browse");
  if (!deps.settings.executeActions || !job.tweetId || (job.likeOnFeed && !hasAuthorFollow) || job.kind === "scroll_home") {
    // Cuộn xong: nếu pendingSwitch và không còn bài đang xử lý → chuyển ở tick sau.
    if (job.kind === "scroll_home" && rot.pendingSwitch) {
      result.runtime.browseRotation = pauseScanClock(rot, now);
    } else if (job.kind === "scroll_home" && feedSurface) {
      result.runtime.browseRotation = resumeScanClock(rot, now);
    }
    return result;
  }
  const followedProfile = result.queue.jobs.find(j => j.kind === "follow" && j.source === "browse" && j.browseSurface === surface &&
    j.tweetId === job.tweetId && ["done", "skipped"].includes(j.status))?.authorHandle || undefined;
  const returned = await requestBackToBrowse({ browseSurface: surface, listUrl: deps.settings.listUrlOrName, tweetId: job.tweetId, followedProfile });
  if (deps.isCancelled?.() || returned.error === "stopped") return result;
  const label = browseSurfaceLabel(surface);
  result.runtime.browseVisit = undefined;
  if (returned.ok) await deps.appendActivity("info", returned.detail === "browse_back_already"
    ? `[${label}] Đã ở nguồn ban đầu · giữ nguyên trang.`
    : `[${label}] Đã bấm Back về chỗ vừa mở bài.`);
  else await deps.appendActivity("warn", `[${label}] Chưa Back được: ${returned.error || "unknown"}. Giữ nguyên trang, không mở lại đường dẫn.`);

  // Quay lại feed: tiếp tục đồng hồ còn lại; nếu hết giờ trong lúc xử lý bài thì đánh dấu chuyển.
  if (feedSurface) {
    let after = result.runtime.browseRotation ?? rot;
    after = rot.pendingSwitch || after.remainingScanTimeMs <= 0
      ? { ...after, pendingSwitch: true, phase: "switch_pending" as const, clockRunning: false, clockStartedAt: null }
      : resumeScanClock(after, Date.now());
    result.runtime.browseRotation = after;
  }
  return result;
}

async function runSingleJob(
  deps: RunnerDeps,
  jobIn: AgentJob,
  ai: AiSettings,
  runtime: AgentRuntime,
  stats: AgentDailyStats,
  queue: AgentQueueState,
  alreadyRead = false,
): Promise<RunnerTickResult> {
  const { settings, appendActivity } = deps;
  const markPogoProgress = progressWriter(jobIn.source);
  const cancelled = () => deps.isCancelled?.() === true;
  const rtPolicy = retweetPolicyError(jobIn, stats.pogoRetweets, settings.homeRetweet);
  if (rtPolicy) {
    queue = upsertJob(queue, { ...jobIn, status: rtPolicy === "pogo_retweet_window_full" ? "pending" : "skipped", error: rtPolicy });
    await deps.persistQueue(queue);
    return { runtime: { ...runtime, detail: rtPolicy === "home_retweet_disabled" ? "Đăng lại Home đang tắt." : rtPolicy === "retweet_pogo_only" ? "Không đăng lại từ list link." : "Đã hết lượt RT Pogo còn nhận thưởng trong khung — tiếp tục hành động khác." }, stats, queue, nextDelayMs: 2000 };
  }
  if (dailyActionReached(settings, stats, jobIn.kind)) {
    queue = upsertJob(queue, { ...jobIn, status: "pending", error: "daily_target_reached" });
    await deps.persistQueue(queue);
    runtime.detail = "Hành động đã đủ mục tiêu hôm nay — chuyển sang việc khác.";
    return { runtime, stats, queue, nextDelayMs: 2000 };
  }

  let job = { ...jobIn, status: "running" as const, updatedAt: Date.now() };
  runtime.detail = job.kind === "scroll_home"
    ? `Tìm bài tiếp theo · ${job.reason ?? "Cuộn Home"}`
    : `Đang chạy ${job.kind}…`;
  queue = upsertJob(queue, job);
  await deps.persistQueue(queue);
  await deps.onProgress?.(runtime);

  if (cancelled()) {
    queue = markJob(queue, job.id, { status: "pending", error: "stopped" });
    await deps.persistQueue(queue);
    return { runtime, stats, queue, nextDelayMs: 0 };
  }

  if (!job.likeOnFeed && (isTweetInteraction(job) || (job.kind.startsWith("draft_") && settings.executeActions)) && !alreadyRead) {
    if (await isBlockedByPogoLock(job, deps.settings)) return applyOutcome(deps, job, lockedOutcome(), runtime, stats, queue, false);
    runtime.detail = `Đang cuộn tới và đọc bài trước ${job.kind}…`;
    await appendActivity("info", runtime.detail);
    await deps.onProgress?.(runtime);
    const prepared = await prepareForJob(deps, job);
    if (prepared.ok) {
      job = withPreparedPost(job, prepared);
      queue = upsertJob(queue, job);
      await deps.persistQueue(queue);
    }
    if ((job.kind === "draft_reply" || job.kind === "post_reply") && prepared.ok && (prepared.detail === "already_replied" || prepared.detail === "reply_attempt_exists")) {
      const confirmed = prepared.detail === "already_replied";
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: confirmed ? "confirmed" : "uncertain" });
      return applyOutcome(deps, job, { ok: true, skipped: true, error: prepared.detail,
        message: confirmed ? "Đã thấy reply trên X — không soạn/gửi lại." : "Đã có lần gửi reply — bỏ qua để tránh trùng." }, runtime, stats, queue, false);
    }
    if (!prepared.ok) {
      if (cancelled()) {
        queue = markJob(queue, job.id, { status: "pending", error: "stopped" });
        await deps.persistQueue(queue);
        return { runtime, stats, queue, nextDelayMs: 0 };
      }
      return applyOutcome(deps, job, mapX(prepared, "Read post"), runtime, stats, queue, false);
    }
  }
  if (await isBlockedByPogoLock(job, deps.settings)) return applyOutcome(deps, job, lockedOutcome(), runtime, stats, queue, false);
  if (cancelled()) {
    queue = markJob(queue, job.id, { status: "pending", error: "stopped" });
    await deps.persistQueue(queue);
    return { runtime, stats, queue, nextDelayMs: 0 };
  }
  const outcome = await executeJob(job, settings, ai, appendActivity, deps, queue);
  const result = await applyOutcome(deps, job, outcome, runtime, stats, queue, false);
  await deps.onProgress?.(result.runtime);
  return result;
}

async function pacingWait(deps: RunnerDeps, ms: number): Promise<boolean> {
  let remaining = ms;
  while (remaining > 0) {
    if (deps.isCancelled?.()) return false;
    const chunk = Math.min(250, remaining);
    await (deps.waitForDelay ?? sleep)(chunk);
    remaining -= chunk;
  }
  return deps.isCancelled?.() !== true;
}

async function prepareForJob(deps: RunnerDeps, job: AgentJob): Promise<XActionResult> {
  const forceOpen = job.source === "browse";
  const readMin = forceOpen
    ? Math.max(2500, deps.settings.humanize.readMsMin)
    : Math.max(8000, deps.settings.humanize.readMsMin);
  const readMax = forceOpen
    ? Math.max(readMin, deps.settings.humanize.readMsMax)
    : Math.max(18000, deps.settings.humanize.readMsMax);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (deps.isCancelled?.()) return { ok: false, error: "stopped" };
    const result = await requestPrepareTweet({
      listUrl: job.source === "browse" && job.browseSurface === "lists" ? deps.settings.listUrlOrName : undefined,
      tweetId: job.tweetId,
      tweetUrl: job.tweetUrl,
      readMsMin: readMin,
      readMsMax: readMax,
      forceOpen,
      mentionContext: job.browseSurface === "mentions",
    });
    if (
      result.error !== "navigating_tweet" &&
      result.error !== "need_navigate_tweet" &&
      result.error !== "tweet_not_found"
    ) {
      return result;
    }
    if (deps.isCancelled?.()) return { ok: false, error: "stopped" };
    await waitUntilOnTweet(job.tweetId, job.tweetUrl, 18_000);
    if (!await pacingWait(deps, 1500)) return { ok: false, error: "stopped" };
  }
  return { ok: false, error: "navigate_timeout" };
}

function isTweetInteraction(job: AgentJob): boolean {
  // Follow đi profile (@handle), không mở /status — tránh vòng: mở bài → profile → mở bài…
  return (
    !!job.tweetId &&
    ["like", "retweet", "post_reply", "post_quote"].includes(job.kind)
  );
}

function withPreparedPost<T extends AgentJob>(job: T, prepared: XActionResult): T {
  return { ...job,
    ...(prepared.tweetText !== undefined && (prepared.tweetText.trim() || job.browseSurface === "mentions")
      ? { tweetText: prepared.tweetText || null } : {}),
    ...(job.browseSurface === "mentions" ? {
      parentText: prepared.parentText || "", conversationContext: prepared.conversationContext || "", ownerPost: prepared.ownerPost,
      notificationKind: prepared.notificationKind === "direct" || prepared.ownerPost ? "direct" : (job.notificationKind || prepared.notificationKind || "direct"),
    } : {}),
  };
}

export async function runFollowPostBundle(deps: RunnerDeps, jobs: AgentJob[], ai: AiSettings): Promise<RunnerTickResult> {
  if (!jobs.length) return { runtime: deps.runtime, stats: deps.stats, queue: deps.queue, nextDelayMs: 0 };
  return runBundle(deps, jobs, jobs[0].tweetId!, ai, deps.runtime, deps.stats, deps.queue);
}

async function runBundle(
  deps: RunnerDeps,
  jobsIn: AgentJob[],
  tweetId: string,
  ai: AiSettings,
  runtime: AgentRuntime,
  stats: AgentDailyStats,
  queue: AgentQueueState,
): Promise<RunnerTickResult> {
  const markPogoProgress = progressWriter(jobsIn[0]?.source);
  // Like/check trước → mới AI draft (tránh tốn token khi task đã xong).
  const rank: Record<AgentJob["kind"], number> = {
    like: 0, draft_reply: 1, post_reply: 2, retweet: 3,
    follow: 4, draft_quote: 5, post_quote: 6, scroll_home: 7,
  };
  let jobs = [...jobsIn].sort((a, b) => (a.authorFollow ? 8 : rank[a.kind]) - (b.authorFollow ? 8 : rank[b.kind]));
  // Persist every planned action before checks can skip it. markJob only updates
  // existing entries; otherwise a skipped Pogo job disappears and gets replanned.
  for (const planned of [...jobs].reverse()) {
    if (!queue.jobs.some(j => j.id === planned.id)) queue = upsertJob(queue, planned);
  }
  await deps.persistQueue(queue);

  // Check cache trước mọi thứ — reply đã recorded thì bỏ draft/post, không gọi AI.
  if (jobsIn[0]?.source === "pogo" && tweetId && (await isPogoReplyAlreadyRecorded(tweetId))) {
    queue = skipOpenReplyJobs(queue, tweetId, "reply_already_recorded");
    for (const j of jobs) {
      if (j.kind === "draft_reply" || j.kind === "post_reply") {
        queue = markJob(queue, j.id, { status: "skipped", error: "reply_already_recorded" });
      }
    }
    await deps.persistQueue(queue);
    await deps.appendActivity("info", "Reply đã ghi nhận — bỏ soạn/đăng (không tốn token).");
    jobs = jobs.filter((j) => j.kind !== "draft_reply" && j.kind !== "post_reply");
    if (!jobs.length) {
      return {
        runtime: { ...runtime, detail: "Reply đã xong — sang task khác" },
        stats,
        queue,
        nextDelayMs: randomBetween(2, 5) * 1000,
      };
    }
  }

  const firstInteraction = jobs.find(j => isTweetInteraction(j) && !j.likeOnFeed);
  let readComplete = false;
  let preparedPost: XActionResult | undefined;
  let needsGap = false;
  for (const jobIn of jobs) {
    if (deps.isCancelled?.()) return { runtime, stats, queue, nextDelayMs: 0 };
    if (await isBlockedByPogoLock(jobIn, deps.settings)) {
      queue = upsertJob(queue, jobIn);
      return applyOutcome(deps, jobIn, lockedOutcome(), runtime, stats, queue, true);
    }
    // Job reply đã bị skip giữa chừng (vd. after already_liked) → không chạy AI.
    const live = queue.jobs.find((j) => j.id === jobIn.id);
    if (dailyActionReached(deps.settings, stats, jobIn.kind)) {
      queue = upsertJob(queue, { ...jobIn, status: "pending", error: "daily_target_reached" });
      await deps.persistQueue(queue);
      continue;
    }
    if (live && (live.status === "skipped" || live.status === "done" || live.status === "failed")) {
      continue;
    }
    // Read before drafting too, so a bundle starts with the actual post on screen.
    if (!readComplete && firstInteraction) {
      runtime.detail = `Đang cuộn tới và đọc bài ${tweetId}…`;
      await deps.appendActivity("info", runtime.detail);
      await deps.onProgress?.(runtime);
      const prepared = await prepareForJob(deps, firstInteraction);
      if (!prepared.ok) {
        if (deps.isCancelled?.()) return { runtime, stats, queue, nextDelayMs: 0 };
        queue = upsertJob(queue, { ...firstInteraction, status: "running" });
        return applyOutcome(deps, firstInteraction, mapX(prepared, "Read post"), runtime, stats, queue, true);
      }
      preparedPost = prepared;
      // Đã tự comment trên X (kể cả comment tay) → bỏ soạn/đăng, không reply lần 2.
      if (prepared.detail === "reply_attempt_exists") {
        await markPogoProgress(tweetId, firstInteraction.authorHandle, { reply: true, localState: "uncertain" });
        queue = skipOpenReplyJobs(queue, tweetId, "reply_attempt_exists");
        for (const j of jobs) {
          if (j.kind === "draft_reply" || j.kind === "post_reply") {
            queue = markJob(queue, j.id, { status: "skipped", error: "reply_attempt_exists", verification: "uncertain", pogoVerify: undefined });
          }
        }
        await deps.persistQueue(queue);
        await deps.appendActivity("info", `[${firstInteraction.source}] @${firstInteraction.authorHandle ?? "?"} #${tweetId} · Đã có lần gửi reply — bỏ soạn và gửi lại; kiểm tra kết quả trên X.`);
        jobs = jobs.filter((j) => j.kind !== "draft_reply" && j.kind !== "post_reply");
        readComplete = true;
        if (jobIn.kind === "draft_reply" || jobIn.kind === "post_reply") continue;
      }
      if (prepared.detail === "already_replied") {
        queue = skipOpenReplyJobs(queue, tweetId, "already_replied");
        for (const j of jobs) {
          if (j.kind === "draft_reply" || j.kind === "post_reply") {
            queue = markJob(queue, j.id, { status: "skipped", error: "already_replied", verification: "x_confirmed", pogoVerify: undefined });
          }
        }
        await markPogoProgress(tweetId, firstInteraction.authorHandle, { reply: true, localState: "confirmed" });
        await deps.persistQueue(queue);
        await deps.appendActivity("info", `[${firstInteraction.source}] @${firstInteraction.authorHandle ?? "?"} #${tweetId} · Đã có reply của mình trên X — bỏ comment lần 2.`);
        noteSuccess(runtime);
        runtime.detail = "Đã reply trên X — sang task khác";
        // Vẫn chạy like/RT/follow còn lại nếu có.
        jobs = jobs.filter((j) => j.kind !== "draft_reply" && j.kind !== "post_reply");
        readComplete = true;
        if (!jobs.filter((j) => {
          const live = queue.jobs.find((x) => x.id === j.id);
          return !live || (live.status !== "skipped" && live.status !== "done" && live.status !== "failed");
        }).length) {
          return { runtime, stats, queue, nextDelayMs: randomBetween(2, 5) * 1000 };
        }
        if (jobIn.kind === "draft_reply" || jobIn.kind === "post_reply") continue;
      }
      readComplete = true;
    }
    const physical = !jobIn.kind.startsWith("draft_");
    if (physical && needsGap) {
      const gapMs = randomBetween(6000, 16000);
      runtime.detail = `Nghỉ ${Math.round(gapMs / 1000)} giây trước ${jobIn.kind}…`;
      await deps.appendActivity("info", runtime.detail);
      await deps.onProgress?.(runtime);
      if (!await pacingWait(deps, gapMs)) return { runtime, stats, queue, nextDelayMs: 0 };
    }
    let job = preparedPost ? withPreparedPost(jobIn, preparedPost) : jobIn;
    if (job.kind === "post_reply" || job.kind === "post_quote") {
      const draftKind = job.kind === "post_reply" ? "draft_reply" : "draft_quote";
      const draft = queue.jobs.find((d) => d.kind === draftKind && d.tweetId === job.tweetId && d.status === "done" && d.draftText?.trim());
      if (!job.draftText && draft?.draftText) job = { ...job, draftText: draft.draftText };
      // Do not immediately repeat an AI call that already failed in this bundle.
      const failedDraft = queue.jobs.some((d) => d.kind === draftKind && d.tweetId === job.tweetId && d.status === "failed" && jobs.some((planned) => planned.id === d.id));
      if (!job.draftText && failedDraft) {
        const cause = queue.jobs.find((d) => d.kind === draftKind && d.tweetId === job.tweetId && d.status === "failed")?.error;
        queue = upsertJob(queue, { ...job, status: "failed", updatedAt: Date.now(), error: `draft_unavailable${cause ? `: ${cause}` : ""}` });
        await deps.persistQueue(queue);
        continue;
      }
    }
    const result = await runSingleJob(deps, job, ai, runtime, stats, queue, readComplete);
    ({ runtime, stats, queue } = result);
    if (result.nextDelayMs <= 0 || queue.jobs.find((j) => j.id === job.id)?.status === "pending") return result;
    if (physical) needsGap = true;
  }
  return { runtime, stats, queue, nextDelayMs: backoffDelayMs(runtime.consecutiveErrors || 0, deps.settings) };
}

async function applyOutcome(
  deps: RunnerDeps,
  job: AgentJob,
  outcome: JobOutcome,
  runtime: AgentRuntime,
  stats: AgentDailyStats,
  queue: AgentQueueState,
  _fromBundle: boolean,
): Promise<RunnerTickResult> {
  const { settings } = deps;
  if (outcome.ok && outcome.skipped && outcome.error === "skip_reply") {
    for (const item of queue.jobs) {
      if (item.tweetId === job.tweetId && item.source === job.source && item.browseSurface === job.browseSurface &&
          ["draft_reply", "post_reply", "like"].includes(item.kind) && ["pending", "running"].includes(item.status)) {
        queue = markJob(queue, item.id, { status: "skipped", error: "skip_reply", draftText: null });
      }
    }
    noteSuccess(runtime); runtime.detail = "AI bỏ qua reply: spam hoặc thiếu ngữ cảnh phù hợp.";
    await deps.persistQueue(queue);
    await deps.appendActivity("info", runtime.detail);
    return { runtime, stats, queue, nextDelayMs: 2000 };
  }
  const markPogoProgress = progressWriter(job.source);
  const appendActivity: RunnerDeps["appendActivity"] = (level, message) =>
    deps.appendActivity(
      level,
      job.kind === "scroll_home"
        ? `${browseActivityPrefix(job.browseSurface)} ${message}`
        : `[${job.source}] @${job.authorHandle ?? "?"} #${job.tweetId ?? "—"} · ${job.kind} · ${message}`,
    );

  if (deps.isCancelled?.()) {
    const interruptedPost = (job.kind === "post_reply" || job.kind === "post_quote") && !outcome.ok;
    if (interruptedPost && job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, {
      [job.kind === "post_reply" ? "reply" : "quote"]: true, localState: "uncertain", error: "stopped_before_result",
    });
    queue = markJob(queue, job.id, {
      status: job.kind === "follow" && outcome.error === "stopped" ? "pending" : outcome.ok ? (outcome.skipped ? "skipped" : "done") : "failed",
      draftText: outcome.draftText ?? job.draftText,
      error: outcome.ok ? outcome.error ?? null : "stopped",
      ...(interruptedPost ? { verification: "uncertain" as const, ...(job.source === "pogo" && job.kind !== "post_reply" ? { pogoVerify: await pendingPogoVerification(deps) } : {}) } : {}),
      ...(job.source === "pogo" && job.kind === "follow" && outcome.ok && (!outcome.skipped || outcome.error === "already_following") && await isLockedPogoJob(job)
        ? { pogoUnlock: { state: "pending" as const, attempts: 0, nextCheckAt: Date.now() + 2000 } } : {}),
    });
    if (outcome.ok && !outcome.skipped) stats = bumpStats(stats, job.kind);
    await deps.persistQueue(queue);
    await deps.persistStats(stats);
    return { runtime, stats, queue, nextDelayMs: 0 };
  }

  if (job.kind === "scroll_home" && feedWaitMessage(outcome.error ?? "")) {
    const surface = job.browseSurface ?? "home";
    const cooling = outcome.error === "feed_recovery_cooldown";
    queue = markJob(queue, job.id, { status: cooling ? "skipped" : "pending", error: outcome.error });
    if (cooling) {
      runtime.browseCooldowns = { ...runtime.browseCooldowns, [surface]: Date.now() + 120000 };
      if (surface === "home" || surface === "following" || surface === "lists") {
        runtime.browseRotation = switchToNextSource(runtime.browseRotation ?? resolveBrowseRotation(runtime, settings, Date.now()), settings, {
          reason: "source_disabled", cooldowns: runtime.browseCooldowns, now: Date.now(),
        });
      }
      runtime.browseVisit = undefined;
    } else {
      // Loading / stalled — không đếm empty, không chuyển nguồn.
      runtime.browseRotation = pauseScanClock(runtime.browseRotation ?? resolveBrowseRotation(runtime, settings, Date.now()), Date.now());
      if (!runtime.browseVisit) {
        runtime.browseVisit = { surface, rolls: { engage: false, like: false, reply: false, retweet: false, follow: false, feedLike: false } };
      }
    }
    runtime.detail = feedWaitMessage(outcome.error!)!;
    await deps.persistQueue(queue);
    await appendActivity("info", runtime.detail);
    return { runtime, stats, queue, nextDelayMs: cooling ? 30000 : 4000 };
  }

  if (outcome.error === "busy") {
    queue = markJob(queue, job.id, { status: "pending", error: "busy" });
    if (job.kind === "scroll_home" && !runtime.browseVisit) {
      runtime.browseVisit = { surface: job.browseSurface ?? "home", rolls: { engage: false, like: false, reply: false, retweet: false, follow: false, feedLike: false } };
    }
    runtime.detail = `Tab X đang xử lý lệnh trước${outcome.detail ? ` (${outcome.detail})` : ""} — chờ thử lại.`;
    await deps.persistQueue(queue);
    await appendActivity("info", runtime.detail);
    return { runtime, stats, queue, nextDelayMs: 5000 };
  }

  if (outcome.navigating) {
    if (job.kind === "scroll_home" && job.browseSurface && !runtime.browseVisit) {
      runtime.browseVisit = { surface: job.browseSurface, rolls: { engage: false, like: false, reply: false, retweet: false, follow: false, feedLike: false } };
    }
    queue = markJob(queue, job.id, { status: "pending", error: outcome.error ?? "navigating" });
    await deps.persistQueue(queue);
    await appendActivity("info", `${job.kind}: đang điều hướng — thử lại sau.`);
    runtime.detail = "Đang điều hướng trang X…";
    return {
      runtime,
      stats,
      queue,
      nextDelayMs: Math.max(await xPageRetryDelay(), randomBetween(8, 20) * 1000),
    };
  }

  if (["x_account_requires_attention", "x_rate_limited"].includes(outcome.error || "")) {
    runtime.status = "paused";
    runtime.lastError = outcome.error || "x_account_requires_attention";
    runtime.detail = "X yêu cầu xác minh hoặc đã giới hạn thao tác — xử lý trên X rồi bấm Bắt đầu. Không tự thử lại.";
    queue = markJob(queue, job.id, { status: "pending", error: outcome.error });
    await deps.persistQueue(queue);
    await appendActivity("error", runtime.detail);
    return { runtime, stats, queue, nextDelayMs: 0 };
  }

  if (job.kind === "follow" && job.source === "pogo" && job.tweetId && outcome.ok &&
      (!outcome.skipped || outcome.error === "already_following") && await isLockedPogoJob(job)) {
    // Persist the follow result first: a sleeping worker must not follow repeatedly.
    queue = markJob(queue, job.id, { status: outcome.skipped ? "skipped" : "done", error: outcome.error ?? null,
      verification: "x_confirmed", pogoUnlock: { state: "pending", attempts: 0, nextCheckAt: Date.now() + 2000 } });
    if (!outcome.skipped) stats = bumpStats(stats, "follow");
    await deps.persistQueue(queue);
    await deps.persistStats(stats);
    await markPogoProgress(job.tweetId, job.authorHandle, { follow: true });
    const unlock = await checkAndRefreshPogoUnlock(deps, queue.jobs.find((j) => j.id === job.id)!, queue);
    queue = unlock.queue;
    const unlocked = unlock.unlocked;
    runtime.detail = unlocked
      ? "Pogo đã xác nhận mở khóa — tiếp tục task ở lượt kế tiếp."
      : "Chưa xác nhận mở khóa task Pogo — bỏ qua, không làm tương tác nhận điểm.";
    noteSuccess(runtime);
    await appendActivity("info", runtime.detail);
    return { runtime, stats, queue, nextDelayMs: deps.isCancelled?.() ? 0 : randomBetween(2, 5) * 1000 };
  }

  if (outcome.ok && outcome.skipped) {
    // A rejected non-Pogo draft must not generate again in its paired post job.
    if (job.source !== "pogo" && (job.kind === "draft_reply" || job.kind === "draft_quote") &&
        ["reply_quality_failed", "reply_grounding_failed", "source_text_missing", "reply_context_invalid"].includes(outcome.error || "")) {
      const postKind = job.kind === "draft_reply" ? "post_reply" : "post_quote";
      for (const pending of queue.jobs) if (pending.source === job.source && pending.expectedAccount === job.expectedAccount && pending.tweetId === job.tweetId && pending.kind === postKind && ["pending", "running"].includes(pending.status)) {
        queue = markJob(queue, pending.id, { status: "skipped", error: outcome.error || "draft_rejected" });
      }
    }
    queue = markJob(queue, job.id, {
      status: "skipped",
      verification: ["reply_attempt_exists", "reply_submission_uncertain", "quote_attempt_exists", "quote_submission_uncertain", "reply_identity_missing", "reply_history_unavailable", "follow_not_confirmed", "timeout", "port_closed"].includes(outcome.error ?? "")
        ? "uncertain" : outcome.error === "already_replied" || outcome.error === "already_following" ? "x_confirmed"
          : outcome.error === "reply_already_recorded" ? "pogo_recorded" : "blocked",
      draftText: outcome.draftText ?? job.draftText,
      error: outcome.error ?? "already_done",
      ...(job.source === "pogo" && ["post_quote", "retweet"].includes(job.kind) && ["already_replied", "reply_attempt_exists", "reply_submission_uncertain", "quote_attempt_exists", "quote_submission_uncertain", "timeout", "port_closed"].includes(outcome.error ?? "") ? { pogoVerify: await pendingPogoVerification(deps) } : {}),
    });
    if (outcome.error === "campaign_locked") {
      queue = pruneLockedPogoJobs(queue, job.tweetId ? [job.tweetId] : []).queue;
      runtime.detail = outcome.message;
      await appendActivity("info", outcome.message);
      await deps.persistQueue(queue);
      return { runtime, stats, queue, nextDelayMs: randomBetween(2, 5) * 1000 };
    }
    if (
      job.kind === "follow" &&
      (outcome.error === "already_following" || isAccountUnavailableError(outcome.error))
    ) {
      if (outcome.error === "already_following" && job.tweetId) {
        await markPogoProgress(job.tweetId, job.authorHandle, { follow: true });
        if (job.source === "pogo") await runPogoFollowCheck(appendActivity, deps);
      }
      // Acc sus: bỏ luôn job còn lại của cùng tweet (không kẹt retry Follow).
      queue = skipRemainingJobsForTweet(
        queue,
        job.tweetId,
        job.id,
        isAccountUnavailableError(outcome.error) ? "profile_unavailable_skip_rest" : "follow_done_skip_rest",
      );
      if (!isAccountUnavailableError(outcome.error)) {
        await appendActivity("info", "Follow xong — bỏ job còn lại của task này → sang task khác.");
      }
    }
    if (job.kind === "retweet" && job.tweetId) {
      await markPogoProgress(job.tweetId, job.authorHandle, { retweet: true });
    }
    // Audience block trên post_reply — đánh dấu để không lặp.
    if (
      job.kind === "post_reply" &&
      job.tweetId &&
      isReplyAudienceBlocked(outcome.error ?? undefined)
    ) {
      await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: "blocked", error: outcome.error });
    }
    if (
      job.kind === "post_reply" &&
      job.tweetId &&
      outcome.error === "reply_already_recorded"
    ) {
      await markPogoProgress(job.tweetId, job.authorHandle, { reply: true });
    }
    // Đã like + Pogo đã có Reply → bỏ draft/post_reply còn treo (tránh comment lần 2).
    if (job.kind === "like" && job.tweetId && outcome.error === "already_liked") {
      if (job.source === "pogo" && await isPogoReplyAlreadyRecorded(job.tweetId)) {
        queue = skipOpenReplyJobs(queue, job.tweetId, "reply_already_recorded");
        await markPogoProgress(job.tweetId, job.authorHandle, { reply: true });
        await appendActivity("info", "Đã like + đã reply trên Pogo — bỏ comment lần 2.");
      }
    }
    noteSuccess(runtime);
    await appendActivity("info", `${outcome.message} → task tiếp…`);
    runtime.detail = outcome.message;
    await deps.persistQueue(queue);
    return {
      runtime,
      stats,
      queue,
      nextDelayMs: job.kind === "follow" ? Math.max(8000, randomBetween(settings.delaySecMin, settings.delaySecMax) * 1000) : randomBetween(2, 5) * 1000,
    };
  }

  if (outcome.ok) {
    if (job.kind === "scroll_home" && runtime.browseVisit?.surface === job.browseSurface) runtime.browseVisit = undefined;
    const autoNotification = job.kind === "draft_reply" && job.browseSurface === "mentions" && settings.executeActions;
    queue = markJob(queue, job.id, {
      status: "done",
      ...(["post_reply", "post_quote", "retweet"].includes(job.kind) ? { verification: outcome.detail === "reply_confirmed" || outcome.detail === "quote_confirmed" ? "x_confirmed" as const : "submitted" as const } : {}),
      draftText: outcome.draftText ?? job.draftText,
      error: null,
      ...(job.source === "pogo" && ["post_quote", "retweet"].includes(job.kind) ? { pogoVerify: await pendingPogoVerification(deps) } : {}),
    });
    const replyText = outcome.draftText ?? job.draftText;
    if (autoNotification && replyText && !queue.jobs.some(j => j.kind === "post_reply" && j.tweetId === job.tweetId && j.expectedAccount === job.expectedAccount)) {
      queue = upsertJob(queue, makeJob({ ...job, kind: "post_reply", status: "pending", draftText: replyText, error: null,
        autoPost: true, reason: "Thông báo: tự đăng sau khi AI soạn" }));
    }
    stats = bumpStats(stats, job.kind);
    noteSuccess(runtime);
    await appendActivity("action", outcome.message);
    runtime.detail = outcome.message;
    if (job.kind === "follow") {
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { follow: true });
      if (job.source === "pogo") await runPogoFollowCheck(appendActivity, deps);
      queue = skipRemainingJobsForTweet(queue, job.tweetId, job.id, "follow_done_skip_rest");
      await appendActivity("info", "Follow xong — bỏ job còn lại của task này → sang task khác.");
    }
    if (job.kind === "retweet" && job.tweetId) {
      await markPogoProgress(job.tweetId, job.authorHandle, { retweet: true });
    }
    if (job.kind === "post_reply" && job.tweetId) {
      await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: outcome.detail === "reply_confirmed" ? "confirmed" : "submitted" });
    }
    if (job.kind === "post_quote" && job.tweetId) {
      await markPogoProgress(job.tweetId, job.authorHandle, { quote: true, localState: outcome.detail === "quote_confirmed" ? "confirmed" : "submitted" });
    }

    if (
      settings.executeActions &&
      (job.kind === "draft_reply" || job.kind === "draft_quote") &&
      (outcome.draftText || job.draftText)
    ) {
      await appendActivity("info", "Draft sẵn — tick sau sẽ post nếu còn quota.");
    }
  } else {
    // Draft AI lỗi cấu hình → bỏ post_reply cùng tweet (tránh Reply treo như ảnh @0xKai_).
    if (job.kind === "draft_reply" && outcome.configurationError && job.tweetId) {
      queue = markJob(queue, job.id, { status: "failed", error: outcome.error ?? "failed" });
      queue = skipOpenReplyJobs(queue, job.tweetId, `draft_unavailable: ${outcome.error ?? "ai"}`);
      const n = noteFailure(runtime, outcome.error);
      await appendActivity("warn", `${job.kind} lỗi: ${outcome.error}${outcome.detail ? ` · ${outcome.detail}` : ""}`);
      // Temperature đã retry trong ai-client; nếu vẫn fail thì pause để user sửa model.
      if (n >= 6 || outcome.configurationError) {
        runtime.status = "paused";
        runtime.detail = `Tạm dừng — kiểm tra cấu hình AI: ${outcome.error}${outcome.detail ? ` · ${outcome.detail}` : ""}`;
        runtime.nextActionAt = null;
        await appendActivity("error", runtime.detail);
        await deps.persistQueue(queue);
        await deps.persistStats(stats);
        return { runtime, stats, queue, nextDelayMs: 0 };
      }
      await deps.persistQueue(queue);
      await deps.persistStats(stats);
      return { runtime, stats, queue, nextDelayMs: backoffDelayMs(n, settings) };
    }
    // Acc suspended / restrict / missing — bỏ tweet, sang task tiếp (không pause).
    if (isAccountUnavailableError(outcome.error)) {
      const err = outcome.error || "profile_unavailable";
      queue = markJob(queue, job.id, { status: "skipped", error: err });
      queue = skipRemainingJobsForTweet(queue, job.tweetId, job.id, "profile_unavailable_skip_rest");
      noteSuccess(runtime);
      const msg = `Bỏ task — acc/bài không dùng được (${err}) @${job.authorHandle ?? "?"} → task tiếp`;
      await appendActivity("info", msg);
      runtime.detail = msg;
      await deps.persistQueue(queue);
      return {
        runtime,
        stats,
        queue,
        nextDelayMs: randomBetween(2, 5) * 1000,
      };
    }

    // Không mở được bài (navigate_timeout / tweet_not_found) — Like/RT/Follow cũng bỏ, không tạo lại.
    if (
      outcome.error === "navigate_timeout" ||
      outcome.error === "tweet_not_found"
    ) {
      const err = outcome.error;
      queue = markJob(queue, job.id, { status: "skipped", error: err });
      queue = skipRemainingJobsForTweet(queue, job.tweetId, job.id, "navigate_timeout_skip_rest");
      noteSuccess(runtime);
      const msg =
        err === "tweet_not_found"
          ? `Bỏ task — không thấy bài @${job.authorHandle ?? "?"} → task tiếp`
          : `Bỏ task — không mở được bài (navigate_timeout) @${job.authorHandle ?? "?"} → task tiếp`;
      await appendActivity("info", msg);
      runtime.detail = msg;
      await deps.persistQueue(queue);
      return {
        runtime,
        stats,
        queue,
        nextDelayMs: randomBetween(2, 5) * 1000,
      };
    }

    // Acc sus / composer missing… — bỏ tweet, không cộng err× / không pause agent.
    if (
      (job.kind === "post_reply" || job.kind === "draft_reply") &&
      isReplyAudienceBlocked(outcome.error)
    ) {
      const err = normalizeReplyError(outcome.error) || outcome.error || "reply_restricted";
      queue = markJob(queue, job.id, { status: "skipped", error: err });
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: "blocked", error: err });
      // Cùng tweet: bỏ draft/post còn treo.
      queue = skipOpenReplyJobs(queue, job.tweetId ?? "", err);
      noteSuccess(runtime);
      const msg = replyBlockMessage(err, job.tweetId);
      await appendActivity("info", `${msg} → task tiếp…`);
      runtime.detail = msg;
      await deps.persistQueue(queue);
      return {
        runtime,
        stats,
        queue,
        nextDelayMs: randomBetween(2, 5) * 1000,
      };
    }

    queue = markJob(queue, job.id, { status: "failed", error: outcome.error ?? "failed" });
    const n = noteFailure(runtime, outcome.error);
    await appendActivity("warn", `${job.kind} lỗi: ${outcome.error}`);
    runtime.detail = `${job.kind} lỗi: ${outcome.error}`;
    const transient = /network|timeout|port_closed|fetch_failed|http_5\d\d/.test(outcome.error || "");
    if (outcome.configurationError || (n >= 6 && (settings.adaptiveRest === false || !transient))) {
      runtime.status = "paused";
      runtime.detail = outcome.configurationError
        ? `Tạm dừng — kiểm tra cấu hình AI: ${outcome.error}.`
        : `Tạm dừng — ${n} lỗi liên tiếp. Lỗi gần nhất: ${outcome.error ?? "unknown"}.`;
      runtime.nextActionAt = null;
      await appendActivity("error", runtime.detail);
      await deps.persistQueue(queue);
      await deps.persistStats(stats);
      return { runtime, stats, queue, nextDelayMs: 0 };
    }
    await deps.persistQueue(queue);
    await deps.persistStats(stats);
    return {
      runtime,
      stats,
      queue,
      nextDelayMs: backoffDelayMs(n, settings),
    };
  }

  await deps.persistQueue(queue);
  await deps.persistStats(stats);

  const shortGap =
    job.source === "pogo" &&
    (job.kind === "like" || job.kind === "retweet" || job.kind === "follow");

  return {
    runtime,
    stats,
    queue,
    nextDelayMs: job.kind === "follow" ? Math.max(8000, randomBetween(settings.delaySecMin, settings.delaySecMax) * 1000) : job.kind === "scroll_home" || job.likeOnFeed
      ? randomBetween(2, 4) * 1000
      : shortGap
        ? randomBetween(3, 7) * 1000
        : randomBetween(settings.delaySecMin, settings.delaySecMax) * 1000,
  };
}

function bumpStats(stats: AgentDailyStats, kind: AgentJob["kind"]): AgentDailyStats {
  const next = stats.date === todayKey() ? { ...stats } : { ...createEmptyDailyStats(), account: stats.account };
  if (kind === "scroll_home") next.scrollSessions += 1;
  if (kind === "like") next.like += 1;
  if (kind === "retweet") next.retweet += 1;
  if (kind === "follow") next.follow += 1;
  if (kind === "post_reply") next.reply += 1;
  if (kind === "post_quote") next.quote += 1;
  return next;
}

/** Sorsa / verified / followers gate for browse follows when modules.following is on. */
async function gateBrowseFollowCandidate(
  handle: string,
  deps: RunnerDeps,
  strictSorsa = false,
): Promise<{ ok: true; sorsa: number | null } | { ok: false; reason: string; sorsa: number | null }> {
  const settings = await loadFollowSettings();
  if (deps.isCancelled?.()) return { ok: false, reason: "stopped", sorsa: null };
  if ((await loadFollowHistory(getXConnection().handle || deps.settings.ownHandle || "")).has(handle.replace(/^@/, "").toLowerCase()))
    return { ok: false, reason: "already_following", sorsa: null };
  const strictScore = strictSorsa ? await fetchSorsaScore(handle) : null;
  const threshold = deps.settings.randomAuthorFollowSorsaMin ?? 500;
  if (deps.isCancelled?.()) return { ok: false, reason: "stopped", sorsa: null };
  if (strictSorsa && (!strictScore?.ok || typeof strictScore.score !== "number" || strictScore.score <= threshold)) {
    return { ok: false, reason: typeof strictScore?.score === "number" ? `sorsa_not_above_${threshold}` : "sorsa_missing", sorsa: strictScore?.score ?? null };
  }
  if (strictSorsa && settings.filters.verified === "any" && settings.filters.followersMin == null && settings.filters.followersMax == null) {
    const decision = evaluateFollowCandidate({ handle, verified: false, followers: null, sorsa: strictScore!.score ?? null }, settings.filters);
    return decision.ok ? { ok: true, sorsa: strictScore!.score ?? null }
      : { ok: false, reason: decision.reason, sorsa: strictScore!.score ?? null };
  }
  const metaRes = await inspectFollowProfile(handle, () => deps.isCancelled?.() === true, deps.waitForDelay);
  if (deps.isCancelled?.()) return { ok: false, reason: "stopped", sorsa: null };
  if (!metaRes.ok) return { ok: false, reason: metaRes.error || "follow_profile_unverified", sorsa: null };
  const observed = metaRes.meta as { onProfile?: boolean; verified?: boolean; hasFollowButton?: boolean; alreadyFollowing?: boolean; ownProfile?: boolean } | undefined;
  if (!metaRes.ok || !observed || observed.onProfile !== true || typeof observed.verified !== "boolean" ||
      !(observed.hasFollowButton || observed.alreadyFollowing || observed.ownProfile))
    return { ok: false, reason: "follow_profile_unverified", sorsa: null };
  const meta = (metaRes.meta || {}) as Partial<FollowCandidate> & {
    hasFollowButton?: boolean;
    onProfile?: boolean;
  };
  let candidate: FollowCandidate = {
    handle,
    verified: !!meta.verified,
    followers: typeof meta.followers === "number" ? meta.followers : null,
    sorsa: null,
    alreadyFollowing: !!meta.alreadyFollowing,
    ownProfile: !!meta.ownProfile,
  };
  if (candidate.alreadyFollowing) return { ok: false, reason: "already_following", sorsa: null };
  const scoreRes = strictScore ?? await fetchSorsaScore(handle);
  if (deps.isCancelled?.()) return { ok: false, reason: "stopped", sorsa: null };
  candidate = {
    ...candidate,
    sorsa: scoreRes.ok && typeof scoreRes.score === "number" ? scoreRes.score : null,
  };
  const ev = evaluateFollowCandidate(candidate, settings.filters);
  if (!ev.ok) return { ok: false, reason: ev.reason, sorsa: candidate.sorsa };
  return { ok: true, sorsa: candidate.sorsa };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Chờ content script reconnect và URL đã là trang status. */
async function waitUntilOnTweet(
  tweetId: string | null,
  tweetUrl: string | null,
  timeoutMs: number,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    pingAllXTabs();
    const x = getXConnection();
    if (x.connected && x.url) {
      if (tweetId && x.url.includes(`/status/${tweetId}`)) return true;
      if (tweetUrl && tweetUrl.includes("/status/") && x.url.includes("/status/")) {
        const idFromUrl = tweetUrl.match(/\/status\/(\d+)/)?.[1];
        if (idFromUrl && x.url.includes(`/status/${idFromUrl}`)) return true;
      }
    }
    await sleep(700);
  }
  return false;
}

async function isPogoReplyAlreadyRecorded(tweetId: string): Promise<boolean> {
  const camps = await loadPogoCampaigns();
  const c = camps.find((x) => x.tweet_id === tweetId);
  return c?.actions.reply.status === "recorded";
}

async function pendingPogoVerification(deps: RunnerDeps): Promise<NonNullable<AgentJob["pogoVerify"]>> {
  const submittedAt = Date.now();
  return { attempts: 0, submittedAt,
    nextCheckAt: await nextPogoSettlementCheck(getXConnection().handle || deps.settings.ownHandle || "unknown", submittedAt) };
}

async function verifyPogoBatch(deps: RunnerDeps, jobs: AgentJob[], initialQueue: AgentQueueState): Promise<AgentQueueState> {
  const token = await getApiSessionTokenAsync();
  const revision = getApiSessionRevision();
  const nextCheckAt = await nextPogoSettlementCheck(getXConnection().handle || deps.settings.ownHandle || "unknown");
  if (deps.isCancelled?.()) return initialQueue;
  let queue = initialQueue;
  for (const job of jobs) queue = markJob(queue, job.id, { pogoVerify: {
    attempts: (job.pogoVerify?.attempts ?? 0) + 1, nextCheckAt,
    submittedAt: job.pogoVerify?.submittedAt ?? job.updatedAt,
  } });
  await deps.persistQueue(queue);
  if (!token || deps.isCancelled?.()) {
    if (!deps.isCancelled?.()) await deps.appendActivity("info", `Pogo: ${jobs.length} thao tác chờ đối soát; chưa có phiên API, sẽ kiểm tra ở kỳ tiếp theo. Không gửi lại.`);
    return queue;
  }
  await deferPogoDemandPull();
  const result = await fetchPogoFeed(token, { resolveIdentity: false });
  if (deps.isCancelled?.() || revision !== getApiSessionRevision()) return queue;
  let recorded = 0;
  if (result.ok) {
    await applyPogoFeedRefresh(result.snapshot);
    for (const job of jobs) {
      const target = result.snapshot.campaigns.find((c) => c.tweet_id === job.tweetId);
      const kind = job.kind === "post_reply" ? "reply" : job.kind === "post_quote" ? "quote" : "retweet";
      if (target?.actions[kind].status === "recorded") {
        queue = markJob(queue, job.id, { verification: "pogo_recorded" }); recorded++;
        await deps.appendActivity("info", `[pogo] @${job.authorHandle ?? "?"} #${job.tweetId} · ${job.kind} · Pogo đã ghi nhận.`);
      }
    }
  } else {
    await reportPogoFeedError(result.login_required, result.httpStatus);
  }
  await deps.persistQueue(queue);
  await deps.appendActivity("info", `Pogo đối soát ${jobs.length} thao tác: ${recorded} đã ghi nhận, ${jobs.length - recorded} chờ kỳ tiếp theo. Không gửi lại.`);
  return queue;
}

/**
 * Sau Follow trên X — Pogo "I followed. Check now".
 * Không token / hết hạn → bỏ qua êm, làm sau (không chặn agent).
 */
async function checkAndRefreshPogoUnlock(deps: RunnerDeps, job: AgentJob, initialQueue: AgentQueueState): Promise<{ queue: AgentQueueState; unlocked: boolean }> {
  let queue = initialQueue;
  let progress = job.pogoUnlock ?? { state: "pending" as const, attempts: 0, nextCheckAt: Date.now() + 2000 };
  const save = async (state: "pending" | "unlocked" | "exhausted") => {
    progress = { ...progress, state };
    queue = markJob(queue, job.id, { pogoUnlock: progress });
    await deps.persistQueue(queue);
  };
  const token = await getApiSessionTokenAsync();
  if (!token) {
    await deps.appendActivity("info", "Không có token Pogo để Check now — giữ task Locked, lưu JWT ở Nguồn rồi quét lại.");
    await save("exhausted");
    return { queue, unlocked: false };
  }
  while (progress.attempts < 3) {
    if (!await pacingWait(deps, Math.max(0, Math.min(10000, progress.nextCheckAt - Date.now())))) return { queue, unlocked: false };
    if (deps.isCancelled?.()) return { queue, unlocked: false };
    progress = { ...progress, attempts: progress.attempts + 1, nextCheckAt: Date.now() + (progress.attempts === 0 ? 5000 : 10000) };
    // Save before network calls so pause/restart keeps the retry budget.
    await save("pending");
    await deps.appendActivity("info", `[pogo] @${job.authorHandle ?? "?"} #${job.tweetId} · Check mở khóa ${progress.attempts}/3`);
    const check = await postPogoFollowCheck(token);
    if (deps.isCancelled?.()) return { queue, unlocked: false };
    if (!check.ok) {
      await deps.appendActivity("warn", `Check mở khóa ${progress.attempts}/3: ${check.error}`);
      if (check.login_required) break;
      continue;
    }
    // Global unlock counts never prove that this particular task is open.
    const feed = await fetchPogoFeed(token, { resolveIdentity: false });
    if (deps.isCancelled?.()) return { queue, unlocked: false };
    if (!feed.ok) {
      await deps.appendActivity("warn", `Tải trạng thái mở khóa ${progress.attempts}/3: ${feed.error}`);
      if (feed.login_required) break;
      continue;
    }
    const target = feed.snapshot.campaigns.find((c) => c.tweet_id === job.tweetId);
    await applyPogoFeedRefresh(feed.snapshot);
    if (target?.locked === false && !isCampaignLocked(target)) {
      await save("unlocked");
      return { queue, unlocked: true };
    }
  }
  await save("exhausted");
  return { queue, unlocked: false };
}

async function runPogoFollowCheck(
  appendActivity: RunnerDeps["appendActivity"],
  deps: RunnerDeps,
): Promise<string | null> {
  const token = await getApiSessionTokenAsync();
  if (!token) {
    await appendActivity("info", "Pogo Check now: bỏ qua (chưa có token) — Follow X đã xong, check sau khi Lưu JWT ở Sources.");
    return null;
  }

  await appendActivity("info", "Pogo Check now…");
  if (!await pacingWait(deps, 2000)) return null;

  const check = await postPogoFollowCheck(token);
  if (!check.ok) {
    // Hết hạn / lỗi mạng → bỏ qua, không pause, không retry chặn.
    await appendActivity(
      "info",
      check.login_required
        ? "Pogo Check now: token hết hạn — bỏ qua, Lưu JWT mới ở Sources rồi check sau."
        : `Pogo Check now: bỏ qua (${check.error}) — làm sau.`,
    );
    return null;
  }
  if (check.targetFollowed === true || check.unlockedCount > 0) {
    const msg = `Pogo Check now OK — unlocked ${check.unlockedCount}, +${check.unlockedPoints}pts`;
    await appendActivity("action", msg);
    return msg;
  }
  // Đã gọi được nhưng chưa unlock — một lần là đủ, không spam retry.
  await appendActivity(
    "info",
    `Pogo Check now: chưa unlock (target_followed=${String(check.targetFollowed)}) — bỏ qua, làm sau.`,
  );
  return null;
}

/** Bỏ mọi job pending/running còn lại của cùng tweet (sau Follow xong). */
function skipRemainingJobsForTweet(
  queue: AgentQueueState,
  tweetId: string | null,
  exceptJobId: string,
  error: string,
): AgentQueueState {
  if (!tweetId) return queue;
  let next = queue;
  for (const j of queue.jobs) {
    if (j.id === exceptJobId) continue;
    if (j.tweetId !== tweetId) continue;
    if (j.status !== "pending" && j.status !== "running") continue;
    next = markJob(next, j.id, { status: "skipped", error });
  }
  return next;
}

function skipOpenReplyJobs(
  queue: AgentQueueState,
  tweetId: string,
  error: string,
): AgentQueueState {
  let next = queue;
  for (const j of queue.jobs) {
    if (j.tweetId !== tweetId) continue;
    if (j.kind !== "draft_reply" && j.kind !== "post_reply") continue;
    if (j.status !== "pending" && j.status !== "running") continue;
    next = markJob(next, j.id, { status: "skipped", error });
  }
  return next;
}

async function executeJob(
  job: AgentJob,
  settings: AgentSettings,
  ai: AiSettings,
  appendActivity: RunnerDeps["appendActivity"],
  deps: RunnerDeps,
  queue: AgentQueueState,
): Promise<JobOutcome> {
  const markPogoProgress = progressWriter(job.source);
  if ((job.source === "pogo" || job.source === "manual") && isOwnPost(settings.ownHandle || getXConnection().handle, job.authorHandle, job.tweetUrl)) {
    return { ok: true, skipped: true, error: "own_post", message: "Bỏ qua bài của chính bạn." };
  }
  if (job.browseSurface === "mentions" && ["draft_reply", "post_reply"].includes(job.kind)) {
    const own = (getXConnection().handle || settings.ownHandle || "").replace(/^@/, "").toLowerCase();
    if (!job.expectedAccount || job.expectedAccount.toLowerCase() !== own) return { ok: false, configurationError: true, error: "mention_account_mismatch", message: "Tài khoản X khác tài khoản của bản nháp Mentions." };
  }
  if (job.kind === "scroll_home") {
    const surface = (job.browseSurface ?? "home") as BrowseSurface;
    const r = await requestScrollBurst({
      distancePx: randomBetween(480, 1100),
      steps: randomBetween(2, 4),
      stepDelayMs: randomBetween(120, 350),
      // Reading happens after selecting a post, not after each search scroll.
      readMs: 0,
      browseSurface: surface,
      listUrl: settings.listUrlOrName ?? null,
    });
    if (feedWaitMessage(r.error ?? "")) return { ok: false, error: r.error, message: feedWaitMessage(r.error!)! };
    if (r.ok) {
      if (r.scrolledPx === 0 || r.detail === "scroll_no_progress") return { ok: false, error: "scroll_no_progress", message: feedWaitMessage("scroll_no_progress")! };
      return { ok: true, message: `Đã cuộn khoảng ${Math.round(r.scrolledPx ?? 0)}px · ${job.reason ?? "Tìm bài mới"}` };
    }
    return mapX(r, `Cuộn ${browseSurfaceLabel(surface)} ~${r.scrolledPx ?? "?"}px`);
  }

  if (job.kind === "like") {
    const r = await requestLike({ tweetId: job.tweetId, tweetUrl: job.tweetUrl, onFeed: job.likeOnFeed === true });
    if (job.likeOnFeed && ["feed_tweet_missing", "feed_not_home"].includes(r.error ?? "")) return { ok: true, skipped: true, error: r.error,
      message: "Bài không còn hiện trên feed — bỏ Like dạo, tiếp tục lướt." };
    if (r.ok && r.detail === "already_liked") {
      return { ok: true, skipped: true, error: "already_liked", message: "Đã like rồi" };
    }
    return mapX(r, job.likeOnFeed ? `Đã Like dạo trên feed (${job.tweetId})` : job.tweetId ? `Like tweet ${job.tweetId}` : "Đã like (browse)");
  }

  if (job.kind === "retweet") {
    if (job.source === "browse" && !settings.homeRetweet) return { ok: true, skipped: true, error: "home_retweet_disabled", message: "Đăng lại Home đang tắt." };
    const r = job.source === "browse"
      ? await requestRetweet({ tweetId: job.tweetId, tweetUrl: job.tweetUrl })
      : await guardedPogoRetweet(job, getXConnection().handle || settings.ownHandle, () => deps.isCancelled?.() === true,
        () => requestRetweet({ tweetId: job.tweetId, tweetUrl: job.tweetUrl }));
    if (r.error === "pogo_retweet_window_full") return { ok: false, navigating: true, error: r.error, message: "Đã hết lượt RT Pogo còn được nhận thưởng trong khung." };
    if (["retweet_pogo_only", "pogo_retweet_already_attempted"].includes(r.error ?? ""))
      return { ok: true, skipped: true, error: r.error, message: "Bỏ RT ngoài Pogo hoặc đã có lần gửi trước đó." };
    if (r.ok && r.detail === "already_retweeted") {
      return { ok: true, skipped: true, error: "already_retweeted", message: "Đã RT rồi" };
    }
    return mapX(r, `Retweet ${job.tweetId ?? ""}`);
  }

  if (job.kind === "follow") {
    if (job.authorFollow && (!settings.randomAuthorFollow || job.source !== "browse" || !["home", "following", "lists"].includes(job.browseSurface || ""))) {
      return { ok: true, skipped: true, error: "author_follow_disabled", message: "Follow ngẫu nhiên tác giả đang tắt hoặc không đúng nguồn." };
    }
    if (job.authorFollow && !queue.jobs.some(j => j.tweetId === job.tweetId && j.source === "browse" && j.status === "done" &&
        ["like", "post_reply", "retweet", "post_quote"].includes(j.kind))) {
      return { ok: true, skipped: true, error: "no_completed_interaction", message: "Bỏ Follow ngẫu nhiên: chưa có tương tác thành công với bài." };
    }
    if ((settings.modules.following || job.authorFollow) && job.source === "browse" && job.authorHandle) {
      const gated = await gateBrowseFollowCandidate(job.authorHandle, deps, job.authorFollow === true);
      if (!gated.ok) {
        if (gated.reason === "stopped") return { ok: false, error: "stopped", message: "Đã dừng trước khi Follow." };
        if (gated.reason === "x_page_cooling_down") return { ok: false, navigating: true, error: gated.reason, message: "X tải chậm — chờ trước khi mở profile tiếp theo." };
        return {
          ok: true,
          skipped: true,
          error: gated.reason,
          message: `Bỏ follow @${job.authorHandle} — ${gated.reason}${gated.sorsa != null ? ` · Sorsa ${gated.sorsa}` : ""} → task tiếp`,
        };
      }
    }
    const r = await guardedFollow({ account: () => getXConnection().handle || "", cancelled: () => deps.isCancelled?.() === true,
      origin: "agent", settings, action: () => requestFollow({ authorHandle: job.authorHandle, tweetUrl: job.tweetUrl,
        tweetId: job.tweetId, preferInline: job.source === "browse" && !!job.tweetId }) });
    if (!r.ok && ["daily_target_reached", "follow_rate_30m"].includes(r.error ?? ""))
      return { ok: false, navigating: true, error: r.error, message: "Chờ ngân sách Follow dùng chung" };
    if (r.ok && r.detail === "follow_requested") {
      return { ok: true, skipped: true, error: "follow_requested", message: `Đã gửi yêu cầu follow @${job.authorHandle ?? "?"} — chờ chấp nhận` };
    }
    if (r.ok && (r.detail === "already_following" || r.detail === "own_profile")) {
      return {
        ok: true,
        skipped: true,
        error: r.detail ?? "already_following",
        message:
          r.detail === "own_profile"
            ? `Bỏ qua follow (profile của mình)`
            : `Đã follow @${job.authorHandle ?? "?"} rồi`,
      };
    }
    if (!r.ok && isAccountUnavailableError(r.error)) {
      return {
        ok: true,
        skipped: true,
        error: r.error,
        message: `Bỏ follow @${job.authorHandle ?? "?"} — acc sus/suspended/restrict (${r.error}) → task tiếp`,
      };
    }
    // Không thấy nút Follow trên profile → bỏ, không kẹt vòng mở bài/profile.
    if (
      !r.ok &&
      (r.error === "follow_btn_missing" ||
        r.error === "follow_disabled" ||
        r.error === "follow_not_confirmed" ||
        r.error === "follow_click_failed" ||
        r.error === "no_handle")
    ) {
      return {
        ok: true,
        skipped: true,
        error: r.error,
        message: `Bỏ follow @${job.authorHandle ?? "?"} — ${r.error} → task tiếp`,
      };
    }
    return mapX(r, `Follow @${job.authorHandle ?? "?"}`);
  }

  // Check trạng thái TRƯỚC khi gọi AI — tránh tốn token khi đã xong.
  if (job.kind === "draft_reply" || job.kind === "post_reply") {
    const local = job.source === "pogo" && job.tweetId ? (await loadPogoCampaigns()).find((c) => c.tweet_id === job.tweetId)?.actions.reply.local : null;
    if (local) return { ok: true, skipped: true, error: local.state === "confirmed" ? "already_replied" : local.state === "blocked" ? "reply_previously_blocked" : "reply_attempt_exists",
      message: "Reply đã xử lý — bỏ qua để tránh trùng.", draftText: job.draftText ?? undefined };
    if (job.source === "pogo" && job.tweetId && (await isPogoReplyAlreadyRecorded(job.tweetId))) {
      await markPogoProgress(job.tweetId, job.authorHandle, { reply: true });
      return {
        ok: true,
        skipped: true,
        error: "reply_already_recorded",
        message: `Đã reply rồi — bỏ ${job.kind} (không tốn token / không comment lần 2)`,
        draftText: job.draftText ?? undefined,
      };
    }
  }

  if (job.kind === "draft_reply" || job.kind === "draft_quote") {
    if (job.browseSurface === "mentions" && !job.tweetText?.trim()) return { ok: true, skipped: true, error: "notification_text_missing", message: "Không đọc được nội dung bài thật từ thông báo · bỏ qua, không gọi AI." };
    if (job.browseSurface === "mentions" && isLowValueNotification(job.tweetText, getXConnection().handle || "")) return { ok: true, skipped: true, error: "notification_low_value", message: "Bỏ thông báo chào hỏi/spam không cần phản hồi." };
    await appendActivity("info", `AI đang soạn ${job.kind}…`);
    const draftKind =
      job.kind === "draft_quote"
        ? "quote"
        : job.notificationKind === "post" ? "browse_reply" : draftKindForJobSource(job.source, job.browseSurface);
    const gen = await generateDraft(ai, draftKind, {
      author: job.authorHandle ?? "",
      text: job.tweetText ?? "",
      tweet_url: job.tweetUrl ?? "",
      tweet_id: job.tweetId ?? "",
      parent_text: job.parentText || "",
      conversation_context: job.conversationContext || "",
    }, { preservePogo: job.source === "pogo", allowSkip: job.source !== "manual", ownerPostReply: job.browseSurface === "mentions" ? ownerPostReplyContext(job.ownerPost, getXConnection().handle || "", { author: job.authorHandle || "", tweetId: job.tweetId || "", text: job.tweetText || "" }) : undefined });
    if (!gen.ok) return aiFailure(gen, job.source === "pogo");
    if (gen.skipped) return { ok: true, skipped: true, error: "skip_reply", message: "AI chọn SKIP_REPLY." };
    if (isAiSkip(gen.text)) {
      return { ok: false, error: "empty_content", message: "AI chưa ra reply — thử lại sau" };
    }
    return {
      ok: true,
      draftText: gen.text,
      message: `Draft ${job.kind}: ${gen.text.slice(0, 80)}…`,
    };
  }

  if (job.kind === "post_reply") {
    let text = (job.draftText ?? "").trim();
    // Draft SKIP / rỗng → soạn lại 1 lần; vẫn xấu → bỏ (không quay vòng).
    if (!text || isAiSkip(text)) {
      await appendActivity("info", "Soạn reply rồi đăng…");
      const gen = await generateDraft(ai, job.notificationKind === "post" ? "browse_reply" : draftKindForJobSource(job.source, job.browseSurface), {
        author: job.authorHandle ?? "",
        text: job.tweetText ?? "",
        tweet_url: job.tweetUrl ?? "",
        tweet_id: job.tweetId ?? "",
        parent_text: job.parentText || "",
        conversation_context: job.conversationContext || "",
      }, { preservePogo: job.source === "pogo", allowSkip: job.source !== "manual", ownerPostReply: job.browseSurface === "mentions" ? ownerPostReplyContext(job.ownerPost, getXConnection().handle || "", { author: job.authorHandle || "", tweetId: job.tweetId || "", text: job.tweetText || "" }) : undefined });
      if (!gen.ok) return aiFailure(gen, job.source === "pogo");
      if (gen.skipped) return { ok: true, skipped: true, error: "skip_reply", message: "AI chọn SKIP_REPLY." };
      if (!gen.text.trim() || isAiSkip(gen.text)) {
        if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: "blocked", error: "empty_text" });
        return {
          ok: true,
          skipped: true,
          error: "empty_text",
          message: replyBlockMessage("empty_text", job.tweetId),
        };
      }
      text = gen.text.trim();
    }
    let r = await requestReply({ tweetId: job.tweetId, tweetUrl: job.tweetUrl, text, ownHandle: settings.ownHandle || getXConnection().handle });
    // Navigate chỉ thử 1 lần thêm — fail thì bỏ, không lặp 3 vòng.
    if (r.error === "navigating_tweet" || r.error === "need_navigate_tweet") {
      await appendActivity("info", "Mở tweet để comment…");
      const ready = await waitUntilOnTweet(job.tweetId, job.tweetUrl, 14_000);
      if (ready) {
        await sleep(randomBetween(700, 1200));
        r = await requestReply({ tweetId: job.tweetId, tweetUrl: job.tweetUrl, text, ownHandle: settings.ownHandle || getXConnection().handle });
      }
    }
    if (r.error === "reply_identity_missing" || r.error === "reply_history_unavailable") {
      return { ok: false, error: r.error, draftText: text, message: "Chưa gửi reply — không đọc được tài khoản hoặc lịch sử gửi." };
    }
    if ((r.ok && r.detail === "reply_attempt_exists") ||
        r.error === "reply_submission_uncertain" ||
        ["timeout", "port_closed", "port_disconnected", "disconnected"].includes(r.error ?? "")) {
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: "uncertain", error: r.error ?? r.detail });
      return {
        ok: true, skipped: true, draftText: text,
        error: r.detail === "reply_attempt_exists" ? "reply_attempt_exists" : r.error,
        message: r.detail === "reply_attempt_exists"
          ? "Đã có lần gửi reply cho bài này — bỏ qua để tránh trùng."
          : "Mất kết nối khi gửi reply — bỏ qua để tránh trùng.",
      };
    }
    if (r.ok && r.detail === "already_replied") {
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: "confirmed" });
      return {
        ok: true,
        skipped: true,
        draftText: text,
        error: "already_replied",
        message: `Đã có reply của mình trên X — bỏ comment lần 2 (${job.tweetId ?? ""})`,
      };
    }
    if (r.ok) {
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true });
      return { ok: true, draftText: text, message: `Đã gửi reply trên X (${job.tweetId ?? ""})`, detail: r.detail };
    }
    if (r.error === "navigating_tweet" || r.error === "need_navigate_tweet") {
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: "blocked", error: "navigate_timeout" });
      return {
        ok: true,
        skipped: true,
        draftText: text,
        error: "navigate_timeout",
        message: replyBlockMessage("navigate_timeout", job.tweetId),
      };
    }
    if (isReplyAudienceBlocked(r.error)) {
      const err = normalizeReplyError(r.error);
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: "blocked", error: err });
      return {
        ok: true,
        skipped: true,
        draftText: text,
        error: err || r.error,
        message: replyBlockMessage(err || r.error || "reply_restricted", job.tweetId),
      };
    }
    // mapX failure — nếu vẫn là lỗi skip (prefix lạ), bỏ tweet thay vì fail×3 pause.
    const mapped = mapX(r, `Đã comment/reply ${job.tweetId ?? ""}`);
    if (!mapped.ok && isReplyAudienceBlocked(mapped.error)) {
      const err = normalizeReplyError(mapped.error);
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { reply: true, localState: "blocked", error: err });
      return {
        ok: true,
        skipped: true,
        draftText: text,
        error: err || mapped.error,
        message: replyBlockMessage(err || mapped.error || "reply_restricted", job.tweetId),
      };
    }
    return mapped;
  }

  if (job.kind === "post_quote") {
    let text = (job.draftText ?? "").trim();
    if (!text) {
      await appendActivity("info", "Chưa có draft — soạn quote rồi đăng luôn…");
      const gen = await generateDraft(ai, "quote", {
        author: job.authorHandle ?? "",
        text: job.tweetText ?? "",
        tweet_url: job.tweetUrl ?? "",
        tweet_id: job.tweetId ?? "",
      }, { preservePogo: job.source === "pogo" });
      if (!gen.ok) return aiFailure(gen, job.source === "pogo");
      if (!gen.text.trim()) {
        return { ok: false, error: "empty_draft", message: "Không soạn được quote" };
      }
      text = gen.text.trim();
    }
    const r = await requestQuote({ tweetId: job.tweetId, tweetUrl: job.tweetUrl, text });
    if ((r.ok && r.detail === "quote_attempt_exists") || ["quote_submission_uncertain", "reply_history_unavailable", "reply_identity_missing", "timeout", "port_closed"].includes(r.error ?? "")) {
      if (job.tweetId) await markPogoProgress(job.tweetId, job.authorHandle, { quote: true, localState: "uncertain", error: r.error ?? r.detail });
      return { ok: true, skipped: true, draftText: text, error: r.error ?? r.detail, message: "Quote chưa rõ kết quả hoặc đã gửi trước đó — không đăng lại." };
    }
    return r.ok
      ? { ok: true, draftText: text, message: job.source === "pogo"
        ? `Đã gửi quote ${job.tweetId ?? ""} — chờ Pogo ghi nhận`
        : `${r.detail === "quote_confirmed" ? "Đã quote trên X" : "Đã gửi quote trên X — chờ xác nhận"} (${job.tweetId ?? ""})`, detail: r.detail }
      : mapX(r, `Đã quote ${job.tweetId ?? ""}`);
  }

  return { ok: false, error: "unknown_job", message: "unknown" };
}

function mapX(r: XActionResult, successMsg: string): JobOutcome {
  if (r.ok) return { ok: true, message: successMsg + (r.detail ? ` (${r.detail})` : "") };
  const nav =
    isBrowseNavigatingError(r.error) ||
    r.error === "navigating_tweet" ||
    r.error === "navigating_profile" ||
    r.error === "need_navigate_tweet" ||
    r.error === "need_navigate_profile";
  return { ok: false, error: r.error, detail: r.detail, message: r.error ?? "x_failed", navigating: nav };
}
