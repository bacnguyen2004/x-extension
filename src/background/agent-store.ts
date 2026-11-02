/**
 * Persist Agent settings / runtime / queue / activity.
 * Tick thật ủy quyền cho agent-runner.ts.
 */

import {
  applySpeedPreset,
  createDefaultAgentSettings,
  createEmptyDailyStats,
  createInitialRuntime,
  sanitizeAgentSettings,
  todayKey,
  type ActivityEntry,
  type AgentDailyStats,
  type AgentPublicState,
  type AgentRuntime,
  type AgentSettings,
  type AgentSpeedPreset,
} from "../domain/agent-settings.ts";
import {
  createEmptyQueue,
  pruneDisabledActionJobs,
  sanitizeQueue,
  upsertJob,
  markJob,
  type AgentQueueState,
} from "../domain/agent-queue.ts";
import { runAgentTick, runFollowPostBundle } from "./agent-runner.ts";
import { buildBrowseJobs } from "../agent/planner.ts";
import { withDailyTargets, dailyActionReached } from "../domain/daily-targets.ts";
import { loadAiSettings } from "./ai-settings-store.ts";
import type { TimelineTweet } from "../x/timeline.ts";
import { notifyTelegram } from "./telegram-notify.ts";
import { readAdaptiveRest } from "../domain/adaptive-rest.ts";
import { recordReportIssue, recordReportReceipts, recordReportRuntime, recordReportStats } from "./operational-report.ts";
import { pullPogoWhenEmpty } from "./pogo-demand-feed.ts";
import { loadPogoRetweetPower } from "./pogo-retweet-store.ts";
import { loadPogoSettlementClock } from "./pogo-settlement-store.ts";
import { pogoSettlementCheckAt } from "../domain/pogo-settlement.ts";
import { loadFollowUsage, resetFollowUsage } from "./follow-budget.ts";
import { getXWorker, withXTurn } from "./x-coordinator.ts";
import { getXConnection, requestScrollBurst, stopAllXBrowse } from "./x-bridge.ts";
import { pauseScanClock } from "../domain/feed-rotation.ts";

const SETTINGS_KEY = "xContentCreator.agentSettings.v1";
const RUNTIME_KEY = "xContentCreator.agentRuntime.v1";
const STATS_KEY = "xContentCreator.agentStats.v1";
const ACTIVITY_KEY = "xContentCreator.agentActivity.v1";
const QUEUE_KEY = "xContentCreator.agentQueue.v1";
const MAX_ACTIVITY = 200;

let settingsCache: AgentSettings | null = null;
let runtimeCache: AgentRuntime | null = null;
let statsCache: AgentDailyStats | null = null;
let activityCache: ActivityEntry[] | null = null;
let queueCache: AgentQueueState | null = null;
let tickInFlight = false;
let runGeneration = 0;

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function scheduleNextTick(at: number): Promise<void> {
  try {
    await chrome.alarms.create("x-agent-once", { when: Math.max(Date.now() + 1000, at) });
  } catch {
    // ignore
  }
}

export async function loadAgentSettings(): Promise<AgentSettings> {
  if (settingsCache) return settingsCache;
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  const before = raw[SETTINGS_KEY] as { maxLoops?: number; sessionLimit?: number } | undefined;
  settingsCache = sanitizeAgentSettings(raw[SETTINGS_KEY]);
  // Migrate: sessionLimit cũ (vd. 80) < maxLoops → nâng và ghi lại.
  if (
    before &&
    typeof before.sessionLimit === "number" &&
    before.sessionLimit < settingsCache.sessionLimit
  ) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
  }
  return settingsCache;
}

