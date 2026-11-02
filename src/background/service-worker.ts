import { withXTurn, startExclusiveX } from "./x-coordinator.ts";
import { notifyTelegram, TELEGRAM_SUMMARY_ALARM } from "./telegram-notify.ts";
import { runTelegramOps, TELEGRAM_OPS_ALARM } from "./telegram-ops.ts";
import { getSelectedXTabId } from "./x-bridge.ts";
import { readFollowHistoryView, rememberFollow } from "./follow-history.ts";
import { getXAccountForSender } from "./x-bridge.ts";
import { syncPogoFeedMeta } from "./pogo-feed-meta.ts";
import { resetPogoDemandPull } from "./pogo-demand-feed.ts";
import {
  claimPogoBountyById,
  ensurePogoBountyAlarm,
  getPogoBountyPublicState,
  onPogoBountyEvent,
  pollPogoBounties,
  POGO_BOUNTY_ALARM,
  setPogoBountyAutoJoin,
  syncPogoBounties,
} from "./pogo-bounty-store.ts";
import { createNativeAuthProvider, getNativeAuthState, setNativeAuthEnabled, POGO_AUTH_ALARM } from "./pogo-native-auth.ts";
import { clearCampaignCache, applyScan } from "../domain/merge.ts";
import { buildExportPayload } from "../domain/export.ts";
import { alarmActionForMode, toPublicState } from "../domain/status.ts";
import {
  createInitialState,
  type DataSource,
  type PersistedState,
  type PublicState,
} from "../domain/types.ts";
import { fetchPogoFeed } from "../api/feed-client.ts";
import {
  applyProviderPreset,
  sanitizeAiSettings,
  type AiProvider,
} from "../domain/ai-settings.ts";
import { generateManualReply } from "./manual-reply.ts";
import { getAiUsage, saveAiPrices } from "./ai-usage-store.ts";
import { isAiSkip } from "../agent/prompts.ts";
import {
  clearAiApiKey,
  loadAiSettings,
  publicFromSettings,
  saveAiSettings,
} from "./ai-settings-store.ts";
import { fetchSorsaScore, fetchSorsaScoresBatch } from "./sorsa-store.ts";
import {
  appendActivity,
  applyAgentSpeedPreset,
  clearActivity,
  clearQueue,
  clearPogoQueue,
  ensureAgentAlarmsAfterWake,
  forceScrollOnce,
  getAgentPublicState,
  loadAgentSettings,
  notifyAgentUi,
  pauseMockAgent,
  resetDailyStats,
  saveAgentSettings,
  setKillSwitch,
  startMockAgent,
  tickMockAgent,
} from "./agent-store.ts";
import { onPogoFeedMetaSynced, onPogoStatePatched } from "./pogo-state-access.ts";
import {
  clearApiSessionToken,
  ensureApiSessionHydrated,
  getApiSessionToken,
  getApiSessionTokenAsync,
  getApiSessionRevision,
  setApiSessionToken,
  setApiSessionProvider,
} from "./api-session.ts";
import {
  getFollowPublicState,
  onFollowAlarm,
  startFollowRunner,
  stopFollowRunner,
} from "./follow-runner.ts";
import { loadFollowSettings, saveFollowSettings } from "./follow-store.ts";
import { sanitizeFollowSettings } from "../domain/follow-settings.ts";
import {
  clearLinkList,
  loadLinkList,
  saveLinkListFromText,
} from "./link-list-store.ts";
import {
  getUnfollowPublicState,
  onUnfollowAlarm,
  startUnfollowRunner,
  stopUnfollowRunner,
} from "./unfollow-runner.ts";
import { loadUnfollowSettings, saveUnfollowSettings } from "./unfollow-store.ts";
import { sanitizeUnfollowSettings } from "../domain/unfollow-settings.ts";
import {
  filterXServices,
  smmClearHistory,
  smmClearKey,
  smmGetState,
  smmPlaceOrder,
  smmRequest,
  smmRetryFailedOrders,
  smmSaveSettings,
  smmStartPostScan,
  smmStopPostScan,
} from "./smm-runner.ts";
import { attachXPort, ensureXTabsConnected, pingAllXTabs, selectXTab, getXConnection } from "./x-bridge.ts";
import type { AgentSpeedPreset } from "../domain/agent-settings.ts";
import {
  isExtensionPageSender,
  isXTabSender,
  type MessageSenderLike,
} from "../messages/validate.ts";

