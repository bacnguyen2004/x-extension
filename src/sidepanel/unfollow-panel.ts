/**
 * Tab Unfollow — UI bảo vệ + Start/Stop.
 */

import type {
  UnfollowRuntimePublic,
  UnfollowSettings,
  UnfollowSourceMode,
} from "../domain/unfollow-settings.ts";
import { sanitizeUnfollowSettings } from "../domain/unfollow-settings.ts";

type Send = (
  type: string,
  extra?: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  unfollow?: UnfollowRuntimePublic;
  settings?: UnfollowSettings;
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

export function initUnfollowPanel(send: Send): {
  onViewEnter: (view: string) => void;
  onMessage: (msg: unknown) => void;
} {
  const msgEl = $("uf-msg");
  const titleEl = $("uf-status-title");
  const metaEl = $("uf-status-meta");
  const metricsEl = $("uf-metrics");
  const logEl = $("uf-log");
  const btnStart = $("uf-start") as HTMLButtonElement;
  const btnStop = $("uf-stop") as HTMLButtonElement;

  let loaded = false;
  let dirty = false;
  let formRevision = 0;

  function setMsg(text: string): void {
    msgEl.textContent = text;
  }

  function sourceMode(): UnfollowSourceMode {
    return input("uf-src-list").checked ? "list" : "own_following";
  }

  function syncSourceUi(): void {
    const list = sourceMode() === "list";
    const boxOwn = $("uf-box-own");
    const boxList = $("uf-box-list");
    boxOwn.hidden = list;
    boxOwn.classList.toggle("hidden", list);
    boxList.hidden = !list;
    boxList.classList.toggle("hidden", !list);
  }

  function updatePaceSummary(): void {
    const value = (id: string) => input(id).value.trim() || "—";
    $("uf-pace-summary").textContent = `${value("uf-daily")}/ngày · ${value("uf-max30")}/30 phút · nghỉ ${value("uf-delay-min")}–${value("uf-delay-max")} giây`;
    const notes: string[] = [];
    if (input("uf-protect-verified").checked && select("uf-verified").value === "require") {
      notes.push("Không có tài khoản nào đủ điều kiện: bạn vừa chọn chỉ hủy tài khoản có tick, vừa giữ tài khoản có tick.");
    }
    const keep = numOrEmpty(input("uf-protect-sorsa"));
    const target = numOrEmpty(input("uf-sorsa-max"));
    if (keep != null && target != null) {
      notes.push(`Kết hợp hai ngưỡng: chỉ xét hủy khi Sorsa < ${Math.min(keep, target)}.`);
    }
    if (input("uf-only-not-flback").checked) {
      notes.push("Xét trực tiếp trên Following: có nhãn Follows you thì giữ; không có nhãn trên dòng đã tải đủ thì xét hủy. Thiếu dữ liệu thì bỏ qua, không mở profile.");
    }
    if (numOrEmpty(input("uf-flw-max")) != null) {
      notes.push("Lọc followers chỉ khi danh sách có số liệu; thiếu số liệu thì bỏ qua, không mở profile.");
    }
    $("uf-rules-summary").textContent = notes.join(" ");
  }

  function fillForm(s: UnfollowSettings): void {
    input("uf-src-own").checked = s.sourceMode === "own_following";
    input("uf-src-list").checked = s.sourceMode === "list";
    syncSourceUi();
    input("uf-own").value = s.ownHandle ? `@${s.ownHandle}` : "";
    textarea("uf-list").value = s.usernameList;
    input("uf-protect-sorsa").value =
      s.protect.sorsaMin != null ? String(s.protect.sorsaMin) : "";
    input("uf-protect-verified").checked = s.protect.protectVerified;
    input("uf-protect-missing").checked = s.protect.protectMissingSorsa;
    textarea("uf-whitelist").value = s.protect.whitelist.map((h) => `@${h}`).join(", ");
    select("uf-verified").value = s.targets.verified;
    input("uf-sorsa-max").value =
      s.targets.sorsaMax != null ? String(s.targets.sorsaMax) : "";
    input("uf-flw-max").value =
      s.targets.followersMax != null ? String(s.targets.followersMax) : "";
    input("uf-only-not-flback").checked = s.targets.onlyNotFollowBack;
    textarea("uf-blacklist").value = s.targets.blacklist.map((h) => `@${h}`).join(", ");
    input("uf-daily").value = String(s.pace.dailyTarget);
    input("uf-max30").value = String(s.pace.maxPer30Min);
    input("uf-delay-min").value = String(s.pace.delaySecMin);
    input("uf-delay-max").value = String(s.pace.delaySecMax);
    dirty = false;
    $("uf-save-state").textContent = "Bắt đầu sẽ lưu cấu hình hiện tại.";
    updatePaceSummary();
  }

  function collectForm(): UnfollowSettings {
    return sanitizeUnfollowSettings({
      sourceMode: sourceMode(),
      ownHandle: input("uf-own").value,
      usernameList: textarea("uf-list").value,
      protect: {
        whitelist: textarea("uf-whitelist").value,
        sorsaMin: numOrEmpty(input("uf-protect-sorsa")),
        protectVerified: input("uf-protect-verified").checked,
        protectMissingSorsa: input("uf-protect-missing").checked,
      },
      targets: {
        sorsaMax: numOrEmpty(input("uf-sorsa-max")),
        verified: select("uf-verified").value,
        followersMax: numOrEmpty(input("uf-flw-max")),
        onlyNotFollowBack: input("uf-only-not-flback").checked,
        blacklist: textarea("uf-blacklist").value,
      },
      pace: {
        dailyTarget: Number(input("uf-daily").value),
        maxPer30Min: Number(input("uf-max30").value),
        delaySecMin: Number(input("uf-delay-min").value),
        delaySecMax: Number(input("uf-delay-max").value),
      },
    });
  }

  function paintRuntime(f: UnfollowRuntimePublic): void {
    const waitingLimit = f.running && f.unfollowedInWindow >= f.maxPer30Min;
    titleEl.textContent = waitingLimit ? "Chờ giới hạn 30 phút"
      : f.running ? "Đang chạy" : f.startedAt ? "Đã dừng" : "Sẵn sàng";
    metaEl.textContent = f.detail || "Chọn nguồn và điều kiện trước khi bắt đầu.";
    btnStart.disabled = f.running;
    btnStop.disabled = !f.running;
    document.getElementById("uf-live-dot")?.classList.toggle("on", f.running);

    const nowBox = document.getElementById("uf-now");
    const nowHandle = document.getElementById("uf-now-handle");
    const nowStep = document.getElementById("uf-now-step");
    const nowSeen = document.getElementById("uf-now-seen");
    if (nowBox && nowHandle && nowStep && nowSeen) {
      nowBox.hidden = !f.running && !f.processed && !(f.seenCount > 0);
      nowHandle.textContent = f.currentHandle ? `@${f.currentHandle}` : "—";
      nowStep.textContent = f.detail || "—";
      nowSeen.textContent = `Đã xem ${f.seenCount || 0} · Đã xử lý ${f.processed || 0}`;
    }

    metricsEl.replaceChildren();
    const cards: [string, string][] = [
      [String(f.unfollowedToday), "Hủy hôm nay"],
      [`${f.unfollowedInWindow}/${f.maxPer30Min}`, "Trong 30 phút"],
      [String(f.protectedCount), "Được giữ lại"],
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
    const progress = $("uf-progress") as HTMLProgressElement;
    progress.max = Math.max(1, f.dailyTarget);
    progress.value = Math.min(progress.max, Math.max(0, f.unfollowedToday));
    $("uf-progress-label").textContent = `${f.unfollowedToday} / ${f.dailyTarget}`;

    logEl.replaceChildren();
    const logs = f.recentLogs.slice(0, 40);
    $("uf-log-count").textContent = logs.length ? `${logs.length} hoạt động` : "Chưa có hoạt động";
    if (logs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "uf-log-empty";
      const heading = document.createElement("strong");
      heading.textContent = f.running ? "Đang tìm tài khoản…" : "Chưa bắt đầu phiên nào";
      const hint = document.createElement("span");
      hint.className = "uf-help";
      hint.textContent = f.running ? "Kết quả xử lý sẽ xuất hiện tại đây." : "Nhật ký sẽ ghi lại tài khoản đã hủy, giữ lại và bỏ qua.";
      empty.append(heading, hint);
      logEl.appendChild(empty);
    }
    for (const entry of logs) {
      const row = document.createElement("div");
      const level =
        entry.action === "error"
          ? "error"
          : entry.action === "protect" || entry.action === "skip"
            ? "warn"
            : entry.action === "unfollow"
              ? "action"
              : "info";
      row.className = `activity-item level-${level}`;
      const time = new Date(entry.at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const meta = document.createElement("div");
      meta.className = "uf-log-meta";
      const tag = document.createElement("span");
      tag.className = "uf-log-tag";
      tag.textContent = { error: "Lỗi", protect: "Giữ lại", skip: "Bỏ qua", unfollow: "Đã hủy", info: "Thông tin" }[entry.action];
      const timestamp = document.createElement("time");
      timestamp.dateTime = new Date(entry.at).toISOString();
      timestamp.textContent = time;
      const message = document.createElement("div");
      message.textContent = entry.reason === "follows_you_unknown"
        ? `Bỏ qua @${entry.handle}: dòng Following chưa tải đủ để xác minh follow lại.`
        : entry.reason === "follows_you"
          ? `Giữ @${entry.handle}: tài khoản này đang follow bạn.` : entry.message;
      meta.append(tag, timestamp);
      row.append(meta, message);
      logEl.appendChild(row);
    }
  }

  async function refresh(): Promise<void> {
    const res = await send("get_unfollow_state");
    if (res.ok && res.settings && !dirty) fillForm(res.settings);
    if (res.ok && res.unfollow) paintRuntime(res.unfollow);
    loaded = true;
  }

  input("uf-src-own").addEventListener("change", syncSourceUi);
  input("uf-src-list").addEventListener("change", syncSourceUi);
  const markEdited = () => {
    dirty = true;
    formRevision++;
    $("uf-save-state").textContent = "Có thay đổi chưa lưu · Bắt đầu để áp dụng.";
    updatePaceSummary();
  };
  $("uf-settings").addEventListener("input", markEdited);
  $("uf-settings").addEventListener("change", markEdited);

  $("uf-save").addEventListener("click", async () => {
    const savingRevision = formRevision;
    const res = await send("save_unfollow_settings", { settings: collectForm() });
    if (res.ok && res.settings) {
      if (formRevision === savingRevision) fillForm(res.settings);
      setMsg("Đã lưu cấu hình.");
    } else setMsg(res.error ?? "Không lưu được cấu hình.");
    if (res.unfollow) paintRuntime(res.unfollow);
  });

  btnStart.addEventListener("click", async () => {
    const savingRevision = formRevision;
    setMsg("Đang bắt đầu…");
    const res = await send("unfollow_start", { settings: collectForm() });
    if (res.ok && res.unfollow) {
      paintRuntime(res.unfollow);
      setMsg("Đã bắt đầu Unfollow.");
    } else {
      setMsg(
        res.error === "no_x_tab"
          ? "Mở tab x.com trước khi bắt đầu."
          : res.error === "empty_list"
            ? "Nhập ít nhất một tài khoản vào danh sách."
            : res.error === "no_own_handle"
              ? "Nhập @username của bạn để mở Following."
              : res.error ?? "Không bắt đầu được phiên.",
      );
    }
    if (res.settings && formRevision === savingRevision) fillForm(res.settings);
    if (res.unfollow) paintRuntime(res.unfollow);
  });

  btnStop.addEventListener("click", async () => {
    const res = await send("unfollow_stop");
    if (res.unfollow) paintRuntime(res.unfollow);
    setMsg(res.ok ? "Đã dừng Unfollow." : res.error ?? "Không dừng được phiên.");
  });

  document.addEventListener("xcc-fu-mode", ((ev: CustomEvent<string>) => {
    if (ev.detail === "unfollow") void refresh();
  }) as EventListener);

  return {
    onViewEnter(view: string) {
      // Gộp chung tab Follow — refresh khi vào tab hoặc đang ở pane Unfollow.
      if (view !== "follow" && view !== "unfollow") return;
      const onUnfollow = (document.getElementById("fu-mode-unfollow") as HTMLInputElement | null)
        ?.checked;
      if (view === "follow" && !onUnfollow && loaded) return;
      void refresh();
    },
    onMessage(msg: unknown) {
      if (!msg || typeof msg !== "object") return;
      const m = msg as {
        type?: string;
        unfollow?: UnfollowRuntimePublic;
        settings?: UnfollowSettings;
      };
      if (m.type === "unfollow_state") {
        if (m.settings && !dirty) fillForm(m.settings);
        if (m.unfollow) paintRuntime(m.unfollow);
      }
    },
  };
}
