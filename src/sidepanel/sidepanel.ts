import type { PublicState } from "../domain/types.ts";
import type { ListFilter } from "../domain/merge.ts";
import type { AiProvider, AiSettingsPublic } from "../domain/ai-settings.ts";
import { initAiUsagePanel } from "./ai-usage-panel.ts";
import type { AgentPublicState } from "../domain/agent-settings.ts";
import {
  DEFAULT_BROWSE_REPLY_SYSTEM,
  DEFAULT_BROWSE_REPLY_USER_TMPL,
  DEFAULT_MENTION_REPLY_SYSTEM,
  DEFAULT_MENTION_REPLY_USER_TMPL,
  DEFAULT_REPLY_SYSTEM,
  DEFAULT_REPLY_USER_TMPL,
  PROVIDER_PRESETS,
} from "../domain/ai-settings.ts";
import { parseTweetUrlList, sanitizeTweetUrl } from "../domain/url.ts";
import { renderList, renderStatus } from "./render.ts";
import { initAgentPanel } from "./agent-panel.ts";
import { initFollowPanel } from "./follow-panel.ts";
import { initUnfollowPanel } from "./unfollow-panel.ts";
import { initSmmPanel } from "./smm-panel.ts";
import { initBountyPanel } from "./bounty-panel.ts";

declare const chrome: typeof globalThis.chrome;

const statusRoot = document.getElementById("status")!;
const listRoot = document.getElementById("list")!;
const filterEl = document.getElementById("filter") as HTMLSelectElement;
const searchEl = document.getElementById("search") as HTMLInputElement;
const msgEl = document.getElementById("action-msg")!;
const confirmBox = document.getElementById("confirm-box")!;
const confirmText = document.getElementById("confirm-text")!;
const confirmAccount = document.getElementById("confirm-account")!;
const autoAuthInput = document.getElementById("pogo-auto-auth") as HTMLInputElement;
const autoAuthStatus = document.getElementById("pogo-auto-auth-status");

function paintAutoAuth(auth: { enabled: boolean; lastError?: string | null }): void {
  autoAuthInput.checked = auth.enabled;
  const errors: Record<string, string> = {
    native_host_unavailable: "Chưa cài chương trình kết nối Telegram trên máy.",
    telegram_not_configured: "Chưa thiết lập thông tin ứng dụng Telegram trên máy.",
    pogo_endpoint_not_configured: "Chưa xác định API đăng nhập Pogo; chưa thể tự cấp Bearer.",
    telegram_login_required: "Cần đăng nhập Telegram một lần bằng chương trình trên máy.",
    pogo_identity_unverified: "Pogo chưa trả tài khoản liên kết; chưa nhận token tự động.",
    pogo_account_mismatch: "Phiên Telegram liên kết tài khoản X khác; chưa thay token hiện tại.",
    auth_timeout: "Kết nối Telegram/Pogo quá lâu; sẽ thử lại sau.",
  };
  if (autoAuthStatus) autoAuthStatus.textContent = !auth.enabled ? "Chưa bật tự cấp token. Bật kết nối Telegram để lấy phiên Pogo."
    : auth.lastError ? errors[auth.lastError] || "Chưa kết nối được Telegram/Pogo. Kiểm tra chương trình trên máy."
      : "Đã bật tự cấp token; chương trình trên máy sẽ xin Bearer mới trước khi phiên hết hạn.";
}
const sourceHint = document.getElementById("source-hint");
const linkListEl = document.getElementById("link-list") as HTMLTextAreaElement;
const linkListStatus = document.getElementById("link-list-status");
const linkListMsg = document.getElementById("link-list-msg");

const VIEWS = ["agent", "tasks", "behavior", "follow", "smm", "ai", "activity"] as const;
type ViewId = (typeof VIEWS)[number];
let linkListLoaded = false;