const STORAGE_KEY = "pogoTaskReader.state";
const ALARM_NAME = "pogo-rescan";
const AGENT_ALARM = "x-agent-mock-tick";
const AGENT_ONCE = "x-agent-once";
const LOG = "[x-content-creator]";

let state: PersistedState = createInitialState();
let ready: Promise<void> | null = null;
let apiFetchInFlight = false;

async function loadState(): Promise<void> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const saved = raw[STORAGE_KEY];
  if (saved && typeof saved === "object") {
    state = { ...createInitialState(), ...(saved as PersistedState) };
    // Migrate old persisted source settings to API.
    if (state.data_source !== "api") {
      state = { ...state, data_source: "api" };
    }
  } else {
    state = createInitialState();
  }
}

async function saveState(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function syncAlarm(): Promise<void> {
  if (alarmActionForMode(state.mode) === "create") {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
}

function statusOpts() {
  const token = getApiSessionToken();
  return { connected: !!token, apiTokenPresent: !!token };
}

async function statusOptsAsync() {
  const token = await getApiSessionTokenAsync();
  return { connected: !!token, apiTokenPresent: !!token };
}

function publicState(): PublicState {
  return toPublicState(state, statusOpts());
}

function broadcastState(): void {
  const payload = { type: "state", state: publicState() };
  chrome.runtime.sendMessage(payload).catch(() => {
    // Side panel có thể đang đóng.
  });
}

function clearApiToken(): void {
  void clearApiSessionToken();
}

async function runApiFetch(): Promise<{ ok: boolean; error?: string }> {
  if (apiFetchInFlight) return { ok: false, error: "busy" };
  const apiToken = await getApiSessionTokenAsync();
  if (!apiToken) {
    state = {
      ...state,
      api_last_error: "Chưa có Bearer token trong phiên.",
      api_http_status: null,
      login_required: true,
    };
    await saveState();
    broadcastState();
    return { ok: false, error: "no_token" };
  }

  apiFetchInFlight = true;
  const revision = getApiSessionRevision();
  try {
    const result = await fetchPogoFeed(apiToken);
    if (revision !== getApiSessionRevision()) return { ok: false, error: "session_changed" };
    if (!result.ok) {
      state = {
        ...state,
        login_required: result.login_required,
        api_last_error: result.error,
        api_http_status: result.httpStatus,
        ever_connected: state.ever_connected || result.login_required,
      };
      await saveState();
      broadcastState();
      return { ok: false, error: result.login_required ? "login_required" : "api_error" };
    }

    state = applyScan(state, result.snapshot);
    state = {
      ...state,
      login_required: false,
      api_last_error: null,
      api_http_status: result.httpStatus,
      ever_connected: true,
    };
    await saveState();
    const agentSettings = await loadAgentSettings();
    await syncPogoFeedMeta(result.snapshot, { ownHandle: agentSettings.ownHandle, publish: notifyAgentUi });
    void syncPogoBounties();
    broadcastState();
    return { ok: true };
  } finally {
    apiFetchInFlight = false;
  }
}

async function init(): Promise<void> {
  await loadState();
  await ensureApiSessionHydrated();
  // Agent đánh dấu reply/RT/… done → đồng bộ memory SW (tránh saveState ghi đè) + refresh Sources.
  onPogoStatePatched((patched) => {
    state = { ...state, campaigns: patched.campaigns, campaign_order: patched.campaign_order,
      last_dom_scan_at: patched.last_dom_scan_at, last_data_change_at: patched.last_data_change_at,
      linked_account: patched.linked_account, feed_visible: patched.feed_visible,
      login_required: patched.login_required, api_last_error: patched.api_last_error, api_http_status: patched.api_http_status };
    broadcastState();
  });
  onPogoFeedMetaSynced(notifyAgentUi);
  onPogoBountyEvent((level, message) => { void appendActivity(level, message); });
  setApiSessionProvider(createNativeAuthProvider(async (token, verified, revision) => {
    const settings = await loadAgentSettings();
    const expected = (getXConnection().handle || state.linked_account?.handle || settings.ownHandle || "").replace(/^@/, "").toLowerCase();
    const linked = verified.snapshot.linked_account?.handle.replace(/^@/, "").toLowerCase();
    if (!linked) throw new Error("pogo_identity_unverified");
    if (expected && linked !== expected) throw new Error("pogo_account_mismatch");
    if (revision !== getApiSessionRevision()) return;
    await setApiSessionToken(token);
    await resetPogoDemandPull();
    state = { ...applyScan(state, verified.snapshot), login_required: false, api_last_error: null, api_http_status: 200, ever_connected: true };
    await saveState();
    await syncPogoFeedMeta(verified.snapshot, { ownHandle: settings.ownHandle, publish: notifyAgentUi });
    void syncPogoBounties();
    broadcastState();
  }));
  if ((await getNativeAuthState()).enabled) await chrome.alarms.create(POGO_AUTH_ALARM, { periodInMinutes: 1 });
  // Do not postpone the hourly summary each time an MV3 worker wakes.
  if (!(await chrome.alarms.get(TELEGRAM_SUMMARY_ALARM))) await chrome.alarms.create(TELEGRAM_SUMMARY_ALARM, { periodInMinutes: 60 });
  if (!(await chrome.alarms.get(TELEGRAM_OPS_ALARM))) await chrome.alarms.create(TELEGRAM_OPS_ALARM, { periodInMinutes: 1 });
  await ensurePogoBountyAlarm();
  void pollPogoBounties();
  // Nối lại port X sớm — Map port mất khi SW ngủ dù tab x.com vẫn còn.
  void ensureXTabsConnected(5000).catch(() => {});
  await syncAlarm();
  // SW MV3 ngủ/dậy: nếu agent đang waiting thì giữ alarm + tự chạy tiếp.
  const agentAlive = await ensureAgentAlarmsAfterWake();
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Một số bản Chrome cũ.
  }
  console.info(LOG, "worker ready", state.mode, state.data_source, agentAlive ? "agent-resume" : "agent-idle");
}

function ensureReady(): Promise<void> {
  if (!ready) ready = init();
  return ready;
}

void ensureReady();

chrome.runtime.onInstalled.addListener(() => {
  void ensureReady();
});

chrome.runtime.onConnect.addListener((port) => {
  void ensureReady().then(() => {
    if (port.name === "x-tab") {
      const ok = attachXPort(port, chrome.runtime.id);
      if (ok) {
        port.onMessage.addListener(() => notifyAgentUi());
        port.onDisconnect.addListener(() => notifyAgentUi());
        notifyAgentUi();
      }
      return;
    }

    port.disconnect();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void ensureReady().then(async () => {
    try {
      const result = await handlePanelMessage(message, sender as MessageSenderLike);
      sendResponse(result);
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  });
  return true;
});

async function handlePanelMessage(
  message: unknown,
  sender: MessageSenderLike,
): Promise<object> {
  if (!message || typeof message !== "object") return { ok: false, error: "bad_message" };
  const m = message as Record<string, unknown>;

  if (m.type === "x_following_observed") {
    if (!isXTabSender(sender, chrome.runtime.id)) return { ok: false, error: "unauthorized" };
    const account = getXAccountForSender(sender);
    if (!account) return { ok: false, error: "follow_identity_missing" };
    const entries = Array.isArray(m.entries) ? m.entries.slice(0, 50) : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.handle !== "string") continue;
      await rememberFollow(account, entry.handle, true, { status: "following",
        verified: typeof entry.verified === "boolean" ? entry.verified : null,
        followsYou: typeof entry.followsYou === "boolean" ? entry.followsYou : null });
    }
    return { ok: true };
  }

  // Nút "Tạo Reply" trên timeline X — chỉ nhận từ tab x.com.
  if (m.type === "x_ui_generate_reply") {
    if (!isXTabSender(sender, chrome.runtime.id)) {
      return { ok: false, error: "unauthorized" };
    }
    const ai = await loadAiSettings(chrome.runtime.id);
    if (!ai.apiKey.trim()) return { ok: false, error: "missing_api_key" };
    const gen = await generateManualReply(ai, m, getXAccountForSender(sender));
    if (!gen.ok) return { ok: false, error: gen.error, detail: "detail" in gen ? gen.detail : undefined };
    if (gen.skipped) return { ok: true, skipped: true, text: "" };
    if (!gen.text.trim() || isAiSkip(gen.text)) {
      return { ok: false, error: "empty_content" };
    }
    return { ok: true, text: gen.text.trim(), reply_mode: gen.replyMode };
  }

  // Badge Sorsa Score trên timeline X — chỉ nhận từ tab x.com.
  if (m.type === "x_ui_sorsa_score") {
    if (!isXTabSender(sender, chrome.runtime.id)) {
      return { ok: false, error: "unauthorized" };
    }
    const username = typeof m.username === "string" ? m.username : "";
    return fetchSorsaScore(username);
  }

  // Batch: cache hit trả ngay + fetch song song phần thiếu (nhanh như X68).
  if (m.type === "x_ui_sorsa_scores") {
    if (!isXTabSender(sender, chrome.runtime.id)) {
      return { ok: false, error: "unauthorized" };
    }
    const usernames = Array.isArray(m.usernames)
      ? m.usernames.filter((u): u is string => typeof u === "string")
      : [];
    return fetchSorsaScoresBatch(usernames);
  }

  if (m.type === "x_ui_sorsa_prefs") {
    if (!isXTabSender(sender, chrome.runtime.id)) {
      return { ok: false, error: "unauthorized" };
    }
    // Public search only — no ApiKey.
    return { ok: true, sorsa: { mode: "public" } };
  }

  if (!isExtensionPageSender(sender, chrome.runtime.id)) {
    return { ok: false, error: "unauthorized" };
  }

  switch (m.type) {
    case "get_pogo_native_auth":
      return { ok: true, auth: await getNativeAuthState() };
    case "set_pogo_native_auth":
      await setNativeAuthEnabled(m.enabled === true);
      if (m.enabled === true) await getApiSessionTokenAsync();
      return { ok: true, auth: await getNativeAuthState(), state: publicState() };
    case "get_state":
      await ensureApiSessionHydrated();
      return { ok: true, state: toPublicState(state, await statusOptsAsync()) };

    case "set_data_source": {
      // Sources only uses Pogo API.
      if (m.source != null && m.source !== "api") {
        return { ok: false, error: "api_only", state: publicState() };
      }
      return setDataSource("api");
    }

    case "set_api_token": {
      if (typeof m.token !== "string") {
        return { ok: false, error: "bad_token", state: publicState() };
      }
      await setNativeAuthEnabled(false);
      const trimmed = m.token.trim();
      if (trimmed !== ((await getApiSessionTokenAsync()) ?? "")) {
        const agent = await getAgentPublicState();
        if (agent.settings.modules.pogoTasks && agent.settings.priority !== "browse_only") {
          await pauseMockAgent("Phiên Pogo đã thay đổi — kiểm tra lại tài khoản trước khi bật Agent.");
        }
        await clearPogoQueue();
        state = { ...createInitialState(), mode: "paused" };
      }
      await setApiSessionToken(trimmed.length > 0 ? trimmed : null);
      await resetPogoDemandPull();
      const hasToken = !!(await getApiSessionTokenAsync());
      state = {
        ...state,
        api_last_error: hasToken ? null : "Chưa có Bearer token trong phiên.",
        api_http_status: null,
        login_required: !hasToken && state.data_source === "api",
      };
      await saveState();
      broadcastState();
      return {
        ok: true,
        state: publicState(),
        token_present: hasToken,
      };
    }

    case "start_watch": {
      if (!(await getApiSessionTokenAsync())) return { ok: false, error: "no_token", state: publicState() };
      state = { ...state, mode: "watching", profile_confirmed: true };
      await saveState();
      await syncAlarm();
      broadcastState();
      const result = await runApiFetch();
      return { ok: result.ok, error: result.error, state: publicState() };
    }

    case "pause_watch": {
      state = { ...state, mode: "paused" };
      if (state.data_source === "api") {
        clearApiToken();
        state = {
          ...state,
          api_last_error: "Đã tạm dừng — token phiên đã xóa khỏi memory.",
          api_http_status: null,
        };
      }
      await saveState();
      await syncAlarm();
      broadcastState();
      return { ok: true, state: publicState() };
    }

    case "scan_now": {
      if (!(await getApiSessionTokenAsync())) return { ok: false, error: "no_token", state: publicState() };
      const result = await runApiFetch();
      return { ok: result.ok, error: result.error, state: publicState() };
    }

    case "clear_cache": {
      state = clearCampaignCache(state);
      await saveState();
      broadcastState();
      return { ok: true, state: publicState() };
    }

    case "export": {
      return { ok: true, payload: buildExportPayload(state) };
    }

    case "get_ai_usage": {
      return { ok: true, usage: await getAiUsage() };
    }
    case "save_ai_prices": {
      try { return { ok: true, usage: await saveAiPrices(m.prices) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Không lưu được đơn giá." }; }
    }
    case "get_ai_settings": {
      const settings = await loadAiSettings(chrome.runtime.id);
      return { ok: true, settings: publicFromSettings(settings) };
    }

    case "save_ai_settings": {
      const patch = m.settings;
      if (!patch || typeof patch !== "object") {
        return { ok: false, error: "bad_settings" };
      }
      const current = await loadAiSettings(chrome.runtime.id);
      const incoming = patch as Record<string, unknown>;
      // Ô password để trống + keepApiKey=true → giữ key cũ.
      const keepKey = incoming.keepApiKey === true || incoming.apiKey === "" || incoming.apiKey == null;
      const merged = sanitizeAiSettings({
        ...current,
        ...incoming,
        apiKey:
          keepKey && (typeof incoming.apiKey !== "string" || !incoming.apiKey.trim())
            ? current.apiKey
            : incoming.apiKey,
      });
      const saved = await saveAiSettings(merged, chrome.runtime.id);
      return { ok: true, settings: saved };
    }

    case "apply_ai_provider": {
      const provider = m.provider;
      if (provider !== "openai" && provider !== "spacexai" && provider !== "custom") {
        return { ok: false, error: "bad_provider" };
      }
      const current = await loadAiSettings(chrome.runtime.id);
      const next = applyProviderPreset(current, provider as AiProvider);
      const saved = await saveAiSettings(next, chrome.runtime.id);
      return { ok: true, settings: saved };
    }

    case "clear_ai_api_key": {
      const saved = await clearAiApiKey(chrome.runtime.id);
      return { ok: true, settings: saved };
    }

    case "get_agent_state": {
      return { ok: true, agent: await getAgentPublicState() };
    }

    case "save_agent_settings": {
      await saveAgentSettings(m.settings);
      return { ok: true, agent: await getAgentPublicState() };
    }

    case "get_link_list": {
      const list = await loadLinkList();
      return { ok: true, urls: list.urls, count: list.urls.length, updatedAt: list.updatedAt };
    }

    case "save_link_list": {
      const text = typeof m.text === "string" ? m.text : Array.isArray(m.urls) ? m.urls.join("\n") : "";
      const list = await saveLinkListFromText(text);
      return { ok: true, urls: list.urls, count: list.urls.length, updatedAt: list.updatedAt };
    }

    case "clear_link_list": {
      const list = await clearLinkList();
      return { ok: true, urls: list.urls, count: 0, updatedAt: list.updatedAt };
    }

    case "apply_agent_speed_preset": {
      const preset = m.preset;
      if (preset !== "safe" && preset !== "normal" && preset !== "fast") {
        return { ok: false, error: "bad_preset" };
      }
      await applyAgentSpeedPreset(preset as AgentSpeedPreset);
      return { ok: true, agent: await getAgentPublicState() };
    }

    case "agent_start": {
      return startExclusiveX("agent", async () => {
        // Tự mở X Home. Không check login — user tự đăng nhập.
        await withXTurn("agent", () => openXHomeTabOwned({ forceReload: false }));
        for (let i = 0; i < 10; i++) {
          pingAllXTabs();
          const cur = await getAgentPublicState();
          if (cur.x.connected) break;
          if (i === 5) await withXTurn("agent", () => openXHomeTabOwned({ forceReload: true }));
          await new Promise((r) => setTimeout(r, 500));
        }
        const agent = await startMockAgent();
        await chrome.alarms.create(AGENT_ALARM, { periodInMinutes: 1 });
        void tickMockAgent();
        return { ok: true, agent };
      });
    }

    case "agent_pause": {
      const agent = await pauseMockAgent();
      await chrome.alarms.clear(AGENT_ALARM);
      return { ok: true, agent };
    }

    case "agent_kill_switch": {
      const on = m.on === true;
      const agent = await setKillSwitch(on);
      if (on) await chrome.alarms.clear(AGENT_ALARM);
      return { ok: true, agent };
    }

    case "agent_tick": {
      return { ok: true, agent: await tickMockAgent() };
    }

    case "agent_reset_stats": {
      return { ok: true, agent: await resetDailyStats() };
    }

    case "agent_clear_activity": {
      await clearActivity();
      return { ok: true, agent: await getAgentPublicState() };
    }

    case "agent_clear_queue": {
      return { ok: true, agent: await clearQueue() };
    }

    case "open_x_home": {
      await openXHomeTab({ forceReload: false });
      return { ok: true, agent: await getAgentPublicState() };
    }

    case "agent_force_scroll": {
      pingAllXTabs();
      const agentBefore = await getAgentPublicState();
      if (!agentBefore.x.connected) {
        return { ok: false, error: "no_x_tab", agent: agentBefore };
      }
      return forceScrollOnce();
    }

    case "get_follow_history": {
      return { ok: true, ...(await readFollowHistoryView(getXConnection().handle || "")) };
    }

    case "get_follow_state": {
      const { follow, settings } = await getFollowPublicState();
      return { ok: true, follow, settings };
    }

    case "get_follow_settings": {
      const settings = await loadFollowSettings();
      return { ok: true, settings };
    }

    case "save_follow_settings": {
      const saved = await saveFollowSettings(sanitizeFollowSettings(m.settings));
      const { follow } = await getFollowPublicState();
      return { ok: true, settings: saved, follow };
    }

    case "follow_start": {
      if (m.settings && typeof m.settings === "object") {
        await saveFollowSettings(sanitizeFollowSettings(m.settings));
      }
      const started = await startFollowRunner();
      const { follow, settings } = await getFollowPublicState();
      if (!started.ok) return { ok: false, error: started.error, follow, settings };
      return { ok: true, follow, settings };
    }

    case "follow_stop": {
      await stopFollowRunner("Đã dừng");
      const { follow, settings } = await getFollowPublicState();
      return { ok: true, follow, settings };
    }

    case "get_unfollow_state": {
      const { unfollow, settings } = await getUnfollowPublicState();
      return { ok: true, unfollow, settings };
    }

    case "get_unfollow_settings": {
      const settings = await loadUnfollowSettings();
      return { ok: true, settings };
    }

    case "save_unfollow_settings": {
      const saved = await saveUnfollowSettings(sanitizeUnfollowSettings(m.settings));
      const { unfollow } = await getUnfollowPublicState();
      return { ok: true, settings: saved, unfollow };
    }

    case "unfollow_start": {
      if (m.settings && typeof m.settings === "object") {
        await saveUnfollowSettings(sanitizeUnfollowSettings(m.settings));
      }
      const started = await startUnfollowRunner();
      const { unfollow, settings } = await getUnfollowPublicState();
      if (!started.ok) return { ok: false, error: started.error, unfollow, settings };
      return { ok: true, unfollow, settings };
    }

    case "unfollow_stop": {
      await stopUnfollowRunner("Đã dừng");
      const { unfollow, settings } = await getUnfollowPublicState();
      return { ok: true, unfollow, settings };
    }

    case "smm_get_state":
      return smmGetState();

    case "smm_save_settings": {
      if (!m.settings || typeof m.settings !== "object") {
        return { ok: false, error: "missing_settings" };
      }
      return smmSaveSettings(m.settings);
    }

    case "smm_clear_key":
      return smmClearKey();

    case "smm_request": {
      const action = typeof m.action === "string" ? m.action : "";
      const params =
        m.params && typeof m.params === "object"
          ? (m.params as Record<string, unknown>)
          : {};
      const res = await smmRequest(action, params);
      if (res.ok && action === "services" && Array.isArray(res.data)) {
        return {
          ...res,
          xServices: filterXServices(res.data as Parameters<typeof filterXServices>[0]),
        };
      }
      return res;
    }

    case "smm_place_order": {
      return smmPlaceOrder({
        link: typeof m.link === "string" ? m.link : "",
        metric: m.metric === "likes" ? "likes" : "views",
        service: typeof m.service === "string" ? m.service : undefined,
        quantity: typeof m.quantity === "number" ? m.quantity : undefined,
        postId: typeof m.postId === "string" ? m.postId : undefined,
      });
    }

    case "smm_clear_history":
      return smmClearHistory();

    case "smm_start_post_scan":
      return smmStartPostScan();

    case "smm_stop_post_scan":
      return smmStopPostScan();

    case "smm_retry_orders":
      return smmRetryFailedOrders();

    case "pogo_bounties_get":
      return { ok: true, bounties: await getPogoBountyPublicState() };

    case "pogo_bounties_sync":
      return { ok: true, bounties: await syncPogoBounties() };

    case "pogo_bounties_auto_join":
      return { ok: true, bounties: await setPogoBountyAutoJoin(m.enabled === true) };

    case "pogo_bounty_claim": {
      const id = typeof m.id === "number" ? m.id : Number(m.id);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bounty_id không hợp lệ." };
      const bounties = await claimPogoBountyById(id);
      return { ok: !bounties.error, bounties, error: bounties.error ?? undefined };
    }

    default:
      return { ok: false, error: "unknown_type" };
  }
}

async function setDataSource(next: DataSource): Promise<object> {
  if (next !== "api") {
    return { ok: false, error: "api_only", state: publicState() };
  }

  const prev = state.data_source;
  if (prev === "api") return { ok: true, state: publicState() };

  const hasToken = !!(await getApiSessionTokenAsync());
  state = {
    ...state,
    data_source: "api",
    mode: state.mode === "watching" ? "paused" : state.mode,
    api_last_error: hasToken ? null : "Chưa có Bearer token trong phiên.",
    login_required: !hasToken,
  };

  await saveState();
  await syncAlarm();
  broadcastState();
  return { ok: true, state: publicState() };
}

async function openXHomeTab(opts?: { forceReload?: boolean }): Promise<void> {
  return withXTurn("manual", () => openXHomeTabOwned(opts));
}

async function openXHomeTabOwned(opts?: { forceReload?: boolean }): Promise<void> {
  const url = "https://x.com/home";
  const forceReload = opts?.forceReload === true;
  const existing = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const home = existing.find((t) => t.id === getSelectedXTabId()) ?? existing.find((t) => (t.url || "").includes("/home"));
  let tabId: number | undefined;

  if (home?.id != null) {
    tabId = home.id;
    await chrome.tabs.update(home.id, { active: true });
    if (home.windowId != null) await chrome.windows.update(home.windowId, { focused: true });
    if (forceReload) {
      await chrome.tabs.reload(home.id);
    } else if (!(home.url || "").includes("/home")) {
      await chrome.tabs.update(home.id, { url });
    }
  } else if (existing[0]?.id != null) {
    tabId = existing[0].id;
    await chrome.tabs.update(existing[0].id, { active: true, url });
    if (existing[0].windowId != null) await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    const created = await chrome.tabs.create({ url, active: true });
    tabId = created.id;
  }

  // Đợi tab load xong rồi ping content script.
  if (tabId != null) {
    selectXTab(tabId);
    await waitTabComplete(tabId, 12_000);
  } else {
    await new Promise((r) => setTimeout(r, 1200));
  }
  await new Promise((r) => setTimeout(r, 800));
  pingAllXTabs();
}

function waitTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    };
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        finish();
        return;
      }
      if (tab?.status === "complete") {
        clearTimeout(timer);
        finish();
        return;
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POGO_BOUNTY_ALARM) {
    void ensureReady().then(() => pollPogoBounties());
    return;
  }
  if (alarm.name === TELEGRAM_OPS_ALARM) {
    void ensureReady().then(async () => {
      const auth = await getNativeAuthState();
      await runTelegramOps(await getAgentPublicState(), { present: !!getApiSessionToken(), loginRequired: state.login_required, authError: auth.lastError });
    });
    return;
  }
  if (alarm.name === TELEGRAM_SUMMARY_ALARM) {
    void ensureReady().then(async () => {
      const agent = await getAgentPublicState();
      if (!["running", "waiting"].includes(agent.runtime.status) || agent.runtime.killSwitch) return;
      await notifyTelegram("hourly_summary", { account: agent.x.handle || agent.settings.ownHandle, stats: agent.today, status: agent.runtime.status });
    });
    return;
  }
  if (alarm.name === POGO_AUTH_ALARM) {
    void ensureReady().then(() => getApiSessionTokenAsync());
    return;
  }
  if (alarm.name === AGENT_ALARM || alarm.name === AGENT_ONCE) {
    void ensureReady()
      .then(() => ensureAgentAlarmsAfterWake())
      .then(() => tickMockAgent());
    return;
  }
  if (alarm.name === "x-follow-tick") {
    void ensureReady().then(() => onFollowAlarm(alarm.name));
    return;
  }
  if (alarm.name === "x-unfollow-tick") {
    void ensureReady().then(() => onUnfollowAlarm(alarm.name));
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  void ensureReady().then(async () => {
    if (state.mode !== "watching") return;
    const agent = await getAgentPublicState();
    if (["running", "waiting"].includes(agent.runtime.status) && agent.settings.modules.pogoTasks && agent.settings.priority !== "browse_only") return;
    void runApiFetch();
  });
});
