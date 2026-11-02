/**
 * Tab SMM (SmmFollows) — settings + validate dịch vụ / mã đơn.
 * Cụm này độc lập; xóa tab = xóa file này + smm-*.
 */

import type { SmmService } from "../api/smm-client.ts";

export interface SmmSettings {
  apiKey: string;
  viewServiceId: string;
  viewOrderQuantity: number;
  likeServiceId: string;
  likeOrderQuantity: number;
  autoOrder: boolean;
  scanUsername: string;
  scanLimit: number;
  minViews: number;
  minLikes: number;
  minReposts: number;
  minReplies: number;
  scanDelaySec: number;
}

/** Public (mask key). */
export interface SmmSettingsPublic extends Omit<SmmSettings, "apiKey"> {
  hasKey: boolean;
}

export interface SmmOrderEntry {
  id: string;
  at: number;
  order: string;
  service: string;
  quantity: number;
  metric: "views" | "likes";
  postId?: string;
  url: string;
}

export type SmmOrderStatus = "pending" | "done" | "error";

export interface SmmPostOrderState {
  status: SmmOrderStatus;
  service: string;
  quantity: number;
  order?: string;
  error?: string;
}

export interface SmmScannedPost {
  id: string;
  username: string;
  url: string;
  views: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  below: string[];
}

export interface SmmScanSnapshot {
  scanning: boolean;
  cancelled: boolean;
  status: string;
  scannedCount: number;
  belowThreshold: SmmScannedPost[];
  orderedCount: number;
}

export interface SmmPublicState {
  settings: SmmSettingsPublic;
  balance: string | null;
  currency: string | null;
  servicesLoaded: number;
  recentOrders: SmmOrderEntry[];
  scan: SmmScanSnapshot;
}

export function createDefaultSmmSettings(): SmmSettings {
  return {
    apiKey: "",
    viewServiceId: "",
    viewOrderQuantity: 1000,
    likeServiceId: "",
    likeOrderQuantity: 50,
    autoOrder: false,
    scanUsername: "",
    scanLimit: 50,
    minViews: 1000,
    minLikes: 50,
    minReposts: 0,
    minReplies: 0,
    scanDelaySec: 2,
  };
}

export function createEmptyScanSnapshot(): SmmScanSnapshot {
  return {
    scanning: false,
    cancelled: false,
    status: "Sẵn sàng quét.",
    scannedCount: 0,
    belowThreshold: [],
    orderedCount: 0,
  };
}

function freeInt(n: unknown, fallback: number, minFloor = 0): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(minFloor, Math.floor(v));
}

function strId(v: unknown): string {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? s : "";
}

export function normalizeScanUsername(raw: unknown): string {
  return String(raw || "")
    .trim()
    .replace(/^@/, "")
    .slice(0, 15);
}

export function sanitizeSmmSettings(input: unknown): SmmSettings {
  const d = createDefaultSmmSettings();
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const user = normalizeScanUsername(o.scanUsername);
  return {
    apiKey: typeof o.apiKey === "string" ? o.apiKey : d.apiKey,
    viewServiceId: strId(o.viewServiceId) || d.viewServiceId,
    viewOrderQuantity: freeInt(o.viewOrderQuantity, d.viewOrderQuantity, 1),
    likeServiceId: strId(o.likeServiceId) || d.likeServiceId,
    likeOrderQuantity: freeInt(o.likeOrderQuantity, d.likeOrderQuantity, 1),
    autoOrder: typeof o.autoOrder === "boolean" ? o.autoOrder : d.autoOrder,
    scanUsername: /^[A-Za-z0-9_]{1,15}$/.test(user) ? user : "",
    scanLimit: Math.min(500, freeInt(o.scanLimit, d.scanLimit, 1)),
    minViews: freeInt(o.minViews, d.minViews, 0),
    minLikes: freeInt(o.minLikes, d.minLikes, 0),
    minReposts: freeInt(o.minReposts, d.minReposts, 0),
    minReplies: freeInt(o.minReplies, d.minReplies, 0),
    scanDelaySec: Math.min(10, Math.max(1, freeInt(o.scanDelaySec, d.scanDelaySec, 1))),
  };
}

export function toPublicSmmSettings(s: SmmSettings): SmmSettingsPublic {
  const { apiKey: _k, ...rest } = s;
  return { ...rest, hasKey: s.apiKey.trim().length > 0 };
}

/** Kiểm tra ID view/like với danh sách services trước khi quét/đặt đơn. */
export function validateSmmServices(
  services: SmmService[],
  options: {
    minViews: number;
    minLikes: number;
    viewServiceId: string;
    likeServiceId: string;
    viewOrderQuantity: number;
    likeOrderQuantity: number;
  },
): void {
  if (!Array.isArray(services)) {
    throw new Error("Không tải được danh sách dịch vụ SmmFollows.");
  }
  const checks: Array<{
    metric: "Views" | "Likes";
    label: "view" | "like";
    min: number;
    id: string;
    qty: number;
  }> = [
    {
      metric: "Views",
      label: "view",
      min: options.minViews,
      id: String(options.viewServiceId || "").trim(),
      qty: options.viewOrderQuantity,
    },
    {
      metric: "Likes",
      label: "like",
      min: options.minLikes,
      id: String(options.likeServiceId || "").trim(),
      qty: options.likeOrderQuantity,
    },
  ];
  for (const c of checks) {
    // ID trống = không dùng metric đó (vd. chỉ auto View thì để trống Like).
    if (c.min <= 0 || !c.id) continue;
    const service = services.find((item) => String(item.service) === c.id);
    if (!service) {
      throw new Error(
        `ID dịch vụ ${c.label} ${c.id} không tồn tại hoặc đã ngừng bán. Bấm “Tải dịch vụ” và chọn ID đang hoạt động.`,
      );
    }
    if (service.type !== "Default") {
      throw new Error(
        `Dịch vụ ${c.label} #${c.id} có loại ${service.type}; hãy chọn dịch vụ loại Default để đặt bằng link và số lượng.`,
      );
    }
    const min = Number(service.min);
    const max = Number(service.max);
    if (
      !Number.isInteger(c.qty) ||
      c.qty < 1 ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      c.qty < min ||
      c.qty > max
    ) {
      throw new Error(
        `Dịch vụ ${c.label} #${c.id} yêu cầu số lượng từ ${service.min} đến ${service.max}; đang nhập ${c.qty}.`,
      );
    }
  }
}

export function requireSmmOrder(data: unknown): string {
  const order = String((data as { order?: unknown })?.order || "");
  if (!/^[1-9]\d*$/.test(order)) {
    throw new Error(
      "SmmFollows chưa trả mã đơn hợp lệ. Kiểm tra lịch sử trên SmmFollows trước khi thử lại.",
    );
  }
  return order;
}

export function describeSmmOrderError(
  error: unknown,
  service: string,
  label: string,
): string {
  const message = String(
    error instanceof Error ? error.message : error || "Không đặt được đơn.",
  );
  if (/incorrect service id/i.test(message)) {
    return `ID dịch vụ ${label} #${service} không hợp lệ hoặc đã ngừng bán. Tải dịch vụ, sửa ID rồi thử lại.`;
  }
  return message;
}

export function isXServicesFilter(s: SmmService): boolean {
  const blob = `${s.category || ""} ${s.name || ""}`.toLowerCase();
  return /\b(x|twitter|tweet)\b/.test(blob) || /view|like|repost|follower/.test(blob);
}