export async function saveAgentSettings(raw: unknown): Promise<AgentSettings> {
  const previous = await loadAgentSettings();
  const clean = sanitizeAgentSettings(raw);
  settingsCache = clean;
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  if (previous.adaptiveRest !== false && clean.adaptiveRest === false) {
    const runtime = await loadRuntime();
    if (["high_load", "normal_load", "low_load"].includes(runtime.adaptiveRest?.reason || "")) {
      runtime.adaptiveRest = undefined;
      if (!tickInFlight && runtime.status === "waiting" && !runtime.killSwitch) {
        runtime.nextActionAt = Date.now() + 1000;
        await scheduleNextTick(runtime.nextActionAt);
      }
      await persistRuntime();
    }
  }

  // Behavior tắt FL/RT/… → bỏ ngay khỏi hàng đợi (không chờ tick).
  let queue = await loadQueue();
  let recoveredReplies = 0;
  if (clean.ownHandle && clean.ownHandle.toLowerCase() !== previous.ownHandle.toLowerCase()) {
    queue = { jobs: queue.jobs.map(job => {
      if (job.kind !== "post_reply" || !["failed", "skipped"].includes(job.status) || job.error !== "reply_identity_missing") return job;
      recoveredReplies++;
      return { ...job, status: "pending" as const, error: null, verification: undefined, pogoVerify: undefined, updatedAt: Date.now() };
    }) };
  }
  const pruned = pruneDisabledActionJobs(queue, clean.actions);
  if (pruned.skipped > 0 || recoveredReplies > 0) {
    queueCache = pruned.queue;
    await chrome.storage.local.set({ [QUEUE_KEY]: pruned.queue });
    if (pruned.skipped > 0) await appendActivity("info", `Đã bỏ ${pruned.skipped} job vì Behavior tắt / Like không còn là task.`);
    if (recoveredReplies > 0) await appendActivity("info", `Đã cập nhật username — mở lại ${recoveredReplies} reply chưa gửi do thiếu tài khoản.`);
    broadcastAgent();
  }

  if (clean.delaySecMin !== previous.delaySecMin || clean.delaySecMax !== previous.delaySecMax) {
    const runtime = await loadRuntime();
    if (!tickInFlight && runtime.status === "waiting" && !runtime.killSwitch && !(runtime.adaptiveRest?.resumeAt && runtime.adaptiveRest.resumeAt > Date.now())) {
      runtime.nextActionAt = Date.now() + randomBetween(clean.delaySecMin, clean.delaySecMax) * 1000;
      await scheduleNextTick(runtime.nextActionAt);
      await persistRuntime();
      broadcastAgent();
    }
  }
  return clean;
}

export async function applyAgentSpeedPreset(preset: AgentSpeedPreset): Promise<AgentSettings> {
  const current = await loadAgentSettings();
  return saveAgentSettings(applySpeedPreset(current, preset));
}

async function loadRuntime(): Promise<AgentRuntime> {
  if (runtimeCache) return runtimeCache;
  const raw = await chrome.storage.local.get(RUNTIME_KEY);
  const saved = raw[RUNTIME_KEY];
  runtimeCache = {
    ...createInitialRuntime(),
    ...(saved && typeof saved === "object" ? (saved as AgentRuntime) : {}),
  };
  // MV3: SW ngủ rồi dậy — giữ agent chạy tiếp (trừ khi Kill switch).
  if (
    !runtimeCache.killSwitch &&
    (runtimeCache.status === "running" || runtimeCache.status === "waiting")
  ) {
    const due = runtimeCache.adaptiveRest?.resumeAt ?? runtimeCache.nextActionAt ?? Date.now() + 3000;
    runtimeCache = {
      ...runtimeCache,
      status: "waiting",
      detail: runtimeCache.adaptiveRest?.resumeAt ? runtimeCache.detail : "Service worker dậy — tiếp tục agent…",
      nextActionAt: due,
    };
    await persistRuntime();
    await scheduleNextTick(due);
    // Không await activity ở đây để tránh vòng loadRuntime đệ quy qua appendActivity.
    void appendActivityAfterBoot("info", "SW dậy — agent tự chạy tiếp (không cần Start lại).");
  } else if (runtimeCache.killSwitch && runtimeCache.status !== "paused") {
    runtimeCache = {
      ...runtimeCache,
      status: "paused",
      detail: "Kill switch đang bật.",
      nextActionAt: null,
    };
    await persistRuntime();
  }
  return runtimeCache;
}

/** Ghi activity sau khi runtimeCache đã set — tránh re-enter loadRuntime. */
async function appendActivityAfterBoot(
  level: ActivityEntry["level"],
  message: string,
): Promise<void> {
  try {
    const list = activityCache ?? (await loadActivity());
    const entry: ActivityEntry = { id: uid(), at: Date.now(), level, message };
    activityCache = [entry, ...list].slice(0, MAX_ACTIVITY);
    await persistActivity();
  } catch {
    /* ignore */
  }
}