const aiProvider = document.getElementById("ai-provider") as HTMLSelectElement;
const aiApiKey = document.getElementById("ai-api-key") as HTMLInputElement;
const aiKeyStatus = document.getElementById("ai-key-status")!;
const aiBaseUrl = document.getElementById("ai-base-url") as HTMLInputElement;
const aiModel = document.getElementById("ai-model") as HTMLInputElement;
const aiTemperature = document.getElementById("ai-temperature") as HTMLInputElement;
const aiMaxTokens = document.getElementById("ai-max-tokens") as HTMLInputElement;
const aiReplyEnabled = document.getElementById("ai-reply-enabled") as HTMLInputElement;
const aiReplyModel = document.getElementById("ai-reply-model") as HTMLInputElement;
const aiReplySystem = document.getElementById("ai-reply-system") as HTMLTextAreaElement;
const aiReplyUser = document.getElementById("ai-reply-user") as HTMLTextAreaElement;
const aiBrowseReplyEnabled = document.getElementById("ai-browse-reply-enabled") as HTMLInputElement;
const aiBrowseReplyModel = document.getElementById("ai-browse-reply-model") as HTMLInputElement;
const aiBrowseReplySystem = document.getElementById("ai-browse-reply-system") as HTMLTextAreaElement;
const aiBrowseReplyUser = document.getElementById("ai-browse-reply-user") as HTMLTextAreaElement;
const aiMentionReplyEnabled = document.getElementById("ai-mention-reply-enabled") as HTMLInputElement;
const aiMentionReplyModel = document.getElementById("ai-mention-reply-model") as HTMLInputElement;
const aiMentionReplySystem = document.getElementById("ai-mention-reply-system") as HTMLTextAreaElement;
const aiMentionReplyUser = document.getElementById("ai-mention-reply-user") as HTMLTextAreaElement;
const aiQuoteEnabled = document.getElementById("ai-quote-enabled") as HTMLInputElement;
const aiQuoteSystem = document.getElementById("ai-quote-system") as HTMLTextAreaElement;
const aiQuoteUser = document.getElementById("ai-quote-user") as HTMLTextAreaElement;
const aiPostEnabled = document.getElementById("ai-post-enabled") as HTMLInputElement;
const aiPostSystem = document.getElementById("ai-post-system") as HTMLTextAreaElement;
const aiPostUser = document.getElementById("ai-post-user") as HTMLTextAreaElement;
const aiMsg = document.getElementById("ai-msg")!;

let state: PublicState | null = null;
let pendingAction: "start" | "scan" | null = null;
let clearArmed = false;
let aiSettings: AiSettingsPublic | null = null;
let aiLoaded = false;

function setMsg(text: string): void {
  msgEl.textContent = text;
}

function setAiMsg(text: string): void {
  aiMsg.textContent = text;
}

function setLinkMsg(text: string): void {
  if (linkListMsg) linkListMsg.textContent = text;
}

function paintLinkListStatus(count: number): void {
  if (!linkListStatus) return;
  linkListStatus.textContent =
    count > 0
      ? `${count} link hợp lệ · sẵn sàng (bật “List link đã dán” ở Hành vi rồi Start Agent).`
      : "Chưa có link. Mỗi dòng một URL status.";
}

async function loadLinkListUi(): Promise<void> {
  const res = (await send("get_link_list")) as {
    ok: boolean;
    urls?: string[];
    count?: number;
    error?: string;
  };
  if (!res.ok) {
    setLinkMsg(res.error ?? "Không tải list link được.");
    return;
  }
  const urls = res.urls ?? [];
  linkListEl.value = urls.join("\n");
  paintLinkListStatus(res.count ?? urls.length);
  linkListLoaded = true;
}

function currentFilter(): ListFilter {
  const v = filterEl.value;
  if (v === "todo" || v === "locked" || v === "reply_open" || v === "retweet_open" || v === "quote_open" || v === "all") {
    return v;
  }
  return "todo";
}

