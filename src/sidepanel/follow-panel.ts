/**
 * Tab Follow — UI nguồn + filter + Start/Stop.
 */

import type {
  FollowRuntimePublic,
  FollowSettings,
  FollowSourceMode,
} from "../domain/follow-settings.ts";
import { sanitizeFollowSettings, parseHandleList } from "../domain/follow-settings.ts";
import { initFollowHistoryPanel } from "./follow-history-panel.ts";

type Send = (
  type: string,
  extra?: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  follow?: FollowRuntimePublic;
  settings?: FollowSettings;
  error?: string;
}>;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function textarea(id: string): HTMLTextAreaElement {
  return document.getElementById(id) as HTMLTextAreaElement;
}

function select(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

function numOrEmpty(el: HTMLInputElement): number | null {
  const v = el.value.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function initFollowPanel(send: Send): {
  onViewEnter: (view: string) => void;
  onMessage: (msg: unknown) => void;
} {
  const historyPanel = initFollowHistoryPanel(send);
  const msgEl = $("fl-msg");
  const titleEl = $("fl-status-title");
  const metaEl = $("fl-status-meta");
  const metricsEl = $("fl-metrics");
  const logEl = $("fl-log");
  const btnStart = $("fl-start") as HTMLButtonElement;
  const btnStop = $("fl-stop") as HTMLButtonElement;

  let loaded = false;
  let settings: FollowSettings | null = null;
  let follow: FollowRuntimePublic | null = null;
  let formRevision = 0;
  let savedRevision = 0;

  chrome.storage?.onChanged?.addListener((changes, area) => {
    const change = changes["xContentCreator.follow.v1"];
    if (area !== "local" || !change?.newValue) return;
    const next = sanitizeFollowSettings(change.newValue);
    if (formRevision === savedRevision) fillForm(next);
    else {
      const previous = parseHandleList(String(change.oldValue?.usernameList ?? ""));
      const remaining = new Set(parseHandleList(next.usernameList));
      const removed = new Set(previous.filter(handle => !remaining.has(handle)));
      const current = parseHandleList(textarea("fl-list").value);
      if (current.some(handle => removed.has(handle)))
        textarea("fl-list").value = current.filter(handle => !removed.has(handle)).map(handle => `@${handle}`).join("\n");
    }
  });

  function setMsg(text: string): void {
    msgEl.textContent = text;
  }

  function sourceMode(): FollowSourceMode {
    return input("fl-src-kol").checked ? "kol_followers" : "list";
  }

  function syncSourceUi(): void {
    const kol = sourceMode() === "kol_followers";
    const boxList = $("fl-box-list");
    const boxKol = $("fl-box-kol");
    boxList.hidden = kol;
    boxList.classList.toggle("hidden", kol);
    boxKol.hidden = !kol;
    boxKol.classList.toggle("hidden", !kol);
  }

  function fillForm(s: FollowSettings): void {
    settings = s;
    input("fl-src-list").checked = s.sourceMode === "list";
    input("fl-src-kol").checked = s.sourceMode === "kol_followers";
    syncSourceUi();
    textarea("fl-list").value = s.usernameList;
    input("fl-engage-latest").checked = s.engageLatestPost === true;
    input("fl-kol").value = s.kolHandle ? `@${s.kolHandle}` : "";
    input("fl-sorsa-min").value = s.filters.sorsaMin != null ? String(s.filters.sorsaMin) : "";
    input("fl-sorsa-max").value = s.filters.sorsaMax != null ? String(s.filters.sorsaMax) : "";
    input("fl-flw-min").value = s.filters.followersMin != null ? String(s.filters.followersMin) : "";
    input("fl-flw-max").value = s.filters.followersMax != null ? String(s.filters.followersMax) : "";
    select("fl-verified").value = s.filters.verified;
    input("fl-allow-missing-sorsa").checked = s.filters.allowMissingSorsa;
    textarea("fl-blacklist").value = s.filters.blacklist.map((h) => `@${h}`).join(", ");
    textarea("fl-whitelist").value = s.filters.whitelist.map((h) => `@${h}`).join(", ");
    input("fl-daily").value = String(s.pace.dailyTarget);
    input("fl-max30").value = String(s.pace.maxPer30Min);
    input("fl-delay-min").value = String(s.pace.delaySecMin);
    input("fl-delay-max").value = String(s.pace.delaySecMax);
  }

  function collectForm(): FollowSettings {
    return sanitizeFollowSettings({
      sourceMode: sourceMode(),
      usernameList: textarea("fl-list").value,
      engageLatestPost: input("fl-engage-latest").checked,
      kolHandle: input("fl-kol").value,
      filters: {
        sorsaMin: numOrEmpty(input("fl-sorsa-min")),
        sorsaMax: numOrEmpty(input("fl-sorsa-max")),
        allowMissingSorsa: input("fl-allow-missing-sorsa").checked,
        verified: select("fl-verified").value,
        followersMin: numOrEmpty(input("fl-flw-min")),
        followersMax: numOrEmpty(input("fl-flw-max")),
        blacklist: textarea("fl-blacklist").value,
        whitelist: textarea("fl-whitelist").value,
      },
      pace: {
        dailyTarget: Number(input("fl-daily").value),
        maxPer30Min: Number(input("fl-max30").value),
        delaySecMin: Number(input("fl-delay-min").value),
        delaySecMax: Number(input("fl-delay-max").value),
      },
    });
  }

  function paintRuntime(f: FollowRuntimePublic): void {
    follow = f;
    titleEl.textContent = f.running && f.followedInWindow >= f.maxPer30Min ? "Chờ giới hạn 30 phút"
      : f.running ? "Đang chạy" : f.startedAt ? "Đã dừng" : "Sẵn sàng";
    metaEl.textContent = f.detail || "Chọn nguồn và bộ lọc trước khi bắt đầu.";
    btnStart.disabled = f.running;
    btnStop.disabled = !f.running;
    document.getElementById("fl-live-dot")?.classList.toggle("on", f.running);

    metricsEl.replaceChildren();
    const cards: [string, string][] = [
      [String(f.followedToday), "Follow hôm nay"],
      [`${f.followedInWindow}/${f.maxPer30Min}`, "Trong 30 phút"],
      [String(f.processed), "Đã xử lý"],
      [String(f.skipped), "Đã bỏ qua"],
    ];
    for (const [val, label] of cards) {
      const card = document.createElement("div");
      card.className = "metric";
      const v = document.createElement("span");
      v.className = "num";
      v.textContent = val;
      const l = document.createElement("span");
      l.className = "lbl";
      l.textContent = label;
      card.append(v, l);
      metricsEl.appendChild(card);
    }
    const progress = $("fl-progress") as HTMLProgressElement;
    progress.max = Math.max(1, f.dailyTarget);
    progress.value = Math.min(progress.max, Math.max(0, f.followedToday));
    $("fl-progress-label").textContent = `${f.followedToday} / ${f.dailyTarget}`;

    logEl.replaceChildren();
    if (!f.recentLogs.length) {
      const empty = document.createElement("div");
      empty.className = "uf-log-empty";
      empty.textContent = f.running ? "Đang tìm tài khoản phù hợp…" : "Kết quả sẽ xuất hiện khi bắt đầu phiên Follow.";
      logEl.appendChild(empty);
    }
    for (const entry of f.recentLogs.slice(0, 30)) {
      const row = document.createElement("div");
      const level =
        entry.action === "error"
          ? "error"
          : entry.action === "skip"
            ? "warn"
            : entry.action === "follow"
              ? "action"
              : "info";
      row.className = `activity-item level-${level}`;
      const time = document.createElement("div");
      time.className = "activity-time";
      time.textContent = new Date(entry.at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const message = document.createElement("div");
      message.textContent = entry.message;
      row.append(time, message);
      logEl.appendChild(row);
    }
  }

  async function refresh(): Promise<void> {
    const res = await send("get_follow_state");
    if (res.ok && res.settings && formRevision === savedRevision) fillForm(res.settings);
    if (res.ok && res.follow) paintRuntime(res.follow);
    loaded = true;
  }

  function syncModePanes(animate = false): void {
    const unfollow = input("fu-mode-unfollow").checked;
    const mode = unfollow ? "unfollow" : "follow";
    const shell = document.querySelector(".fu-connect-shell");
    shell?.setAttribute("data-fu-mode", mode);

    const paneFl = document.getElementById("fu-pane-follow");
    const paneUf = document.getElementById("fu-pane-unfollow");
    if (paneFl) {
      paneFl.hidden = unfollow;
      paneFl.classList.toggle("hidden", unfollow);
      paneFl.classList.remove("fu-pane-enter");
    }
    if (paneUf) {
      paneUf.hidden = !unfollow;
      paneUf.classList.toggle("hidden", !unfollow);
      paneUf.classList.remove("fu-pane-enter");
    }

    const active = unfollow ? paneUf : paneFl;
    if (animate && active && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      void active.offsetWidth;
      active.classList.add("fu-pane-enter");
    }
  }

  input("fl-src-list").addEventListener("change", syncSourceUi);
  input("fl-src-kol").addEventListener("change", syncSourceUi);
  input("fu-mode-follow").addEventListener("change", () => {
    syncModePanes(true);
    document.dispatchEvent(new CustomEvent("xcc-fu-mode", { detail: "follow" }));
  });
  input("fu-mode-unfollow").addEventListener("change", () => {
    syncModePanes(true);
    document.dispatchEvent(new CustomEvent("xcc-fu-mode", { detail: "unfollow" }));
  });
  syncModePanes(false);
  const markEdited = () => { formRevision++; };
  $("fl-settings").addEventListener("input", markEdited);
  $("fl-settings").addEventListener("change", markEdited);

  $("fl-save").addEventListener("click", async () => {
    const savingRevision = formRevision;
    const collected = collectForm();
    const res = await send("save_follow_settings", { settings: collected });
    if (res.ok && res.settings) {
      savedRevision = savingRevision;
      if (formRevision === savedRevision) fillForm(res.settings);
      setMsg("Đã lưu cấu hình.");
    } else {
      setMsg(res.error ?? "Không lưu được cấu hình.");
    }
    if (res.follow) paintRuntime(res.follow);
  });

  btnStart.addEventListener("click", async () => {
    const savingRevision = formRevision;
    const collected = collectForm();
    setMsg("Đang bắt đầu…");
    const res = await send("follow_start", { settings: collected });
    if (res.ok && res.follow) {
      paintRuntime(res.follow);
      savedRevision = savingRevision;
      setMsg("Đã bắt đầu Follow.");
    } else {
      setMsg(
        res.error === "no_x_tab"
          ? "Không kết nối được tab X. Reload trang x.com (hoặc mở lại), rồi bấm Bắt đầu lần nữa."
          : res.error === "navigate_failed"
            ? "Không mở được tab x.com. Cho phép extension mở tab rồi thử lại."
            : res.error === "empty_list"
              ? "Nhập ít nhất một tài khoản vào danh sách."
              : res.error === "bad_kol"
                ? "Nhập tài khoản KOL hợp lệ."
                : res.error ?? "Không bắt đầu được phiên.",
      );
    }
    if (res.settings && formRevision === savedRevision) fillForm(res.settings);
    if (res.follow) paintRuntime(res.follow);
  });

  btnStop.addEventListener("click", async () => {
    const res = await send("follow_stop");
    if (res.follow) paintRuntime(res.follow);
    setMsg(res.ok ? "Đã dừng Follow." : res.error ?? "Không dừng được phiên.");
  });

  return {
    onViewEnter(view: string) {
      historyPanel.onViewEnter(view);
      if (view !== "follow") return;
      syncModePanes();
      void refresh();
    },
    onMessage(msg: unknown) {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; follow?: FollowRuntimePublic; settings?: FollowSettings };
      if (m.type === "follow_state") {
        if (m.settings && formRevision === savedRevision) fillForm(m.settings);
        if (m.follow) paintRuntime(m.follow);
      }
    },
  };
}