async function persistRuntime(): Promise<void> {
  if (!runtimeCache) return;
  await chrome.storage.local.set({ [RUNTIME_KEY]: runtimeCache });
  await recordReportRuntime(runtimeCache, getXConnection().handle || settingsCache?.ownHandle || statsCache?.account || "unknown");
  if (runtimeCache.status === "paused" || runtimeCache.status === "error" || runtimeCache.consecutiveErrors >= 3) {
    await notifyTelegram(runtimeCache.status === "error" || runtimeCache.consecutiveErrors >= 3 ? "agent_error" : "agent_stopped", { account: getXConnection().handle || settingsCache?.ownHandle });
  }
  if (["no_x_tab", "x_tab_disconnected"].includes(runtimeCache.lastError || "")) await notifyTelegram("agent_error", { account: getXConnection().handle || settingsCache?.ownHandle });
}

async function loadStats(): Promise<AgentDailyStats> {
  const key = todayKey();
  const account = (getXConnection().handle || settingsCache?.ownHandle || "unknown").replace(/^@/, "").toLowerCase();
  if (statsCache && statsCache.date === key && statsCache.account === account) {
    statsCache.follow = (await loadFollowUsage(account)).count;
    return statsCache;
  }
  const storageKey = `${STATS_KEY}.${account}`;
  const raw = await chrome.storage.local.get(storageKey);
  let saved = raw[storageKey];
  if (!saved) {
    const legacy = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY] as AgentDailyStats | undefined;
    if (legacy && legacy.date === key && (!legacy.account || legacy.account === account)) {
      saved = { ...legacy, account };
      await chrome.storage.local.set({ [STATS_KEY]: saved });
    }
  }
  if (saved && typeof saved === "object" && (saved as AgentDailyStats).date === key) {
    statsCache = { ...(saved as AgentDailyStats), account };
  } else {
    statsCache = createEmptyDailyStats(key);
    statsCache.account = account;
  }
  statsCache.follow = (await loadFollowUsage(account)).count;
  await chrome.storage.local.set({ [storageKey]: statsCache });
  return statsCache;
}

async function persistStats(stats?: AgentDailyStats): Promise<void> {
  if (stats) statsCache = stats;
  if (!statsCache) return;
  statsCache.follow = (await loadFollowUsage(statsCache.account || "unknown")).count;
  await chrome.storage.local.set({ [STATS_KEY]: statsCache, [`${STATS_KEY}.${statsCache.account || "unknown"}`]: statsCache });
  await recordReportStats(statsCache);
}

async function loadActivity(): Promise<ActivityEntry[]> {
  if (activityCache) return activityCache;
  const raw = await chrome.storage.local.get(ACTIVITY_KEY);
  const list = raw[ACTIVITY_KEY];
  activityCache = Array.isArray(list) ? (list as ActivityEntry[]).slice(0, MAX_ACTIVITY) : [];
  return activityCache;
}

async function persistActivity(): Promise<void> {
  if (!activityCache) return;
  await chrome.storage.local.set({ [ACTIVITY_KEY]: activityCache.slice(0, MAX_ACTIVITY) });
}

async function loadQueue(): Promise<AgentQueueState> {
  if (queueCache) return queueCache;
  const raw = await chrome.storage.local.get(QUEUE_KEY);
  queueCache = sanitizeQueue(raw[QUEUE_KEY]);
  // Job đang "running" khi SW chết giữa chừng → trả về pending để tick sau làm tiếp.
  let dirty = false;
  queueCache = {
    ...queueCache,
    jobs: queueCache.jobs.map((j) => {
      if (j.status !== "running") return j;
      dirty = true;
      return {
        ...j,
        status: "pending" as const,
        ...((j.kind === "post_reply" || j.kind === "post_quote") ? { verification: "uncertain" as const } : {}),
        error: j.error ?? "sw_interrupted",
        updatedAt: Date.now(),
      };
    }),
  };
  if (dirty) await persistQueue();
  return queueCache;
}