function paint(): void {
  if (!state) return;
  if (sourceHint) sourceHint.textContent = state.login_required && state.api_token_present
    ? "Phiên Pogo hết hạn · kiểm tra kết nối Telegram; hàng đợi được giữ"
    : state.api_token_present ? "Đã có phiên API Pogo · lấy task / RT power từ API" : "Kiểm tra kết nối Telegram để tự cấp phiên Pogo";
  renderStatus(statusRoot, state);
  renderList(listRoot, state, currentFilter(), searchEl.value, openTweet);
}

function showView(view: ViewId): void {
  for (const id of VIEWS) {
    const panel = document.getElementById(`view-${id}`);
    const tab = document.getElementById(`tab-${id}`);
    const on = id === view;
    if (panel) {
      panel.hidden = !on;
      panel.classList.toggle("hidden", !on);
    }
    if (tab) {
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    }
  }
  if (view === "ai" && !aiLoaded) void loadAiSettingsUi();
  if (view === "ai") void aiUsagePanel.load();
  if (view === "tasks" && !linkListLoaded) void loadLinkListUi();
  agentPanel.onViewEnter(view);
  followPanel.onViewEnter(view);
  unfollowPanel.onViewEnter(view);
  smmPanel.onViewEnter(view);
  bountyPanel.onViewEnter(view);
}

function openTweet(url: string): void {
  const safe = sanitizeTweetUrl(url);
  if (!safe) {
    setMsg("URL không hợp lệ.");
    return;
  }
  chrome.tabs.create({ url: safe });
}

async function send(
  type: string,
  extra: Record<string, unknown> = {},
): Promise<{
  ok: boolean;
  state?: PublicState;
  settings?: AiSettingsPublic;
  agent?: AgentPublicState;
  payload?: unknown;
  auth?: { enabled: boolean; lastError?: string | null; extensionId?: string };
  error?: string;
}> {
  return chrome.runtime.sendMessage({ type, ...extra });
}

const agentPanel = initAgentPanel(send);
const aiUsagePanel = initAiUsagePanel(send);
const followPanel = initFollowPanel((type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }));
const unfollowPanel = initUnfollowPanel((type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }));
const smmPanel = initSmmPanel(send);
const bountyPanel = initBountyPanel(send);

async function refresh(): Promise<void> {
  const res = await send("get_state");
  if (res?.ok && res.state) {
    state = res.state;
    paint();
  }
}

function fillAiForm(settings: AiSettingsPublic): void {
  aiSettings = settings;
  aiProvider.value = settings.provider;
  aiBaseUrl.value = settings.baseUrl;
  aiModel.value = settings.model;
  aiTemperature.value = String(settings.temperature);
  aiMaxTokens.value = String(settings.maxTokens);
  aiApiKey.value = "";
  aiApiKey.placeholder = settings.hasApiKey
    ? `Đã lưu ${settings.apiKeyMasked ?? "••••"} — dán key mới để thay`
    : "Dán OpenAI / xAI API key";
  aiKeyStatus.textContent = settings.hasApiKey
    ? `Đã lưu key: ${settings.apiKeyMasked}`
    : "Chưa lưu API key.";

  aiReplyEnabled.checked = settings.reply.enabled;
  aiReplyModel.value = settings.reply.model ?? "";
  aiReplySystem.value = settings.reply.systemPrompt;
  aiReplyUser.value = settings.reply.userPromptTemplate;
  aiBrowseReplyEnabled.checked = settings.browseReply.enabled;
  aiBrowseReplyModel.value = settings.browseReply.model ?? "";
  aiBrowseReplySystem.value = settings.browseReply.systemPrompt;
  aiBrowseReplyUser.value = settings.browseReply.userPromptTemplate;
  aiMentionReplyEnabled.checked = settings.mentionReply.enabled;
  aiMentionReplyModel.value = settings.mentionReply.model ?? "";
  aiMentionReplySystem.value = settings.mentionReply.systemPrompt;
  aiMentionReplyUser.value = settings.mentionReply.userPromptTemplate;
  aiQuoteEnabled.checked = settings.quote.enabled;
  aiQuoteSystem.value = settings.quote.systemPrompt;
  aiQuoteUser.value = settings.quote.userPromptTemplate;
  aiPostEnabled.checked = settings.post.enabled;
  aiPostSystem.value = settings.post.systemPrompt;
  aiPostUser.value = settings.post.userPromptTemplate;
}

