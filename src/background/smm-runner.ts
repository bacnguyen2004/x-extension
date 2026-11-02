/**
 * Orchestrate SMM: API calls, manual order, profile scan + auto order.
 */

import { callSmm, type SmmService } from "../api/smm-client.ts";
import { acquireXTurn, startExclusiveX } from "./x-coordinator.ts";
import {
  describeSmmOrderError,
  isXServicesFilter,
  requireSmmOrder,
  sanitizeSmmSettings,
  validateSmmServices,
  type SmmPublicState,
  type SmmScannedPost,
  type SmmSettings,
} from "../domain/smm-settings.ts";
import {
  clearSmmApiKey,
  clearSmmOrders,
  getCachedSmmServices,
  getSmmBalanceCache,
  getSmmPublicState,
  getSmmScanSnapshot,
  isSmmScanCancelRequested,
  loadSmmOrders,
  loadSmmSettings,
  pushSmmOrder,
  requestSmmScanCancel,
  resetSmmScanCancel,
  saveSmmSettings,
  setCachedSmmServices,
  setSmmBalanceCache,
  setSmmScanSnapshot,
} from "./smm-store.ts";
import {
  navigateXTab,
  requestPostScanCollect,
  requestPostScanScroll,
  waitForXConnection,
} from "./x-bridge.ts";

const LOG = "[x-content-creator/smm]";

function extensionId(): string {
  return chrome.runtime.id;
}

function broadcastSmm(state: SmmPublicState): void {
  try {
    chrome.runtime.sendMessage({ type: "smm_state", smm: state }).catch(() => {});
  } catch {
    /* no receivers */
  }
}

async function notify(): Promise<SmmPublicState> {
  const smm = await getSmmPublicState(extensionId());
  broadcastSmm(smm);
  return smm;
}

export async function smmGetState(): Promise<{ ok: true; smm: SmmPublicState }> {
  return { ok: true, smm: await getSmmPublicState(extensionId()) };
}

export async function smmSaveSettings(raw: unknown): Promise<{
  ok: boolean;
  smm?: SmmPublicState;
  error?: string;
}> {
  const current = await loadSmmSettings(extensionId());
  const incoming = sanitizeSmmSettings(raw);
  // Giữ key cũ nếu form gửi trống (giống AI tab).
  if (!incoming.apiKey.trim() && current.apiKey.trim()) {
    incoming.apiKey = current.apiKey;
  }
  await saveSmmSettings(incoming, extensionId());
  return { ok: true, smm: await notify() };
}

export async function smmClearKey(): Promise<{ ok: true; smm: SmmPublicState }> {
  await clearSmmApiKey(extensionId());
  setSmmBalanceCache(null, null);
  return { ok: true, smm: await notify() };
}

async function withKey(): Promise<string> {
  const s = await loadSmmSettings(extensionId());
  const key = s.apiKey.trim();
  if (!key) throw new Error("Hãy lưu SMM API key trước.");
  return key;
}

export async function smmRequest(
  action: string,
  params: Record<string, unknown> = {},
): Promise<{ ok: boolean; data?: unknown; smm?: SmmPublicState; error?: string }> {
  try {
    const key = await withKey();
    const data = await callSmm(action, params, key);
    if (action === "services" && Array.isArray(data)) {
      setCachedSmmServices(data as SmmService[]);
    }
    if (action === "balance" && data && typeof data === "object") {
      const b = data as { balance?: unknown; currency?: unknown };
      setSmmBalanceCache(
        b.balance != null ? String(b.balance) : null,
        b.currency != null ? String(b.currency) : null,
      );
    }
    return { ok: true, data, smm: await notify() };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      smm: await getSmmPublicState(extensionId()),
    };
  }
}

interface PlaceOrderOptions {
  link: string;
  metric: "views" | "likes";
  service?: string;
  quantity?: number;
  postId?: string;
}

type PlaceOrderResult = { ok: boolean; order?: string; smm?: SmmPublicState; error?: string };
const pendingOrders = new Map<string, Promise<PlaceOrderResult>>();

export function smmPlaceOrder(opts: PlaceOrderOptions): Promise<PlaceOrderResult> {
  const postId = opts.link.match(/\/status\/(\d+)/)?.[1];
  const key = `${postId ?? opts.link}:${opts.metric}`;
  const pending = pendingOrders.get(key);
  if (pending) return pending;
  const request = placeOrder({ ...opts, postId: postId ?? opts.postId }).finally(() => {
    if (pendingOrders.get(key) === request) pendingOrders.delete(key);
  });
  pendingOrders.set(key, request);
  return request;
}