async function persistQueue(queue?: AgentQueueState): Promise<void> {
  if (queue) queueCache = queue;
  if (!queueCache) return;
  await chrome.storage.local.set({ [QUEUE_KEY]: queueCache });
  await recordReportReceipts(getXConnection().handle || settingsCache?.ownHandle || statsCache?.account || "unknown", queueCache);
}

export async function appendActivity(
  level: ActivityEntry["level"],
  message: string,
): Promise<ActivityEntry> {
  const list = await loadActivity();
  const entry: ActivityEntry = { id: uid(), at: Date.now(), level, message };
  activityCache = [entry, ...list].slice(0, MAX_ACTIVITY);
  await persistActivity();
  if (level === "warn" || level === "error") await recordReportIssue(getXConnection().handle || settingsCache?.ownHandle || statsCache?.account || "unknown", level);
  return entry;
}

export async function clearActivity(): Promise<void> {
  activityCache = [];
  await persistActivity();
}

export async function clearQueue(): Promise<AgentPublicState> {
  queueCache = createEmptyQueue();
  await persistQueue();
  await appendActivity("info", "Đã xóa hàng đợi job.");
  broadcastAgent();
  return getAgentPublicState();
}

/** Session changes invalidate Pogo drafts and pending verification for that session. */
export async function clearPogoQueue(): Promise<void> {
  const queue = await loadQueue();
  await persistQueue({ ...queue, jobs: queue.jobs.filter(job => job.source !== "pogo") });
  broadcastAgent();
}

/** Same identity order as receivePogoPower: X tab → own handle → Pogo linked account. */
async function resolvePogoRtAccount(ownHandle?: string | null): Promise<string> {
  const x = getXConnection().handle;
  if (x) return x;
  if (ownHandle && ownHandle.trim()) return ownHandle;
  try {
    const raw = (await chrome.storage.local.get("pogoTaskReader.state"))["pogoTaskReader.state"] as
      | { linked_account?: { handle?: string } }
      | undefined;
    const linked = raw?.linked_account?.handle;
    if (linked && linked.trim()) return linked;
  } catch { /* ignore */ }
  return "unknown";
}

export async function getAgentPublicState(): Promise<AgentPublicState> {
  const [settings, runtime, today, activity, queue] = await Promise.all([
    loadAgentSettings(),
    loadRuntime(),
    loadStats(),
    loadActivity(),
    loadQueue(),
  ]);
  const account = await resolvePogoRtAccount(settings.ownHandle);
  today.pogoRetweets = await loadPogoRetweetPower(account);
  const clock = await loadPogoSettlementClock(account);
  const pending = queue.jobs.filter(job => job.kind !== "post_reply" && job.source === "pogo" && job.pogoVerify && job.verification !== "pogo_recorded" && job.verification !== "blocked");
  const nextChecks = pending.map(job => {
    const first = pogoSettlementCheckAt(job.pogoVerify!.submittedAt ?? job.updatedAt, clock);
    return job.pogoVerify!.attempts === 0 ? first : Math.max(first, job.pogoVerify!.nextCheckAt);
  });
  return {
    pogoSettlement: { nextScanAt: clock?.nextScanAt ?? null, nextCheckAt: nextChecks.length ? Math.min(...nextChecks) : null, pendingCount: pending.length },
    settings,
    runtime,
    today,
    activity,
    x: getXConnection(),
    recentJobs: queue.jobs.slice(0, 20),
  };
}

/** Caller owns the Follow X turn; reuse posting/AI/receipts without starting Agent. */
export async function cancelFollowPostInteraction(account: string, handle: string): Promise<void> {
  let queue = await loadQueue();
  for (const job of queue.jobs) if (job.postFollow && job.expectedAccount === account && job.authorHandle?.toLowerCase() === handle.toLowerCase() && ["pending", "running"].includes(job.status)) {
    queue = markJob(queue, job.id, { status: "skipped", error: "post_follow_cancelled" });
  }
  await persistQueue(queue);
}