async function loadAiSettingsUi(): Promise<void> {
  const res = await send("get_ai_settings");
  if (res.ok && res.settings) {
    fillAiForm(res.settings);
    aiLoaded = true;
    setAiMsg("");
  } else {
    setAiMsg(res.error ?? "Không tải được cấu hình AI.");
  }
}

function collectAiForm(): Record<string, unknown> {
  const key = aiApiKey.value.trim();
  return {
    provider: aiProvider.value,
    baseUrl: aiBaseUrl.value.trim(),
    model: aiModel.value.trim(),
    temperature: Number(aiTemperature.value),
    maxTokens: Number(aiMaxTokens.value),
    apiKey: key,
    keepApiKey: key.length === 0,
    reply: {
      enabled: aiReplyEnabled.checked,
      model: aiReplyModel.value,
      systemPrompt: aiReplySystem.value,
      userPromptTemplate: aiReplyUser.value,
    },
    browseReply: {
      enabled: aiBrowseReplyEnabled.checked,
      model: aiBrowseReplyModel.value,
      systemPrompt: aiBrowseReplySystem.value,
      userPromptTemplate: aiBrowseReplyUser.value,
    },
    mentionReply: {
      enabled: aiMentionReplyEnabled.checked,
      model: aiMentionReplyModel.value,
      systemPrompt: aiMentionReplySystem.value,
      userPromptTemplate: aiMentionReplyUser.value,
    },
    quote: {
      enabled: aiQuoteEnabled.checked,
      systemPrompt: aiQuoteSystem.value,
      userPromptTemplate: aiQuoteUser.value,
    },
    post: {
      enabled: aiPostEnabled.checked,
      systemPrompt: aiPostSystem.value,
      userPromptTemplate: aiPostUser.value,
    },
  };
}

function showConfirm(action: "start" | "scan"): void {
  pendingAction = action;
  confirmBox.hidden = false;
  confirmBox.classList.remove("hidden");
  confirmText.textContent =
    "Phiên Pogo chỉ được giữ trong phiên Chrome này. Hãy xác nhận đúng tài khoản trước khi chạy.";
  if (state?.linked_account) {
    confirmAccount.textContent = `Tài khoản đọc được: @${state.linked_account.handle}`;
  } else {
    confirmAccount.textContent =
      "API chưa trả tài khoản liên kết. Tự xác nhận đúng token trước khi chạy.";
  }
}

function hideConfirm(): void {
  pendingAction = null;
  confirmBox.hidden = true;
  confirmBox.classList.add("hidden");
}

function scanErrorMessage(error?: string): string {
  if (error === "no_token") return "Chưa có phiên Pogo. Kiểm tra kết nối Telegram ở tab Nguồn.";
  if (error === "login_required") return "Phiên Pogo hết hạn hoặc không hợp lệ. Kiểm tra kết nối Telegram ở tab Nguồn.";
  if (error === "api_error") return "Gọi API thất bại.";
  return error ?? "Lỗi quét.";
}

async function runPending(): Promise<void> {
  const action = pendingAction;
  hideConfirm();
  if (action === "start") {
    const res = await send("start_watch");
    if (res.state) {
      state = res.state;
      paint();
    }
    if (res.ok) {
      setMsg("Đã bắt đầu theo dõi.");
    } else {
      setMsg(scanErrorMessage(res.error) || "Không bắt đầu được.");
    }
    return;
  }
  if (action === "scan") {
    const res = await send("scan_now");
    if (res.state) {
      state = res.state;
      paint();
    }
    setMsg(res.ok ? "Đã quét xong." : scanErrorMessage(res.error));
    if (res.ok) void bountyPanel.refresh();
  }
}