async function placeOrder(opts: PlaceOrderOptions): Promise<PlaceOrderResult> {
  try {
    if (opts.postId) {
      const previous = (await loadSmmOrders()).find((order) => order.postId === opts.postId && order.metric === opts.metric);
      if (previous) return { ok: true, order: previous.order, smm: await notify() };
    }
    const settings = await loadSmmSettings(extensionId());
    const metric = opts.metric === "likes" ? "likes" : "views";
    const service =
      String(opts.service || "").trim() ||
      (metric === "likes" ? settings.likeServiceId : settings.viewServiceId);
    const quantity =
      typeof opts.quantity === "number" && opts.quantity > 0
        ? opts.quantity
        : metric === "likes"
          ? settings.likeOrderQuantity
          : settings.viewOrderQuantity;
    const key = await withKey();
    const data = await callSmm(
      "add",
      { service, link: opts.link, quantity },
      key,
    );
    const order = requireSmmOrder(data);
    await pushSmmOrder({
      order,
      service,
      quantity,
      metric,
      postId: opts.postId ?? opts.link.match(/\/status\/(\d+)/)?.[1],
      url: opts.link,
    });
    console.info(LOG, "order", order, metric, opts.link);
    return { ok: true, order, smm: await notify() };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      smm: await getSmmPublicState(extensionId()),
    };
  }
}