export async function interactWithFollowedPost(tweet: TimelineTweet, cancelled: () => boolean, waitForDelay?: (ms: number) => Promise<void>): Promise<{ complete: boolean; detail: string }> {
  const account = (getXConnection().handle || "").replace(/^@/, "").toLowerCase();
  const stopped = () => cancelled() || (getXConnection().handle || "").replace(/^@/, "").toLowerCase() !== account;
  if (!account || stopped() || tweet.authorHandle.toLowerCase() === account) return { complete: true, detail: "Bỏ tương tác: tài khoản không hợp lệ." };
  const saved = await loadAgentSettings(), stats = await loadStats();
  const settings = withDailyTargets({ ...saved, executeActions: true, randomAuthorFollow: false,
    actions: { like: true, reply: true, follow: false, retweet: false, quote: false } }, stats);
  const ai = await loadAiSettings(chrome.runtime.id);
  let queue = await loadQueue();
  for (const job of queue.jobs) if (job.postFollow && job.expectedAccount === account && job.tweetId === tweet.tweetId &&
      ["pending", "running"].includes(job.status) && dailyActionReached(settings, stats, job.kind)) {
    queue = markJob(queue, job.id, { status: "skipped", error: "daily_target_reached" });
  }
  let jobs = queue.jobs.filter(j => j.postFollow && j.expectedAccount === account && j.tweetId === tweet.tweetId && ["pending", "running"].includes(j.status));
  if (!jobs.length) {
    jobs = buildBrowseJobs({ candidate: tweet, settings, queue, executeActions: true, hasApiKey: !!ai.apiKey.trim(),
      rolls: { engage: true, like: true, reply: true, follow: false, retweet: false } }).map(job => {
      delete job.browseSurface; delete job.likeOnFeed;
      return { ...job, postFollow: true, expectedAccount: account, reason: "Follow theo link · tương tác bài mới nhất" };
    });
    for (const job of jobs) queue = upsertJob(queue, job);
  }
  if (stopped()) return { complete: false, detail: "Đã dừng tương tác sau Follow." };
  await persistQueue(queue);
  if (!jobs.length) return { complete: true, detail: "Bài mới nhất đã xử lý hoặc đã đủ hạn mức." };
  const result = await runFollowPostBundle({ settings, runtime: { ...createInitialRuntime(), status: "running" }, stats, queue,
    extensionId: chrome.runtime.id, isCancelled: stopped, waitForDelay, appendActivity: async (level, message) => { await appendActivity(level, message); },
    persistQueue: async next => { if ((getXConnection().handle || "").replace(/^@/, "").toLowerCase() === account) await persistQueue(next); },
    persistStats: async next => { if ((getXConnection().handle || "").replace(/^@/, "").toLowerCase() === account) await persistStats(next); },
  }, jobs, ai);
  const pending = result.queue.jobs.some(j => j.postFollow && j.expectedAccount === account && j.tweetId === tweet.tweetId && ["pending", "running"].includes(j.status));
  broadcastAgent();
  return { complete: !pending, detail: `${result.runtime.detail || "Đã xử lý bài mới nhất."}${!ai.apiKey.trim() ? " · Thiếu API key để Reply." : ""}` };
}

function broadcastAgent(): void {
  void getAgentPublicState().then((agent) => {
    chrome.runtime.sendMessage({ type: "agent_state", agent }).catch(() => {});
  });
}

export async function startMockAgent(): Promise<AgentPublicState> {
  const runtime = await loadRuntime();
  if (runtime.killSwitch) {
    await appendActivity("warn", "Kill switch đang BẬT — không start được.");
    runtime.status = "paused";
    runtime.detail = "Kill switch đang bật.";
    await persistRuntime();
    broadcastAgent();
    return getAgentPublicState();
  }

  const settings = await loadAgentSettings();
  const x = getXConnection();
  // Chỉ cần tab X; không nhận diện / chặn theo login.
  runtime.mockMode = !x.connected;
  runtime.status = "waiting";
  // Mỗi lần Start = session mới — reset vòng để không kẹt “Đạt giới hạn”.
  runtime.startedAt = Date.now();
  runtime.loopCount = 0;
  runtime.lastError = null;
  runtime.consecutiveErrors = 0;
  const rest = readAdaptiveRest(runtime.adaptiveRest, Date.now());
  runtime.adaptiveRest = settings.adaptiveRest !== false ? rest : undefined;
  runtime.nextActionAt = rest.resumeAt && settings.adaptiveRest !== false ? rest.resumeAt : Date.now() + randomBetween(3, 8) * 1000;
  await scheduleNextTick(runtime.nextActionAt);

  if (runtime.mockMode) {
    runtime.detail = "Đang chờ tab X kết nối…";
    await appendActivity("info", runtime.detail);
  } else {
    runtime.detail = `Agent chạy · ${x.handle ? `@${x.handle}` : "tab X"} · execute=${settings.executeActions}`;
    await appendActivity(
      "info",
      `Start agent (session mới). maxLoops=${settings.maxLoops}, sessionLimit=${settings.sessionLimit}, execute=${settings.executeActions}.`,
    );
  }

  await persistRuntime();
  await notifyTelegram("agent_started", { account: x.handle || settings.ownHandle });
  broadcastAgent();
  return getAgentPublicState();
}