for (const id of VIEWS) {
  document.getElementById(`tab-${id}`)?.addEventListener("click", () => showView(id));
}

aiProvider.addEventListener("change", async () => {
  const provider = aiProvider.value as AiProvider;
  if (provider === "custom") {
    const advanced = aiBaseUrl.closest("details");
    if (advanced) advanced.open = true;
    setAiMsg("Tùy chỉnh: điền địa chỉ API và mô hình tương thích OpenAI.");
    return;
  }
  const preset = PROVIDER_PRESETS[provider];
  aiBaseUrl.value = preset.baseUrl;
  aiModel.value = preset.model;
  const res = await send("apply_ai_provider", { provider });
  if (res.ok && res.settings) {
    fillAiForm(res.settings);
    setAiMsg(`Đã áp preset ${preset.label}. Bấm Lưu nếu đã sửa thêm.`);
  }
});

document.getElementById("btn-ai-save")!.addEventListener("click", async () => {
  const res = await send("save_ai_settings", { settings: collectAiForm() });
  if (res.ok && res.settings) {
    fillAiForm(res.settings);
    setAiMsg("Đã lưu cấu hình AI.");
  } else {
    setAiMsg(res.error ?? "Không lưu được.");
  }
});

document.getElementById("btn-ai-reset-reply")!.addEventListener("click", () => {
  aiReplyEnabled.checked = true;
  aiReplyModel.value = "";
  aiReplySystem.value = DEFAULT_REPLY_SYSTEM;
  aiReplyUser.value = DEFAULT_REPLY_USER_TMPL;
  aiMaxTokens.value = "300";
  if (!aiTemperature.value) aiTemperature.value = "0.7";
  setAiMsg("Đã khôi phục hướng dẫn Pogo (model để trống = mặc định). Bấm Lưu cấu hình AI để áp dụng.");
});

document.getElementById("btn-ai-reset-browse-reply")!.addEventListener("click", () => {
  aiBrowseReplyEnabled.checked = true;
  aiBrowseReplyModel.value = "";
  aiBrowseReplySystem.value = DEFAULT_BROWSE_REPLY_SYSTEM;
  aiBrowseReplyUser.value = DEFAULT_BROWSE_REPLY_USER_TMPL;
  setAiMsg("Đã khôi phục hướng dẫn nút ✨ / lướt X / list link. Bấm Lưu cấu hình AI để áp dụng.");
});

document.getElementById("btn-ai-reset-mention-reply")!.addEventListener("click", () => {
  aiMentionReplyEnabled.checked = true;
  aiMentionReplyModel.value = "";
  aiMentionReplySystem.value = DEFAULT_MENTION_REPLY_SYSTEM;
  aiMentionReplyUser.value = DEFAULT_MENTION_REPLY_USER_TMPL;
  setAiMsg("Đã khôi phục hướng dẫn Thông báo (mention). Bấm Lưu cấu hình AI để áp dụng.");
});

document.getElementById("btn-ai-clear-key")!.addEventListener("click", async () => {
  const res = await send("clear_ai_api_key");
  if (res.ok && res.settings) {
    fillAiForm(res.settings);
    setAiMsg("Đã xóa API key.");
  } else {
    setAiMsg(res.error ?? "Không xóa key được.");
  }
});

async function updateAutoAuth(): Promise<void> {
  if (autoAuthStatus) autoAuthStatus.textContent = "Đang kiểm tra kết nối Telegram/Pogo…";
  const response = await send("set_pogo_native_auth", { enabled: autoAuthInput.checked });
  if (response.auth) paintAutoAuth(response.auth);
  if (response.state) { state = response.state; paint(); }
}
autoAuthInput.addEventListener("change", () => { void updateAutoAuth(); });
document.getElementById("btn-pogo-auto-auth")!.addEventListener("click", () => {
  autoAuthInput.checked = true;
  void updateAutoAuth();
});
void send("get_pogo_native_auth").then(response => { if (response.auth) paintAutoAuth(response.auth); });

