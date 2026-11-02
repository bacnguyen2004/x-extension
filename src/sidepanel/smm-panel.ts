/**
 * Tab SMM — SmmFollows: key, dịch vụ, đặt đơn, quét profile + auto order.
 */

import type {
  SmmOrderEntry,
  SmmPublicState,
  SmmScannedPost,
  SmmSettings,
  SmmSettingsPublic,
} from "../domain/smm-settings.ts";
import { sanitizeSmmSettings } from "../domain/smm-settings.ts";

type Send = (
  type: string,
  extra?: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  smm?: SmmPublicState;
  data?: unknown;
  xServices?: unknown[];
  order?: string;
  error?: string;
}>;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function paintMetricRow(el: HTMLElement, cards: [string, string][]): void {
  el.replaceChildren();
  for (const [val, label] of cards) {
    const chip = document.createElement("div");
    chip.className = "metric";
    const v = document.createElement("span");
    v.className = "num";
    v.textContent = val;
    const l = document.createElement("span");
    l.className = "lbl";
    l.textContent = label;
    chip.append(v, l);
    el.append(chip);
  }
}

export function initSmmPanel(send: Send): {
  onViewEnter: (view: string) => void;
  onMessage: (msg: unknown) => void;
} {
  const msgEl = $("smm-msg");
  const keyStatus = $("smm-key-status");
  const balanceEl = $("smm-balance");
  const titleEl = $("smm-status-title");
  const liveDot = $("smm-live-dot");
  const heroMetrics = $("smm-hero-metrics");
  const servicesStatus = $("smm-services-status");
  const scanStatus = $("smm-scan-status");
  const metricsEl = $("smm-scan-metrics");
  const postList = $("smm-post-list");
  const orderList = $("smm-order-list");
  const btnScan = $("smm-btn-scan") as HTMLButtonElement;
  const btnStop = $("smm-btn-scan-stop") as HTMLButtonElement;
  const paneOrder = $("smm-pane-order");
  const paneScan = $("smm-pane-scan");
  const orderPreview = $("smm-order-preview");

  let loaded = false;
  let settings: SmmSettingsPublic | null = null;
  let formRevision = 0;
  let savedRevision = 0;
  const settingIds = new Set([
    "smm-api-key", "smm-view-id", "smm-view-qty", "smm-like-id", "smm-like-qty", "smm-auto-order",
    "smm-scan-user", "smm-scan-limit", "smm-min-views", "smm-min-likes", "smm-scan-delay",
  ]);
  const markEdited = (event: Event) => {
    if (settingIds.has((event.target as HTMLElement).id)) formRevision++;
  };
  $("view-smm").addEventListener("input", markEdited);
  $("view-smm").addEventListener("change", markEdited);

  function setMsg(text: string): void {
    msgEl.textContent = text;
  }

  function mode(): "order" | "scan" {
    return input("smm-mode-scan").checked ? "scan" : "order";
  }

  function orderMetric(): "views" | "likes" {
    return input("smm-metric-likes").checked ? "likes" : "views";
  }

  function syncModeUi(): void {
    const scan = mode() === "scan";
    paneOrder.hidden = scan;
    paneOrder.classList.toggle("hidden", scan);
    paneScan.hidden = !scan;
    paneScan.classList.toggle("hidden", !scan);
  }

  function syncOrderPreview(): void {
    const metric = orderMetric();
    const id =
      metric === "likes" ? input("smm-like-id").value.trim() : input("smm-view-id").value.trim();
    const qty =
      metric === "likes" ? input("smm-like-qty").value.trim() : input("smm-view-qty").value.trim();
    const label = metric === "likes" ? "Like" : "View";
    if (!id) {
      orderPreview.textContent = `Chưa có mã dịch vụ ${label}. Mở cấu hình để bổ sung.`;
      orderPreview.classList.add("warn");
      return;
    }
    orderPreview.classList.remove("warn");
    orderPreview.textContent = `Sẽ đặt ${label} · ID ${id} · ×${qty || "?"}`;
  }

  function fillForm(s: SmmSettingsPublic): void {
    settings = s;
    input("smm-api-key").value = "";
    input("smm-api-key").placeholder = s.hasKey
      ? "Đã lưu key — dán mới để thay"
      : "Key SmmFollows";
    keyStatus.textContent = s.hasKey ? "Đã lưu API key." : "Chưa lưu key.";
    input("smm-view-id").value = s.viewServiceId;
    input("smm-view-qty").value = String(s.viewOrderQuantity);
    input("smm-like-id").value = s.likeServiceId;
    input("smm-like-qty").value = String(s.likeOrderQuantity);
    input("smm-auto-order").checked = s.autoOrder;
    input("smm-scan-user").value = s.scanUsername ? `@${s.scanUsername}` : "";
    input("smm-scan-limit").value = String(s.scanLimit);
    input("smm-min-views").value = String(s.minViews);
    input("smm-min-likes").value = String(s.minLikes);
    input("smm-scan-delay").value = String(s.scanDelaySec);
    syncOrderPreview();
  }

  function collectForm(): SmmSettings {
    return sanitizeSmmSettings({
      apiKey: input("smm-api-key").value,
      viewServiceId: input("smm-view-id").value,
      viewOrderQuantity: Number(input("smm-view-qty").value),
      likeServiceId: input("smm-like-id").value,
      likeOrderQuantity: Number(input("smm-like-qty").value),
      autoOrder: input("smm-auto-order").checked,
      scanUsername: input("smm-scan-user").value,
      scanLimit: Number(input("smm-scan-limit").value),
      minViews: Number(input("smm-min-views").value),
      minLikes: Number(input("smm-min-likes").value),
      scanDelaySec: Number(input("smm-scan-delay").value),
    });
  }

  function paintState(smm: SmmPublicState): void {
    if (formRevision === savedRevision) fillForm(smm.settings);
    const scan = smm.scan;
    const bal =
      smm.balance != null
        ? `${smm.balance}${smm.currency ? ` ${smm.currency}` : ""}`
        : smm.settings.hasKey
          ? "Chưa tải số dư"
          : "Chưa có key";
    balanceEl.textContent = bal;
    titleEl.textContent = scan.scanning ? "Đang xử lý" : "SMM";
    liveDot.classList.toggle("on", scan.scanning);

    paintMetricRow(heroMetrics, [
      [smm.balance != null ? String(smm.balance) : "—", "Số dư"],
      [String(smm.servicesLoaded || 0), "Dịch vụ"],
      [String(smm.recentOrders.length), "Đơn"],
    ]);

    scanStatus.textContent = scan.status;
    btnScan.disabled = scan.scanning;
    btnStop.disabled = !scan.scanning;
    ($("smm-btn-retry") as HTMLButtonElement).disabled = scan.scanning;
    paintMetricRow(metricsEl, [
      [String(scan.scannedCount), "Quét"],
      [String(scan.belowThreshold.length), "Thiếu"],
      [String(scan.orderedCount), "Đặt"],
    ]);
    renderPosts(scan.belowThreshold);
    renderOrders(smm.recentOrders);
  }

  function renderPosts(posts: SmmScannedPost[]): void {
    postList.replaceChildren();
    if (!posts.length) {
      const li = document.createElement("li");
      li.className = "smm-empty";
      li.textContent = "Chưa có bài dưới ngưỡng.";
      postList.append(li);
      return;
    }
    for (const post of posts.slice(0, 40)) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = post.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = post.url.replace(/^https:\/\/(www\.)?(x|twitter)\.com\//, "");
      const meta = document.createElement("span");
      meta.className = "smm-post-meta";
      meta.textContent = `v ${post.views ?? "—"} · ♥ ${post.likes ?? "—"} · thiếu ${post.below.join(",")}`;
      li.append(a, meta);
      postList.append(li);
    }
  }

  function renderOrders(orders: SmmOrderEntry[]): void {
    orderList.replaceChildren();
    if (!orders.length) {
      const li = document.createElement("li");
      li.className = "smm-empty";
      li.textContent = "Chưa có đơn.";
      orderList.append(li);
      return;
    }
    for (const o of orders.slice(0, 40)) {
      const li = document.createElement("li");
      const top = document.createElement("div");
      top.className = "smm-order-top";
      const id = document.createElement("strong");
      id.textContent = `#${o.order}`;
      const chip = document.createElement("span");
      chip.className = "smm-chip";
      chip.textContent = o.metric === "likes" ? "Like" : "View";
      top.append(id, chip);
      const meta = document.createElement("span");
      meta.className = "smm-post-meta";
      const when = new Date(o.at).toLocaleString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      });
      meta.textContent = `×${o.quantity} · Dịch vụ ${o.service} · ${when}`;
      li.append(top, meta);
      if (o.url) li.title = o.url;
      orderList.append(li);
    }
  }

  async function refresh(): Promise<void> {
    const res = await send("smm_get_state");
    if (res.ok && res.smm) paintState(res.smm);
  }

  async function save(): Promise<boolean> {
    const savingRevision = formRevision;
    const res = await send("smm_save_settings", { settings: collectForm() });
    if (res.ok && res.smm) {
      savedRevision = savingRevision;
      paintState(res.smm);
      setMsg("Đã lưu.");
      return true;
    } else {
      setMsg(res.error || "Không lưu được.");
      return false;
    }
  }

  input("smm-mode-order").addEventListener("change", syncModeUi);
  input("smm-mode-scan").addEventListener("change", syncModeUi);
  input("smm-metric-views").addEventListener("change", syncOrderPreview);
  input("smm-metric-likes").addEventListener("change", syncOrderPreview);
  for (const id of ["smm-view-id", "smm-view-qty", "smm-like-id", "smm-like-qty"]) {
    input(id).addEventListener("input", syncOrderPreview);
  }
  syncModeUi();
  syncOrderPreview();

  $("smm-btn-save").addEventListener("click", () => void save());
  $("smm-btn-clear-key").addEventListener("click", async () => {
    const res = await send("smm_clear_key");
    if (res.ok && res.smm) {
      paintState(res.smm);
      setMsg("Đã xóa key.");
    }
  });
  $("smm-btn-balance").addEventListener("click", async () => {
    if (!(await save())) return;
    const res = await send("smm_request", { action: "balance" });
    if (res.ok && res.smm) {
      paintState(res.smm);
      setMsg("Đã tải số dư.");
    } else {
      setMsg(res.error || "Không lấy được số dư.");
    }
  });
  $("smm-btn-services").addEventListener("click", async () => {
    if (!(await save())) return;
    servicesStatus.textContent = "Đang tải…";
    const res = await send("smm_request", { action: "services" });
    if (!res.ok) {
      servicesStatus.textContent = res.error || "Lỗi tải dịch vụ.";
      setMsg(res.error || "Lỗi.");
      return;
    }
    const list = document.getElementById("smm-service-options") as HTMLDataListElement;
    list.replaceChildren();
    const services = (Array.isArray(res.xServices) ? res.xServices : res.data) as Array<{
      service?: unknown;
      name?: unknown;
      min?: unknown;
      max?: unknown;
      rate?: unknown;
    }>;
    if (!Array.isArray(services)) {
      servicesStatus.textContent = "Danh sách không hợp lệ.";
      return;
    }
    for (const s of services) {
      const opt = document.createElement("option");
      const id = String(s.service ?? "");
      opt.value = id;
      opt.label = `#${id} ${s.name || ""} · ${s.min}-${s.max} · ${s.rate ?? ""}/1k`;
      list.append(opt);
    }
    servicesStatus.textContent = `${services.length} dịch vụ X — chọn ID.`;
    if (res.smm) paintState(res.smm);
    setMsg(`Đã tải ${services.length} dịch vụ.`);
  });

  $("smm-btn-order").addEventListener("click", async () => {
    if (!(await save())) return;
    const link = input("smm-order-link").value.trim();
    const metric = orderMetric();
    const needId = metric === "likes" ? input("smm-like-id").value.trim() : input("smm-view-id").value.trim();
    if (!needId) {
      setMsg(metric === "likes" ? "Điền mã dịch vụ lượt thích trong cấu hình trước." : "Điền mã dịch vụ lượt xem trong cấu hình trước.");
      return;
    }
    setMsg(metric === "likes" ? "Đang đặt đơn Like…" : "Đang đặt đơn View…");
    const res = await send("smm_place_order", { link, metric });
    if (res.ok) {
      setMsg(`Đã đặt ${metric === "likes" ? "Like" : "View"} #${res.order || "?"}.`);
      if (res.smm) paintState(res.smm);
    } else {
      setMsg(res.error || "Đặt đơn thất bại.");
    }
  });

  btnScan.addEventListener("click", async () => {
    if (!(await save())) return;
    setMsg("Đang quét…");
    const res = await send("smm_start_post_scan");
    if (res.smm) paintState(res.smm);
    setMsg(res.ok ? "Quét xong." : res.error || "Quét lỗi.");
  });
  btnStop.addEventListener("click", async () => {
    const res = await send("smm_stop_post_scan");
    if (res.smm) paintState(res.smm);
    setMsg("Đã gửi lệnh dừng.");
  });
  $("smm-btn-retry").addEventListener("click", async () => {
    if (!(await save())) return;
    setMsg("Thử lại đơn…");
    const res = await send("smm_retry_orders");
    if (res.smm) paintState(res.smm);
    setMsg(res.ok ? "Đã thử lại." : res.error || "Lỗi.");
  });
  $("smm-btn-clear-history").addEventListener("click", async () => {
    const res = await send("smm_clear_history");
    if (res.ok && res.smm) {
      paintState(res.smm);
      setMsg("Đã xóa lịch sử đơn.");
    }
  });

  return {
    onViewEnter(view: string) {
      if (view !== "smm") return;
      loaded = true;
      void refresh();
    },
    onMessage(msg: unknown) {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; smm?: SmmPublicState };
      if (m.type === "smm_state" && m.smm) paintState(m.smm);
    },
  };
}