export async function pauseMockAgent(reason = "Đã tạm dừng agent."): Promise<AgentPublicState> {
  runGeneration += 1;
  
  if (getXWorker() === "agent") stopAllXBrowse();
  const runtime = await loadRuntime();
  runtime.status = "paused";
  runtime.detail = reason;
  runtime.nextActionAt = null;
  // Giữ nguồn + thời gian còn lại; không tính khoảng Pause vào thời gian quét.
  if (runtime.browseRotation && (runtime.browseRotation.clockRunning || runtime.browseRotation.phase === "scanning" || runtime.browseRotation.phase === "switch_pending")) {
    runtime.browseRotation = pauseScanClock(runtime.browseRotation, Date.now());
  }
  await persistRuntime();
  await appendActivity("warn", reason);
  broadcastAgent();
  return getAgentPublicState();
}

export async function setKillSwitch(on: boolean): Promise<AgentPublicState> {
  if (on) { runGeneration += 1;  }
  const runtime = await loadRuntime();
  runtime.killSwitch = on;
  if (on) {
    stopAllXBrowse();
    runtime.status = "paused";
    runtime.nextActionAt = null;
    runtime.detail = "Kill switch BẬT.";
    await appendActivity("error", "Kill switch BẬT.");
  } else {
    runtime.detail = "Kill switch TẮT.";
    await appendActivity("info", "Kill switch TẮT.");
  }
  await persistRuntime();
  broadcastAgent();
  return getAgentPublicState();
}

export async function resetDailyStats(): Promise<AgentPublicState> {
  const account = (await loadStats()).account;
  await resetFollowUsage(account || "unknown");
  statsCache = createEmptyDailyStats();
  statsCache.account = account;
  await persistStats();
  await appendActivity("info", "Đã reset thống kê hôm nay.");
  broadcastAgent();
  return getAgentPublicState();
}

export async function tickMockAgent(): Promise<AgentPublicState> {
  if (tickInFlight) return getAgentPublicState();
  tickInFlight = true;
  try {
    return await tickAgentOnce();
  } finally {
    tickInFlight = false;
  }
}