document.getElementById("btn-start")!.addEventListener("click", () => {
  clearArmed = false;
  showConfirm("start");
});

document.getElementById("btn-pause")!.addEventListener("click", async () => {
  clearArmed = false;
  hideConfirm();
  const res = await send("pause_watch");
  if (res.ok && res.state) {
    state = res.state;
    paint();
    setMsg("Đã tạm dừng theo dõi.");
  }
});

document.getElementById("btn-scan")!.addEventListener("click", () => {
  clearArmed = false;
  if (state?.mode === "watching") {
    void (async () => {
      const res = await send("scan_now");
      if (res.state) {
        state = res.state;
        paint();
      }
      setMsg(res.ok ? "Đã quét xong." : scanErrorMessage(res.error));
      if (res.ok) void bountyPanel.refresh();
    })();
    return;
  }
  showConfirm("scan");
});

document.getElementById("btn-confirm-yes")!.addEventListener("click", () => {
  void runPending();
});

document.getElementById("btn-confirm-no")!.addEventListener("click", () => {
  hideConfirm();
  setMsg("Đã hủy.");
});

document.getElementById("btn-export")!.addEventListener("click", async () => {
  clearArmed = false;
  const res = await send("export");
  if (!res.ok || !res.payload) {
    setMsg("Không xuất được.");
    return;
  }
  const blob = new Blob([JSON.stringify(res.payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pogo-tasks-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setMsg("Đã xuất danh sách chiến dịch sang JSON.");
});

document.getElementById("btn-link-normalize")!.addEventListener("click", () => {
  const before = linkListEl.value;
  const urls = parseTweetUrlList(before);
  linkListEl.value = urls.join("\n");
  paintLinkListStatus(urls.length);
  if (!urls.length) {
    setLinkMsg("Không tìm thấy link status hợp lệ trong text đã dán.");
    return;
  }
  setLinkMsg(`Đã chuẩn hóa ${urls.length} link (đã bỏ trùng). Bấm Lưu list để dùng.`);
});

document.getElementById("btn-link-save")!.addEventListener("click", async () => {
  const res = (await send("save_link_list", { text: linkListEl.value })) as {
    ok: boolean;
    urls?: string[];
    count?: number;
    error?: string;
  };
  if (!res.ok) {
    setLinkMsg(res.error ?? "Không lưu list được.");
    return;
  }
  const urls = res.urls ?? [];
  linkListEl.value = urls.join("\n");
  paintLinkListStatus(res.count ?? urls.length);
  setLinkMsg(
    urls.length
      ? `Đã lưu ${urls.length} link. Bật “List link đã dán” ở Hành vi rồi Start Agent.`
      : "Không có link hợp lệ để lưu.",
  );
});

document.getElementById("btn-link-clear")!.addEventListener("click", async () => {
  const res = (await send("clear_link_list")) as { ok: boolean; error?: string };
  if (!res.ok) {
    setLinkMsg(res.error ?? "Không xóa list được.");
    return;
  }
  linkListEl.value = "";
  paintLinkListStatus(0);
  setLinkMsg("Đã xóa list link.");
});

document.getElementById("btn-clear")!.addEventListener("click", async () => {
  hideConfirm();
  if (!clearArmed) {
    clearArmed = true;
    setMsg("Bấm Xóa bộ nhớ lần nữa để xác nhận.");
    return;
  }
  clearArmed = false;
  const res = await send("clear_cache");
  if (res.ok && res.state) {
    state = res.state;
    paint();
    setMsg("Đã xóa bộ nhớ chiến dịch.");
  }
});

filterEl.addEventListener("change", paint);
searchEl.addEventListener("input", paint);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && typeof msg === "object" && msg.type === "state" && msg.state) {
    state = msg.state as PublicState;
    paint();
  }
  followPanel.onMessage(msg);
  unfollowPanel.onMessage(msg);
  smmPanel.onMessage(msg);
  bountyPanel.onMessage(msg);
});

void refresh();
void agentPanel.loadAgent();
showView("agent");