export async function smmClearHistory(): Promise<{ ok: true; smm: SmmPublicState }> {
  await clearSmmOrders();
  return { ok: true, smm: await notify() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureServices(settings: SmmSettings): Promise<SmmService[]> {
  let services = getCachedSmmServices();
  if (!services.length) {
    const key = await withKey();
    const data = await callSmm("services", {}, key);
    if (!Array.isArray(data)) throw new Error("SmmFollows trả danh sách dịch vụ không hợp lệ.");
    services = data as SmmService[];
    setCachedSmmServices(services);
  }
  if (settings.autoOrder) {
    validateSmmServices(services, settings);
  }
  return services;
}

export function filterXServices(services: SmmService[]): SmmService[] {
  const x = services.filter(isXServicesFilter);
  return x.length ? x : services;
}

let scanRunning = false;

export async function smmStartPostScan(): Promise<{
  ok: boolean;
  smm?: SmmPublicState;
  error?: string;
}> {
  return startExclusiveX("smm", smmStartPostScanExclusive);
}

async function smmStartPostScanExclusive(): Promise<{
  ok: boolean;
  smm?: SmmPublicState;
  error?: string;
}> {
  if (scanRunning) return { ok: false, error: "Đang quét.", smm: await getSmmPublicState(extensionId()) };
  scanRunning = true;
  resetSmmScanCancel();
  let release: (() => void) | null = null;

  try {
    const settings = await loadSmmSettings(extensionId());
    const user = settings.scanUsername;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(user)) {
      throw new Error("Nhập @username hợp lệ trước khi quét.");
    }
    if (settings.autoOrder) {
      await ensureServices(settings);
      if (!settings.apiKey.trim()) throw new Error("Hãy lưu SMM API key trước khi tự đặt đơn.");
    }

    setSmmScanSnapshot({
      scanning: true,
      cancelled: false,
      status: `Đang mở @${user}…`,
      scannedCount: 0,
      belowThreshold: [],
      orderedCount: 0,
    });
    await notify();

    release = await acquireXTurn("smm", isSmmScanCancelRequested);
    if (!release) throw new Error("Không thể dùng tab X. Hãy dừng chế độ khác trước.");
    const nav = await navigateXTab(`https://x.com/${user}`);
    if (!nav.ok) throw new Error(nav.error || "Không mở được tab X.");
    const conn = await waitForXConnection(15_000, nav.tabId);
    if (!conn.ok) throw new Error("Chưa có tab X kết nối. Mở x.com rồi thử lại.");

    const thresholds = {
      views: settings.minViews,
      likes: settings.minLikes,
      reposts: settings.minReposts,
      replies: settings.minReplies,
    };
    const delayMs = Math.max(1000, settings.scanDelaySec * 1000);
    const posts = new Map<string, SmmScannedPost>();
    let unchanged = 0;
    let prev = 0;

    for (let round = 0; round < 1000; round++) {
      if (isSmmScanCancelRequested()) break;

      const collect = await requestPostScanCollect({
        username: user,
        thresholds,
        targetCount: settings.scanLimit,
        knownIds: [...posts.keys()],
        tabId: nav.tabId,
      });
      if (!collect.ok) {
        if (collect.error === "busy") {
          await sleep(800);
          continue;
        }
        throw new Error(collect.error || "Quét bài thất bại.");
      }
      const batch = Array.isArray(collect.posts) ? collect.posts : [];
      for (const p of batch) {
        if (p && typeof p === "object" && typeof (p as SmmScannedPost).id === "string") {
          posts.set((p as SmmScannedPost).id, p as SmmScannedPost);
        }
      }

      const below = [...posts.values()].filter((p) => p.below.length > 0);
      setSmmScanSnapshot({
        scanning: true,
        cancelled: false,
        status: `Đang quét: ${posts.size}/${settings.scanLimit} bài…`,
        scannedCount: posts.size,
        belowThreshold: below,
        orderedCount: getSmmScanSnapshot().orderedCount,
      });
      await notify();

      if (posts.size >= settings.scanLimit) break;
      unchanged = posts.size === prev ? unchanged + 1 : 0;
      prev = posts.size;
      if (unchanged >= 8) break;

      await requestPostScanScroll(undefined, nav.tabId);
      await sleep(delayMs);
    }

    const scanStopped = isSmmScanCancelRequested();
    release();
    release = null;
    const below = [...posts.values()].filter((p) => p.below.length > 0);
    const willOrder = settings.autoOrder && below.length > 0;
    setSmmScanSnapshot({
      scanning: willOrder,
      cancelled: scanStopped && !willOrder,
      status: scanStopped
        ? `Đã dừng quét sau ${posts.size} bài · ${below.length} dưới ngưỡng.`
        : `Đã quét ${posts.size} bài · ${below.length} dưới ngưỡng.`,
      scannedCount: posts.size,
      belowThreshold: below,
      orderedCount: 0,
    });
    await notify();

    // Dừng lúc quét chỉ ngừng thu thập thêm bài — vẫn đặt đơn cho bài đã tìm thấy.
    // Bấm Dừng lần nữa trong lúc đặt đơn mới hủy các đơn còn lại.
    if (willOrder) {
      resetSmmScanCancel();
      await placeOrdersForPosts(below, settings);
    }

    return { ok: true, smm: await notify() };
  } catch (e) {
    setSmmScanSnapshot({
      ...getSmmScanSnapshot(),
      scanning: false,
      status: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      smm: await notify(),
    };
  } finally {
    release?.();
    scanRunning = false;
    resetSmmScanCancel();
  }
}

export async function smmStopPostScan(): Promise<{ ok: true; smm: SmmPublicState }> {
  requestSmmScanCancel();
  
  setSmmScanSnapshot({
    ...getSmmScanSnapshot(),
    status: "Đang dừng…",
  });
  return { ok: true, smm: await notify() };
}

async function placeOrdersForPosts(
  posts: SmmScannedPost[],
  settings: SmmSettings,
): Promise<void> {
  const existing = await loadSmmOrders();
  const have = new Set(existing.map((o) => `${o.postId}:${o.metric}`));
  let ordered = 0;

  for (const post of posts) {
    if (isSmmScanCancelRequested()) break;
    for (const metric of ["views", "likes"] as const) {
      if (isSmmScanCancelRequested()) break;
      if (!post.below.includes(metric)) continue;
      if (metric === "views" && settings.minViews <= 0) continue;
      if (metric === "likes" && settings.minLikes <= 0) continue;
      const service = metric === "views" ? settings.viewServiceId : settings.likeServiceId;
      if (!String(service || "").trim()) continue;
      const key = `${post.id}:${metric}`;
      if (have.has(key)) continue;
      const quantity =
        metric === "views" ? settings.viewOrderQuantity : settings.likeOrderQuantity;
      const label = metric === "views" ? "view" : "like";
      try {
        const res = await smmPlaceOrder({
          link: post.url,
          metric,
          service,
          quantity,
          postId: post.id,
        });
        if (!res.ok) throw new Error(res.error || "order_failed");
        have.add(key);
        ordered += 1;
        setSmmScanSnapshot({
          ...getSmmScanSnapshot(),
          orderedCount: ordered,
          status: `Đã đặt ${ordered} đơn…`,
        });
        await notify();
      } catch (e) {
        console.warn(LOG, "auto-order fail", key, describeSmmOrderError(e, service, label));
        setSmmScanSnapshot({
          ...getSmmScanSnapshot(),
          status: describeSmmOrderError(e, service, label),
        });
        await notify();
      }
      await sleep(600);
    }
  }

  const cancelled = isSmmScanCancelRequested();
  setSmmScanSnapshot({
    ...getSmmScanSnapshot(),
    scanning: false,
    cancelled,
    orderedCount: ordered,
    status: `${cancelled ? "Đã dừng" : "Xong"} · ${getSmmScanSnapshot().scannedCount} bài · đặt ${ordered} đơn.`,
  });
}

export async function smmRetryFailedOrders(): Promise<{
  ok: boolean;
  smm?: SmmPublicState;
  error?: string;
}> {
  return startExclusiveX("smm", smmRetryFailedOrdersExclusive);
}

async function smmRetryFailedOrdersExclusive(): Promise<{
  ok: boolean;
  smm?: SmmPublicState;
  error?: string;
}> {
  if (scanRunning) return { ok: false, error: "Đang quét hoặc đặt đơn.", smm: await getSmmPublicState(extensionId()) };
  scanRunning = true;
  resetSmmScanCancel();
  try {
    const snap = getSmmScanSnapshot();
    const settings = await loadSmmSettings(extensionId());
    if (!settings.autoOrder) {
      return { ok: false, error: "Bật Tự đặt đơn rồi Save trước.", smm: await getSmmPublicState(extensionId()) };
    }
    setSmmScanSnapshot({ ...snap, scanning: true, cancelled: false, status: "Đang thử lại đơn…" });
    await notify();
    await ensureServices(settings);
    await placeOrdersForPosts(snap.belowThreshold, settings);
    return { ok: true, smm: await notify() };
  } catch (e) {
    setSmmScanSnapshot({ ...getSmmScanSnapshot(), scanning: false, status: e instanceof Error ? e.message : String(e) });
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      smm: await notify(),
    };
  } finally {
    scanRunning = false;
    resetSmmScanCancel();
  }
}