async function tickAgentOnce(): Promise<AgentPublicState> {
  const generation = runGeneration;
  const runtime = await loadRuntime();
  if (runtime.killSwitch || runtime.status === "paused" || runtime.status === "idle" || runtime.status === "error") {
    return getAgentPublicState();
  }

  const settings = await loadAgentSettings();
  if (generation !== runGeneration) return getAgentPublicState();
  const now = Date.now();
  const xBlock = getXConnection().accountBlock;
  if (settings.executeActions && xBlock) {
    runtime.status = "paused";
    runtime.lastError = xBlock;
    runtime.detail = "X yêu cầu xác minh hoặc đang giới hạn thao tác — xử lý thủ công rồi bấm Bắt đầu.";
    runtime.nextActionAt = null;
    await persistRuntime();
    await appendActivity("error", runtime.detail);
    broadcastAgent();
    return getAgentPublicState();
  }
  if (runtime.nextActionAt != null && now < runtime.nextActionAt) {
    runtime.status = "waiting";
    // Keep the last action / browsing reason visible; the panel counts down separately.
    if (!runtime.detail) runtime.detail = "Chờ lượt tiếp theo…";
    await persistRuntime();
    broadcastAgent();
    return getAgentPublicState();
  }

  if (settings.continuousRun === false && (runtime.loopCount >= settings.maxLoops || runtime.loopCount >= settings.sessionLimit)) {
    if (getXWorker() === "agent") stopAllXBrowse();
    runtime.status = "paused";
    runtime.detail = `Đạt giới hạn vòng/session (loop ${runtime.loopCount}/${settings.maxLoops}, session ${settings.sessionLimit}). Bấm Start để chạy session mới.`;
    runtime.nextActionAt = null;
    await persistRuntime();
    await appendActivity("warn", runtime.detail);
    broadcastAgent();
    return getAgentPublicState();
  }

  const stats = await loadStats();
  const queue = await loadQueue();
  const result = await runAgentTick({
    pullPogo: pullPogoWhenEmpty,
    settings,
    runtime: { ...runtime },
    stats,
    queue,
    appendActivity,
    persistQueue,
    persistStats,
    extensionId: chrome.runtime.id,
    isCancelled: () => generation !== runGeneration,
    onProgress: async (progress) => {
      if (generation !== runGeneration) return;
      runtimeCache = { ...progress };
      await persistRuntime();
      broadcastAgent();
    },
  });

  if (generation !== runGeneration) {
    broadcastAgent();
    return getAgentPublicState();
  }
  runtimeCache = result.runtime;
  statsCache = result.stats;
  queueCache = result.queue;

  if (result.nextDelayMs <= 0) {
    runtimeCache.nextActionAt = null;
    await persistRuntime();
    broadcastAgent();
    return getAgentPublicState();
  }

  runtimeCache.status = "waiting";
  const latestSettings = await loadAgentSettings();
  if (generation !== runGeneration) return getAgentPublicState();
  const delayChanged = latestSettings.delaySecMin !== settings.delaySecMin || latestSettings.delaySecMax !== settings.delaySecMax;
  const restAt = runtimeCache.adaptiveRest?.resumeAt;
  const nextDelayMs = restAt && restAt > Date.now() ? restAt - Date.now() : delayChanged && runtimeCache.consecutiveErrors === 0
    ? randomBetween(latestSettings.delaySecMin, latestSettings.delaySecMax) * 1000
    : result.nextDelayMs;
  runtimeCache.nextActionAt = Date.now() + nextDelayMs;
  await scheduleNextTick(runtimeCache.nextActionAt);
  await persistRuntime();
  broadcastAgent();
  return getAgentPublicState();
}

export async function forceScrollOnce(): Promise<{ ok: boolean; error?: string; agent: AgentPublicState }> {
  return withXTurn("manual", forceScrollOwned);
}

async function forceScrollOwned(): Promise<{ ok: boolean; error?: string; agent: AgentPublicState }> {
  const result = await requestScrollBurst({
    distancePx: 1000,
    steps: 4,
    stepDelayMs: 350,
    readMs: 800,
  });
  if (result.ok) {
    const stats = await loadStats();
    stats.scrollSessions += 1;
    await persistStats(stats);
    await appendActivity("action", `Cuộn thử ngay ~${result.scrolledPx ?? 1000}px`);
  } else {
    await appendActivity("warn", `Cuộn thử thất bại: ${result.error ?? "unknown"}`);
  }
  broadcastAgent();
  return {
    ok: result.ok,
    error: result.ok ? undefined : result.error,
    agent: await getAgentPublicState(),
  };
}

export function notifyAgentUi(): void {
  broadcastAgent();
}

/**
 * Gọi khi SW init / alarm: nếu agent đang waiting thì bảo đảm có alarm định kỳ + one-shot.
 * Trả về true nếu agent vẫn được coi là đang chạy.
 */
export async function ensureAgentAlarmsAfterWake(): Promise<boolean> {
  const runtime = await loadRuntime();
  if (runtime.killSwitch) return false;
  if (runtime.status !== "waiting" && runtime.status !== "running") return false;
  const due = runtime.nextActionAt ?? Date.now() + 2000;
  if (runtime.nextActionAt == null) {
    runtime.nextActionAt = due;
    runtime.status = "waiting";
    await persistRuntime();
  }
  await scheduleNextTick(Math.max(due, Date.now() + 1000));
  try {
    await chrome.alarms.create("x-agent-mock-tick", { periodInMinutes: 1 });
  } catch {
    /* ignore */
  }
  return true;
}
