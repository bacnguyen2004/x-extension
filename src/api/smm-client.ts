/**
 * SmmFollows API v2 — port từ x-ai-extenstion/background/smm-api.js
 * Sidepanel không gọi trực tiếp; SW dùng call() với key đã lưu.
 */

export const SMM_API_URL = "https://smmfollows.com/api/v2";

export const SMM_ALLOWED_ACTIONS = new Set<string>([
  "services",
  "balance",
  "add",
  "status",
  "refill",
  "refill_status",
  "cancel",
]);

export type SmmAction =
  | "services"
  | "balance"
  | "add"
  | "status"
  | "refill"
  | "refill_status"
  | "cancel";

export interface SmmService {
  service: number | string;
  name?: string;
  type?: string;
  category?: string;
  rate?: string | number;
  min?: string | number;
  max?: string | number;
  [key: string]: unknown;
}

export function normalizeIds(value: unknown, label: string): string {
  const ids = String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error(`Hãy nhập ${label}.`);
  if (ids.length > 100) throw new Error(`Chỉ hỗ trợ tối đa 100 ${label}.`);
  if (ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error(`${label} chỉ được chứa chữ số.`);
  }
  return [...new Set(ids)].join(",");
}

export function buildParameters(
  action: string,
  params: Record<string, unknown> = {},
): Record<string, string> {
  if (!SMM_ALLOWED_ACTIONS.has(action as SmmAction)) {
    throw new Error("Tác vụ API không được hỗ trợ.");
  }
  const output: Record<string, string> = { action };

  if (action === "status") {
    const ids = normalizeIds(params.ids, "Order ID");
    const multiple = ids.includes(",");
    output[multiple ? "orders" : "order"] = ids;
  }
  if (action === "refill") {
    const ids = normalizeIds(params.ids, "Order ID");
    const multiple = ids.includes(",");
    output[multiple ? "orders" : "order"] = ids;
  }
  if (action === "add") {
    const service = String(params.service || "").trim();
    const link = String(params.link || "").trim();
    const quantity = Number(params.quantity);
    if (!/^\d+$/.test(service)) throw new Error("ID dịch vụ chỉ được chứa chữ số.");
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new Error("Link bài viết không hợp lệ.");
    }
    const hostOk = ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
      url.hostname,
    );
    const statusPath = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/);
    if (
      url.protocol !== "https:" ||
      url.username || url.password ||
      !hostOk ||
      !statusPath
    ) {
      throw new Error("Link đơn phải là bài viết trên X.");
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000_000) {
      throw new Error("Số lượng đơn phải từ 1 đến 10.000.000.");
    }
    output.service = service;
    output.link = `${url.origin}/${statusPath[1]}/status/${statusPath[2]}`;
    output.quantity = String(quantity);
  }
  if (action === "cancel") output.orders = normalizeIds(params.ids, "Order ID");
  if (action === "refill_status") {
    const ids = normalizeIds(params.ids, "Refill ID");
    const multiple = ids.includes(",");
    output[multiple ? "refills" : "refill"] = ids;
  }
  return output;
}

export async function callSmm(
  action: string,
  params: Record<string, unknown>,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Hãy nhập API key.");
  const body = new URLSearchParams({ key, ...buildParameters(action, params) });
  const response = await fetchImpl(SMM_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const raw = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("API trả về dữ liệu không hợp lệ.");
  }
  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string" ? data.error : `API trả về HTTP ${response.status}.`,
    );
  }
  if (typeof data?.error === "string" && data.error) throw new Error(data.error);
  return data;
}
