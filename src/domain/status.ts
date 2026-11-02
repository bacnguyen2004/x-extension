import type { PersistedState, PublicState, UiStatus } from "./types.ts";

const DATA_STALE_MS = 10 * 60 * 1000;

export interface StatusOptions {
  /** Pogo API: có Bearer token trong memory phiên. */
  connected: boolean;
  apiTokenPresent?: boolean;
}

export function deriveUiStatus(state: PersistedState, opts: StatusOptions): UiStatus {
  if (!opts.apiTokenPresent) return "no_token";
  if (state.login_required) return "login_check";
  if (state.mode === "watching" && !state.feed_visible) return "waiting_feed";
  if (state.mode === "watching") return "watching";
  if (state.mode === "paused") return "paused";
  if (state.mode === "idle") return "idle_ready";
  if (Object.keys(state.campaigns).length > 0) return "cache_only";
  return "idle_ready";
}

export function statusLabel(status: UiStatus): string {
  switch (status) {
    case "no_token":
      return "Chưa có phiên Pogo";
    case "waiting_feed":
      return "Đang chờ feed";
    case "watching":
      return "Đang theo dõi";
    case "paused":
      return "Đang tạm dừng";
    case "login_check":
      return "Cần kiểm tra phiên đăng nhập";
    case "cache_only":
      return "Chỉ đang xem cache";
    case "idle_ready":
      return "Sẵn sàng — chưa bật theo dõi";
  }
}

export function buildWarnings(
  state: PersistedState,
  opts: StatusOptions,
  now = Date.now(),
): string[] {
  const warnings: string[] = [];
  const list = Object.values(state.campaigns);
  const staleCount = list.filter((c) => c.stale).length;
  if (!opts.apiTokenPresent) {
    warnings.push("Chưa có phiên Pogo. Kiểm tra kết nối Telegram ở tab Nguồn.");
  }
  if (state.api_last_error) {
    warnings.push(state.api_last_error);
  }

  if (staleCount > 0) {
    warnings.push(
      `${staleCount} bài không còn trên lần quét gần nhất. Trạng thái giữ nguyên lần quan sát trước — không nghĩa là đã hoàn thành.`,
    );
  }
  if (state.login_required) {
    warnings.push(
      "Phiên Pogo hết hạn hoặc không hợp lệ. Kiểm tra kết nối Telegram ở tab Nguồn.",
    );
  }
  if (
    state.mode === "watching" &&
    state.last_data_change_at != null &&
    state.last_dom_scan_at != null &&
    now - state.last_data_change_at >= DATA_STALE_MS &&
    now - state.last_dom_scan_at < 2 * 60 * 1000
  ) {
    warnings.push("API vẫn gọi được nhưng nội dung task không đổi gần đây.");
  }
  if (!state.linked_account) {
    warnings.push(
      "Chưa đọc được tài khoản liên kết rõ ràng. Không nhầm tác giả task với tài khoản của bạn.",
    );
  }
  return warnings;
}

export function toPublicState(
  state: PersistedState,
  opts: StatusOptions,
  now = Date.now(),
): PublicState {
  const list = Object.values(state.campaigns);
  const apiTokenPresent = state.data_source === "api" ? !!opts.apiTokenPresent : false;
  return {
    ...state,
    ui_status: deriveUiStatus(state, { ...opts, apiTokenPresent }),
    frame_connected: opts.connected,
    api_token_present: apiTokenPresent,
    campaign_count: list.length,
    observed_count: list.filter((c) => !c.stale).length,
    stale_count: list.filter((c) => c.stale).length,
    warnings: buildWarnings(state, { ...opts, apiTokenPresent }, now),
  };
}

export function alarmActionForMode(mode: PersistedState["mode"]): "create" | "clear" {
  return mode === "watching" ? "create" : "clear";
}
