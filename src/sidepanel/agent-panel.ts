import {
  priorityLabel,
  defaultDailyTargets,
  statusLabel,
  type AgentPublicState,
  type AgentSettings,
} from "../domain/agent-settings.ts";
import { defaultBrowseSchedule } from "../domain/feed-rotation.ts";
import { dailyTarget, TARGET_KINDS } from "../domain/daily-targets.ts";
import { restReasonLabel } from "../domain/adaptive-rest.ts";
import { pogoRetweetWindow, POGO_RETWEET_LIMIT } from "../domain/pogo-retweet.ts";

declare const chrome: typeof globalThis.chrome;

type SendFn = (
  type: string,
  extra?: Record<string, unknown>,
) => Promise<{ ok: boolean; agent?: AgentPublicState; error?: string }>;

export function initAgentPanel(send: SendFn): {
  showAgentData: (agent: AgentPublicState) => void;
  loadAgent: () => Promise<void>;
  onViewEnter: (view: string) => void;
} {
  const statusTitle = document.getElementById("agent-status-title")!;
  const statusMeta = document.getElementById("agent-status-meta")!;
  const statusDetail = document.getElementById("agent-status-detail")!;
  const statusNext = document.getElementById("ag-next");
  const liveDot = document.getElementById("ag-live-dot");
  const metrics = document.getElementById("agent-metrics")!;
  const summary = document.getElementById("agent-config-summary")!;
  const xSummary = document.getElementById("agent-x-summary");
  const jobList = document.getElementById("agent-job-list");
  const agentMsg = document.getElementById("agent-msg")!;
  const behaviorMsg = document.getElementById("behavior-msg")!;
  const activityList = document.getElementById("activity-list")!;
  const activityMsg = document.getElementById("activity-msg")!;
  const killBtn = document.getElementById("btn-agent-kill")!;
  const startBtn = document.getElementById("btn-agent-start") as HTMLButtonElement;
  const pauseBtn = document.getElementById("btn-agent-pause") as HTMLButtonElement;
  function syncBehaviorNests(): void {
    const pairs: Array<[string, string, string]> = [
      ["ag-random-author-follow", "bh-author-follow-nest", "ag-author-follow-sorsa-min"],
      ["ag-mod-notifications", "bh-notif-nest", "ag-notif-cooldown-min"],
    ];
    for (const [checkId, nestId, fieldId] of pairs) {
      const check = document.getElementById(checkId) as HTMLInputElement | null;
      const nest = document.getElementById(nestId);
      const field = document.getElementById(fieldId) as HTMLInputElement | null;
      const on = !!check?.checked;
      nest?.classList.toggle("is-off", !on);
      if (field) field.disabled = !on;
    }
    const continuous = document.getElementById("ag-continuous-run") as HTMLInputElement | null;
    const loopsOn = continuous?.checked === false;
    for (const id of ["ag-max-loops", "ag-session-limit"]) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.disabled = !loopsOn;
    }
  }

  document.getElementById("ag-random-author-follow")?.addEventListener("change", event => {
    if ((event.target as HTMLInputElement).checked) {
      const follow = document.getElementById("ag-act-follow") as HTMLInputElement | null;
      if (follow) follow.checked = true;
    }
    syncBehaviorNests();
  });
  document.getElementById("ag-mod-notifications")?.addEventListener("change", syncBehaviorNests);
  document.getElementById("ag-continuous-run")?.addEventListener("change", syncBehaviorNests);

  let agent: AgentPublicState | null = null;
  const sourceHandle = document.getElementById("source-own-handle") as HTMLInputElement;
  const sourceAccountMsg = document.getElementById("source-account-msg")!;
  let sourceAccountRevision = 0;
  let savedSourceAccountRevision = 0;
  sourceHandle.addEventListener("input", () => { sourceAccountRevision += 1; });
  document.getElementById("btn-source-account-save")!.addEventListener("click", async () => {
    const ownHandle = sourceHandle.value.trim().replace(/^@/, "");
    if (ownHandle && !/^[A-Za-z0-9_]{1,15}$/.test(ownHandle)) {
      sourceAccountMsg.textContent = "Username gồm 1–15 chữ, số hoặc dấu gạch dưới.";
      return;
    }
    if (!agent) await loadAgent();
    if (!agent) return;
    const revision = sourceAccountRevision;
    const res = await send("save_agent_settings", { settings: { ...agent.settings, ownHandle, skipOwnPosts: true } });
    if (res.ok && res.agent) {
      savedSourceAccountRevision = revision;
      (document.getElementById("ag-own-handle") as HTMLInputElement).value = res.agent.settings.ownHandle;
      (document.getElementById("ag-skip-own") as HTMLInputElement).checked = true;
      showAgentData(res.agent);
      sourceAccountMsg.textContent = ownHandle ? `Đã lưu @${ownHandle}. Bỏ qua bài của bạn trong Pogo và list link.` : "Đã xóa username.";
    } else sourceAccountMsg.textContent = res.error ?? "Không lưu được username.";
  });
  let stateRevision = 0;
  const rendered = new Map<string, string>();
  function changed(section: string, value: unknown): boolean {
    const key = JSON.stringify(value);
    if (rendered.get(section) === key) return false;
    rendered.set(section, key);
    return true;
  }
  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }
  let countdownTimer: number | null = null;
  let behaviorRevision = 0;
  let savedBehaviorRevision = 0;
  const markBehaviorEdited = () => { behaviorRevision += 1; };
  document.getElementById("view-behavior")!.addEventListener("input", markBehaviorEdited);
  document.getElementById("view-behavior")!.addEventListener("change", markBehaviorEdited);

  function setAgentMsg(t: string): void {
    agentMsg.textContent = t;
  }
  function setBehaviorMsg(t: string): void {
    behaviorMsg.textContent = t;
  }
  function setActivityMsg(t: string): void {
    activityMsg.textContent = t;
  }

  function el(tag: string, className?: string, text?: string): HTMLElement {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  const UI_PREF_KEY = "xContentCreator.ui.v1";

  async function loadUiPrefs(): Promise<void> {
    try {
      if (!chrome?.storage?.local) return;
      const raw = await chrome.storage.local.get(UI_PREF_KEY);
      const ui = raw[UI_PREF_KEY] as
        | { enableCreateReply?: boolean; enableSorsaBadge?: boolean }
        | undefined;
      const replyBox = document.getElementById("ag-ui-create-reply") as HTMLInputElement | null;
      if (replyBox) replyBox.checked = ui?.enableCreateReply !== false;
      const sorsaBox = document.getElementById("ag-ui-sorsa-badge") as HTMLInputElement | null;
      if (sorsaBox) sorsaBox.checked = ui?.enableSorsaBadge !== false;
    } catch {
      /* node/test env without chrome.storage */
    }
  }

  async function saveUiPrefs(): Promise<void> {
    try {
      if (!chrome?.storage?.local) return;
      const replyBox = document.getElementById("ag-ui-create-reply") as HTMLInputElement | null;
      const sorsaBox = document.getElementById("ag-ui-sorsa-badge") as HTMLInputElement | null;
      await chrome.storage.local.set({
        [UI_PREF_KEY]: {
          enableCreateReply: replyBox?.checked !== false,
          enableSorsaBadge: sorsaBox?.checked !== false,
        },
      });
    } catch {
      /* ignore */
    }
  }

  function fillBehaviorForm(settings: AgentSettings): void {
    const goals = settings.dailyTargets ?? defaultDailyTargets();
    (document.getElementById("ag-daily-enabled") as HTMLInputElement).checked = goals.enabled;
    (document.getElementById("ag-daily-after") as HTMLSelectElement).value = goals.afterReached;
    for (const kind of TARGET_KINDS.filter(k => k !== "retweet")) {
      (document.getElementById(`ag-daily-${kind}`) as HTMLInputElement).value = String(goals.ranges[kind].max);
    }
    (document.getElementById("ag-own-handle") as HTMLInputElement).value = settings.ownHandle;
    (document.getElementById("ag-delay-min") as HTMLInputElement).value = String(settings.delaySecMin);
    (document.getElementById("ag-delay-max") as HTMLInputElement).value = String(settings.delaySecMax);
    (document.getElementById("ag-speed-preset") as HTMLSelectElement).value = settings.speedPreset;
    (document.getElementById("ag-mod-pogo") as HTMLInputElement).checked = settings.modules.pogoTasks;
    (document.getElementById("ag-mod-links") as HTMLInputElement).checked = settings.modules.linkList;
    (document.getElementById("ag-mod-home") as HTMLInputElement).checked = settings.modules.homeScroll;
    (document.getElementById("ag-mod-following-feed") as HTMLInputElement).checked = settings.modules.followingFeed;
    (document.getElementById("ag-mod-lists") as HTMLInputElement).checked = settings.modules.lists;
    (document.getElementById("ag-list-url") as HTMLInputElement).value = settings.listUrlOrName ?? "";
    (document.getElementById("ag-mod-notifications") as HTMLInputElement).checked = settings.modules.notifications;
    (document.getElementById("ag-notif-cooldown-min") as HTMLInputElement).value = String(settings.notificationCooldownMin ?? 60);
    (document.getElementById("ag-mod-following") as HTMLInputElement).checked = settings.modules.following;
    {
      const sch = { ...defaultBrowseSchedule(), ...(settings.browseSchedule ?? {}) };
      (document.getElementById("ag-schedule-home-min") as HTMLInputElement).value = String(Math.round(sch.homeSec / 60));
      (document.getElementById("ag-schedule-following-min") as HTMLInputElement).value = String(Math.round(sch.followingSec / 60));
      (document.getElementById("ag-schedule-lists-min") as HTMLInputElement).value = String(Math.round(sch.listsSec / 60));
      (document.getElementById("ag-schedule-early-empty") as HTMLInputElement).checked = sch.earlySwitchOnEmpty !== false;
      (document.getElementById("ag-schedule-keep-resume") as HTMLInputElement).checked = sch.keepSourceOnResume !== false;
    }
    (document.getElementById("ag-priority") as HTMLSelectElement).value = settings.priority;
    (document.getElementById("ag-skip-own") as HTMLInputElement).checked = settings.skipOwnPosts;
    (document.getElementById("ag-execute") as HTMLInputElement).checked = settings.executeActions;
    void loadUiPrefs();
    (document.getElementById("ag-act-like") as HTMLInputElement).checked = settings.actions.like;
    (document.getElementById("ag-act-retweet") as HTMLInputElement).checked = settings.actions.retweet;
    (document.getElementById("ag-home-retweet") as HTMLInputElement).checked = settings.homeRetweet === true;
    (document.getElementById("ag-act-follow") as HTMLInputElement).checked = settings.actions.follow;
    (document.getElementById("ag-random-author-follow") as HTMLInputElement).checked = settings.randomAuthorFollow === true;
    (document.getElementById("ag-author-follow-sorsa-min") as HTMLInputElement).value = String(settings.randomAuthorFollowSorsaMin ?? 500);
    (document.getElementById("ag-act-reply") as HTMLInputElement).checked = settings.actions.reply;
    (document.getElementById("ag-act-quote") as HTMLInputElement).checked = settings.actions.quote;
    (document.getElementById("ag-like-pct") as HTMLInputElement).value = String(settings.humanize.likePct);
    (document.getElementById("ag-reply-pct") as HTMLInputElement).value = String(settings.humanize.replyPct);
    (document.getElementById("ag-follow-pct") as HTMLInputElement).value = String(settings.humanize.followPct);
    (document.getElementById("ag-list-follow-pct") as HTMLInputElement).value = String(settings.humanize.listFollowPct ?? settings.humanize.followPct);
    (document.getElementById("ag-retweet-pct") as HTMLInputElement).value = String(settings.humanize.retweetPct);
    (document.getElementById("ag-read-min") as HTMLInputElement).value = String(settings.humanize.readMsMin);
    (document.getElementById("ag-read-max") as HTMLInputElement).value = String(settings.humanize.readMsMax);
    (document.getElementById("ag-max-loops") as HTMLInputElement).value = String(settings.maxLoops);
    (document.getElementById("ag-session-limit") as HTMLInputElement).value = String(settings.sessionLimit);
    (document.getElementById("ag-continuous-run") as HTMLInputElement).checked = settings.continuousRun !== false;
    (document.getElementById("ag-adaptive-rest") as HTMLInputElement).checked = settings.adaptiveRest !== false;
    syncBehaviorNests();
  }

  function collectBehaviorForm(): AgentSettings {
    const current = agent?.settings ?? null;
    const goals = defaultDailyTargets();
    goals.enabled = (document.getElementById("ag-daily-enabled") as HTMLInputElement).checked;
    goals.afterReached = (document.getElementById("ag-daily-after") as HTMLSelectElement).value === "pause" ? "pause" : "browse";
    for (const kind of TARGET_KINDS.filter(k => k !== "retweet")) goals.ranges[kind] = {
      min: Number((document.getElementById(`ag-daily-${kind}`) as HTMLInputElement).value),
      max: Number((document.getElementById(`ag-daily-${kind}`) as HTMLInputElement).value),
    };
    return {
      dailyTargets: goals,
      homeRetweet: (document.getElementById("ag-home-retweet") as HTMLInputElement).checked,
      ownHandle: (document.getElementById("ag-own-handle") as HTMLInputElement).value,
      // Giữ giá trị cũ trong storage — UI không còn chỉnh khung giờ.
      activeHoursStart: current?.activeHoursStart ?? "00:00",
      activeHoursEnd: current?.activeHoursEnd ?? "00:00",
      delaySecMin: Number((document.getElementById("ag-delay-min") as HTMLInputElement).value),
      delaySecMax: Number((document.getElementById("ag-delay-max") as HTMLInputElement).value),
      speedPreset: (document.getElementById("ag-speed-preset") as HTMLSelectElement).value as AgentSettings["speedPreset"],
      modules: {
        pogoTasks: (document.getElementById("ag-mod-pogo") as HTMLInputElement).checked,
        linkList: (document.getElementById("ag-mod-links") as HTMLInputElement).checked,
        homeScroll: (document.getElementById("ag-mod-home") as HTMLInputElement).checked,
        followingFeed: (document.getElementById("ag-mod-following-feed") as HTMLInputElement).checked,
        lists: (document.getElementById("ag-mod-lists") as HTMLInputElement).checked,
        notifications: (document.getElementById("ag-mod-notifications") as HTMLInputElement).checked,
        following: (document.getElementById("ag-mod-following") as HTMLInputElement).checked,
      },
      notificationCooldownMin: Number((document.getElementById("ag-notif-cooldown-min") as HTMLInputElement).value),
      listUrlOrName: (document.getElementById("ag-list-url") as HTMLInputElement).value,
      browseSchedule: {
        homeSec: Math.max(1, Number((document.getElementById("ag-schedule-home-min") as HTMLInputElement).value) || 10) * 60,
        followingSec: Math.max(1, Number((document.getElementById("ag-schedule-following-min") as HTMLInputElement).value) || 10) * 60,
        listsSec: Math.max(1, Number((document.getElementById("ag-schedule-lists-min") as HTMLInputElement).value) || 5) * 60,
        earlySwitchOnEmpty: (document.getElementById("ag-schedule-early-empty") as HTMLInputElement).checked,
        keepSourceOnResume: (document.getElementById("ag-schedule-keep-resume") as HTMLInputElement).checked,
      },
      priority: (document.getElementById("ag-priority") as HTMLSelectElement).value as AgentSettings["priority"],
      skipOwnPosts: (document.getElementById("ag-skip-own") as HTMLInputElement).checked,
      executeActions: (document.getElementById("ag-execute") as HTMLInputElement).checked,
      randomAuthorFollow: (document.getElementById("ag-random-author-follow") as HTMLInputElement).checked,
      randomAuthorFollowSorsaMin: (document.getElementById("ag-author-follow-sorsa-min") as HTMLInputElement).value.trim() === ""
        ? 500 : Number((document.getElementById("ag-author-follow-sorsa-min") as HTMLInputElement).value),
      dailyQuota: current?.dailyQuota ?? {
        reply: 999,
        quote: 999,
        retweet: 999,
        follow: 999,
        like: 999,
      },
      actions: {
        like: (document.getElementById("ag-act-like") as HTMLInputElement).checked,
        retweet: (document.getElementById("ag-act-retweet") as HTMLInputElement).checked,
        follow: (document.getElementById("ag-act-follow") as HTMLInputElement).checked,
        reply: (document.getElementById("ag-act-reply") as HTMLInputElement).checked,
        quote: (document.getElementById("ag-act-quote") as HTMLInputElement).checked,
      },
      humanize: {
        likePct: Number((document.getElementById("ag-like-pct") as HTMLInputElement).value),
        replyPct: Number((document.getElementById("ag-reply-pct") as HTMLInputElement).value),
        followPct: Number((document.getElementById("ag-follow-pct") as HTMLInputElement).value),
        listFollowPct: Number((document.getElementById("ag-list-follow-pct") as HTMLInputElement).value),
        retweetPct: Number((document.getElementById("ag-retweet-pct") as HTMLInputElement).value),
        readMsMin: Number((document.getElementById("ag-read-min") as HTMLInputElement).value),
        readMsMax: Number((document.getElementById("ag-read-max") as HTMLInputElement).value),
      },
      maxLoops: Number((document.getElementById("ag-max-loops") as HTMLInputElement).value),
      continuousRun: (document.getElementById("ag-continuous-run") as HTMLInputElement).checked,
      adaptiveRest: (document.getElementById("ag-adaptive-rest") as HTMLInputElement).checked,
      sessionLimit: Number((document.getElementById("ag-session-limit") as HTMLInputElement).value),
    };
  }

  function renderActivity(state: AgentPublicState): void {
    if (!changed("activity", state.activity)) return;
    activityList.replaceChildren();
    if (!state.activity.length) {
      activityList.appendChild(el("p", "empty", "Chưa có sự kiện. Bấm Bắt đầu trên tab Agent để bắt đầu."));
      return;
    }
    for (const item of state.activity) {
      const row = el("article", `activity-item level-${item.level}`);
      const time = el("div", "activity-time", new Date(item.at).toLocaleString("vi-VN"));
      const msg = el("div", "activity-msg", item.message);
      row.appendChild(time);
      row.appendChild(msg);
      activityList.appendChild(row);
    }
  }

  function renderAgRows(root: HTMLElement, rows: [string, string, string?][]): void {
    root.replaceChildren();
    for (const [k, v, vClass] of rows) {
      const row = el("div", "ag-row");
      row.appendChild(el("span", "k", k));
      row.appendChild(el("span", vClass ? `v ${vClass}` : "v", v));
      root.appendChild(row);
    }
  }

  function renderChipRow(root: HTMLElement, label: string, chips: { text: string; on: boolean }[]): void {
    const row = el("div", "ag-row");
    row.appendChild(el("span", "k", label));
    const wrap = el("div", "ag-chips");
    if (!chips.length) {
      wrap.appendChild(el("span", "ag-chip off", "—"));
    } else {
      for (const c of chips) {
        wrap.appendChild(el("span", c.on ? "ag-chip" : "ag-chip off", c.text));
      }
    }
    row.appendChild(wrap);
    root.appendChild(row);
  }

  function renderSummary(state: AgentPublicState): void {
    const { connected, tabCount, handle, onHome, url } = state.x;
    if (!changed("summary", [state.settings, connected, tabCount, handle, onHome, url])) return;
    const s = state.settings;
    summary.replaceChildren();
    renderAgRows(summary, [
      ["Ưu tiên", priorityLabel(s.priority)],
      ["Khoảng nghỉ", `${s.delaySecMin}–${s.delaySecMax}s`],
      ["Tốc độ", { safe: "Chậm", normal: "Vừa phải", fast: "Nhanh" }[s.speedPreset]],
      ["Tài khoản", s.ownHandle ? `@${s.ownHandle}` : "Chưa đặt"],
      ["Thực thi", s.executeActions ? "Bật" : "Tắt"],
      ["Thông báo", s.modules.notifications ? `Mỗi ${s.notificationCooldownMin ?? 60} phút` : "Tắt"],
    ]);
    renderChipRow(summary, "Nguồn", [
      { text: "Pogo", on: s.modules.pogoTasks },
      { text: "Links", on: s.modules.linkList },
      { text: "Home", on: s.modules.homeScroll },
      { text: "Following", on: s.modules.followingFeed },
      { text: "Lists", on: s.modules.lists },
      { text: "Thông báo", on: s.modules.notifications },
      { text: "List Follow", on: s.modules.following },
    ]);
    renderChipRow(summary, "Hành động", [
      { text: "Like", on: s.actions.like },
      { text: "RT", on: s.actions.retweet },
      { text: "Follow", on: s.actions.follow },
      { text: "Reply", on: s.actions.reply },
      { text: "Quote", on: s.actions.quote },
    ]);

    if (xSummary) {
      const x = state.x;
      const urlShort = x.url
        ? x.url.replace(/^https?:\/\/(www\.)?(x|twitter)\.com/i, "").slice(0, 42) || "/"
        : "—";
      renderAgRows(xSummary, [
        ["Tab", x.connected ? `Có · ${x.tabCount}` : "Chưa có"],
        ["Tài khoản", x.handle ? `@${x.handle}` : "—"],
        ["Thông báo mới", typeof x.notificationCount === "number" ? String(x.notificationCount) : "Chưa đọc được số"],
      ["Trang chủ", x.onHome == null ? "—" : x.onHome ? "Có" : "Không"],
        ["URL", urlShort, "mono"],
      ]);
    }
  }

  function renderMetrics(state: AgentPublicState): void {
    const settlement = document.getElementById("src-pogo-settlement");
    if (settlement) {
      const progress = state.pogoSettlement;
      const waiting = progress?.pendingCount ? ` · ${progress.pendingCount} thao tác chờ ghi nhận` : "";
      const countdown = (at: number) => {
        const seconds = Math.max(0, Math.ceil((at - Date.now()) / 1000));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      };
      setText(settlement, progress?.nextScanAt
        ? progress.nextScanAt > Date.now() ? `Pogo đối soát sau ${countdown(progress.nextScanAt)}${waiting}`
          : `Đã đến giờ Pogo đối soát${waiting}${progress.nextCheckAt && progress.nextCheckAt > Date.now() ? ` · kiểm tra sau ${countdown(progress.nextCheckAt)}` : ""}`
        : `Chưa đọc giờ đối soát từ API${waiting}${progress?.nextCheckAt ? ` · kiểm tra dự kiến sau ${countdown(progress.nextCheckAt)}` : ""}.`);
    }
    const t = state.today;
    const a = state.settings.actions;
    const window = pogoRetweetWindow();
    const power = t.pogoRetweets;
    const rtUsed = power?.windowStart === window.windowStart ? power.used : 0;
    const rtLimit = power?.windowStart === window.windowStart ? (power.limit ?? POGO_RETWEET_LIMIT) : POGO_RETWEET_LIMIT;
    const progress = (kind: typeof TARGET_KINDS[number]) => {
      const limit = dailyTarget(state.settings, t, kind);
      return limit > 0 ? `${t[kind]}/${limit}` : String(t[kind]);
    };
    const items: [string, string, boolean][] = [
      [a.reply ? progress("reply") : "Tắt", "Reply", a.reply],
      [a.quote ? progress("quote") : "Tắt", "Quote", a.quote],
      [a.retweet ? `${rtUsed}/${rtLimit}` : "Tắt", "RT Pogo", a.retweet],
      [a.follow ? progress("follow") : "Tắt", "Follow", a.follow],
      [a.like ? progress("like") : "Tắt", "Like", a.like],
      [String(t.scrollSessions), "Cuộn trang", true],
    ];
    for (const [index, [num, lbl, on]] of items.entries()) {
      let m = metrics.children[index] as HTMLElement | undefined;
      if (!m) {
        m = el("div", "metric");
        m.append(el("span", "num"), el("span", "lbl", lbl));
        metrics.appendChild(m);
      }
      m.classList.toggle("off", !on);
      setText(m.firstElementChild as HTMLElement, num);
    }
    const time = new Date(window.nextResetAt).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });
    const synced = power?.windowStart === window.windowStart && !!power.observedAt;
    const remaining = Math.max(0, rtLimit - rtUsed);
    const fullRemaining = Math.max(0, POGO_RETWEET_LIMIT - rtUsed);
    const reducedRemaining = rtLimit > POGO_RETWEET_LIMIT ? Math.max(0, remaining - fullRemaining) : null;
    const refill = document.getElementById("ag-rt-window");
    if (refill) {
      const source = synced ? "Đã đọc API; số còn lại đã trừ các lượt tool gửi tiếp." : "Chưa đọc được retweet_power từ API; hiện chỉ đếm lượt tool.";
      setText(refill, a.retweet ? `RT Pogo: đã dùng ${rtUsed}/${rtLimit}${synced ? ` · còn ${fullRemaining} lượt đủ điểm${reducedRemaining != null ? ` + ${reducedRemaining} lượt 25% điểm` : ""}` : " lượt theo tool"} · làm mới lúc ${time} (giờ Việt Nam). ${source}` : "RT Pogo đang tắt.");
    }
    paintSourcesRtChip({ retweetOn: a.retweet, rtUsed, remaining, fullRemaining, reducedRemaining, rtLimit, synced, refillAt: time });
  }

  function paintSourcesRtChip(input: {
    retweetOn: boolean;
    rtUsed: number;
    remaining: number;
    fullRemaining: number;
    reducedRemaining: number | null;
    rtLimit: number;
    synced: boolean;
    refillAt: string;
  }): void {
    const chip = document.getElementById("src-rt-power");
    if (!chip) return;
    chip.classList.remove("ok", "open", "stale");
    if (!input.retweetOn) {
      setText(chip, "RW tắt");
      chip.classList.add("stale");
      chip.title = "RT Pogo đang tắt ở tab Hành vi.";
      return;
    }
    if (!input.synced) {
      setText(chip, "RW chờ số từ API");
      chip.classList.add("open");
      chip.title = `Chưa có retweet_power từ API · tool đã dùng ${input.rtUsed}/${input.rtLimit} · refill ${input.refillAt}. Lưu Bearer rồi Quét.`;
      return;
    }
    setText(chip, input.reducedRemaining != null
      ? `RW ${input.fullRemaining} đủ điểm · ${input.reducedRemaining} lượt 25%`
      : `RW còn ${input.fullRemaining}/10 đủ điểm`);
    chip.classList.add(input.remaining > 0 ? "ok" : "stale");
    chip.title = `Đã đọc API · đã dùng ${input.rtUsed}/${input.rtLimit} · còn tổng ${input.remaining} lượt nhận thưởng · refill ${input.refillAt} (giờ VN).`;
  }

  function paintLiveDot(state: AgentPublicState): void {
    if (!liveDot) return;
    if (!changed("liveDot", [state.runtime.killSwitch, state.runtime.status, state.runtime.consecutiveErrors])) return;
    const tone = state.runtime.killSwitch ? "kill"
      : state.runtime.status === "running" || state.runtime.status === "waiting" ? "on"
        : state.runtime.status === "error" || (state.runtime.consecutiveErrors || 0) >= 3 ? "warn" : "";
    for (const name of ["on", "kill", "warn"]) liveDot.classList.toggle(name, tone === name);
  }

  function updateCountdown(state: AgentPublicState): void {
    if (countdownTimer != null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    const paintDetail = () => {
      if (!agent) return;
      renderMetrics(agent);
      const rest = agent.runtime.adaptiveRest;
      const resting = agent.runtime.status === "waiting" && !!rest?.resumeAt && rest.resumeAt > Date.now();
      statusTitle.textContent = resting ? "Đang nghỉ" : statusLabel(agent.runtime.status);
      const restInfo = document.getElementById("agent-rest-info");
      if (restInfo) {
        restInfo.hidden = !resting;
        if (resting) restInfo.textContent = `Adaptive Rest · ${restReasonLabel(rest!.reason)} · tự tiếp tục · quản lý phiên vẫn hoạt động`;
      }
      setText(statusDetail, agent.runtime.detail === "Sẵn sàng — cấu hình AI + Tasks rồi bấm Start."
        ? "Chọn cấu hình AI và nguồn công việc rồi bấm Bắt đầu."
        : agent.runtime.detail || "—");
      if (statusNext) {
        if (agent.runtime.nextActionAt != null && (agent.runtime.status === "waiting" || agent.runtime.status === "running")) {
          const left = Math.max(0, Math.ceil((agent.runtime.nextActionAt - Date.now()) / 1000));
          setText(statusNext, resting ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} · tự tiếp tục` : `~${left}s`);
        } else {
          setText(statusNext, "—");
        }
      }
    };
    paintDetail();
    if (state.runtime.status === "waiting" || state.runtime.status === "running" || state.today.pogoRetweets?.observedAt || state.pogoSettlement?.nextScanAt || state.pogoSettlement?.pendingCount) {
      countdownTimer = window.setInterval(paintDetail, 1000);
    }
  }

  function jobKindLabel(kind: string): string {
    switch (kind) {
      case "scroll_home":
        return "Cuộn trang";
      case "like":
        return "Like";
      case "retweet":
        return "RT";
      case "follow":
        return "Follow";
      case "draft_reply":
        return "Soạn reply";
      case "post_reply":
        return "Reply";
      case "draft_quote":
        return "Soạn quote";
      case "post_quote":
        return "Quote";
      default:
        return kind;
    }
  }

  function jobStatusLabel(status: string): string {
    switch (status) {
      case "running":
        return "đang làm";
      case "pending":
        return "chờ";
      case "done":
        return "xong";
      case "failed":
        return "lỗi";
      case "skipped":
        return "bỏ";
      default:
        return status;
    }
  }

  function jobStatusClass(status: string): string {
    if (status === "running") return "run";
    if (status === "pending") return "wait";
    if (status === "done") return "ok";
    if (status === "failed") return "err";
    if (status === "skipped") return "skip";
    return "";
  }

  function renderJobRow(j: AgentPublicState["recentJobs"][number]): HTMLElement {
    const row = el("article", `ag-q-row ${jobStatusClass(j.status)}`);
    const top = el("div", "ag-q-top");
    top.appendChild(el("span", "ag-q-kind", jobKindLabel(j.kind)));
    top.appendChild(
      el("span", "ag-q-who", j.authorHandle ? `@${j.authorHandle}` : j.kind === "scroll_home"
        ? ({ home: "Home", following: "Following", lists: "Lists", mentions: "Thông báo" }[j.browseSurface || "home"]) : "—"),
    );
    const resultLabel = j.status === "done" && ["post_reply", "post_quote", "retweet"].includes(j.kind) ? "Đã gửi"
      : jobStatusLabel(j.status);
    top.appendChild(el("span", `ag-q-st ${jobStatusClass(j.status)}`, resultLabel));
    row.appendChild(top);

    const detailBits: string[] = [];
    detailBits.push(j.source === "pogo" ? "Pogo" : j.source === "browse" ? ({ home: "Home", following: "Following", lists: "Lists", mentions: "Mentions" }[j.browseSurface || "home"]) : "Danh sách link");
    if (j.pogoUnlock) detailBits.push(`Mở khóa ${j.pogoUnlock.attempts}/3 · ${j.pogoUnlock.state === "unlocked" ? "đã mở" : j.pogoUnlock.state === "exhausted" ? "đã dừng chờ" : "đang chờ"}`);
    if (j.error) detailBits.push(j.error);
    else if (j.draftText) {
      const d = j.draftText.replace(/\s+/g, " ").trim();
      detailBits.push(d.length > 72 ? `${d.slice(0, 72)}…` : d);
    } else if (j.tweetId) {
      detailBits.push(`#${j.tweetId.slice(-6)}`);
    }
    if (j.reason) detailBits.push(j.reason);
    detailBits.push(new Date(j.updatedAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    row.appendChild(el("div", "ag-q-meta", detailBits.join(" · ")));
    return row;
  }

  function renderJobSection(title: string, jobs: AgentPublicState["recentJobs"], emptyText: string): HTMLElement {
    const sec = el("div", "ag-q-sec");
    const head = el("div", "ag-q-sec-h");
    head.appendChild(el("span", undefined, title));
    head.appendChild(el("span", "ag-q-count", String(jobs.length)));
    sec.appendChild(head);
    if (!jobs.length) {
      sec.appendChild(el("p", "ag-q-empty", emptyText));
    } else {
      for (const j of jobs) sec.appendChild(renderJobRow(j));
    }
    return sec;
  }

  function renderJobs(state: AgentPublicState): void {
    if (!jobList) return;
    if (!changed("jobs", state.recentJobs)) return;
    jobList.replaceChildren();
    const jobs = state.recentJobs;
    if (!jobs.length) {
      jobList.appendChild(el("p", "empty", "Chưa có việc. Chọn cấu hình trong tab Hành vi, lưu rồi bắt đầu."));
      return;
    }
    const noiseSkip = (j: AgentPublicState["recentJobs"][number]) =>
      j.status === "skipped" &&
      (j.error === "action_disabled" ||
        j.error === "like_not_a_task" ||
        j.error === "reply_already_recorded" ||
        j.error === "already_replied" ||
        j.error === "follow_done_skip_rest" ||
        (j.error ?? "").startsWith("draft_unavailable"));
    const now = jobs.filter((j) => j.status === "running" && !noiseSkip(j));
    const recent = jobs
      .filter(
        (j) =>
          (j.status === "done" || j.status === "failed" || j.status === "skipped") &&
          !noiseSkip(j),
      )
      .slice(0, 10);
    jobList.appendChild(renderJobSection("Đang làm", now, "Chưa có việc đang chạy"));
    jobList.appendChild(renderJobSection("Gần đây", recent, "Chưa có việc xong"));
  }

  function showAgentData(next: AgentPublicState): void {
    if (sourceAccountRevision === savedSourceAccountRevision) sourceHandle.value = next.settings.ownHandle;
    stateRevision++;
    agent = next;
    statusTitle.textContent = statusLabel(next.runtime.status);
    const kicker = document.getElementById("agent-status-kicker");
    if (kicker) {
      kicker.textContent = next.runtime.mockMode
        ? "Chờ kết nối · Bắt đầu để mở trang chủ X"
        : next.x.handle
          ? `Đã kết nối · @${next.x.handle}`
          : "Đã kết nối X";
    }
    const pills: [string, string][] = [
      [next.runtime.mockMode ? "Chờ X" : "Đã kết nối", next.runtime.mockMode ? "warn" : "live"],
      [next.x.connected ? (next.x.handle ? `@${next.x.handle}` : "Kết nối X") : "Chưa có X", next.x.connected ? "ok" : "warn"],
      [next.settings.continuousRun !== false ? `24/24 · ${next.runtime.loopCount} vòng` : `${next.runtime.loopCount} vòng`, ""],
      ...(next.runtime.killSwitch ? [["Dừng khẩn đang bật", "danger"] as [string, string]] : []),
    ];
    if ((next.runtime.consecutiveErrors || 0) >= 3) {
      pills.push([`${next.runtime.consecutiveErrors} lỗi liên tiếp`, "danger"]);
    }
    for (const [index, [text, tone]] of pills.entries()) {
      let pill = statusMeta.children[index] as HTMLElement | undefined;
      if (!pill) { pill = el("span"); statusMeta.appendChild(pill); }
      const className = tone ? `pill ${tone}` : "pill";
      if (pill.className !== className) pill.className = className;
      setText(pill, text);
    }
    while (statusMeta.children.length > pills.length) statusMeta.lastElementChild!.remove();
    killBtn.textContent = next.runtime.killSwitch ? "Bỏ dừng khẩn" : "Dừng khẩn";
    killBtn.classList.toggle("danger", !next.runtime.killSwitch);
    killBtn.classList.toggle("accent", next.runtime.killSwitch);
    killBtn.classList.add("ghost");

    // Start ẩn khi đang chạy; Pause chỉ hiện khi running/waiting.
    const active = next.runtime.status === "running" || next.runtime.status === "waiting";
    startBtn.hidden = active;
    startBtn.classList.toggle("hidden", active);
    pauseBtn.hidden = !active;
    pauseBtn.classList.toggle("hidden", !active);

    paintLiveDot(next);
    renderMetrics(next);
    renderSummary(next);
    renderJobs(next);
    renderActivity(next);
    if (behaviorRevision === savedBehaviorRevision) fillBehaviorForm(next.settings);
    updateCountdown(next);
  }

  async function loadAgent(): Promise<void> {
    const revision = stateRevision;
    const res = await send("get_agent_state");
    // A state pushed while this request was in flight is already more recent.
    if (revision !== stateRevision) return;
    if (res.ok && res.agent) {
      showAgentData(res.agent);
      setAgentMsg("");
    } else {
      setAgentMsg(res.error ?? "Không tải agent state.");
    }
  }

  function onViewEnter(view: string): void {
    if (view === "agent" || view === "behavior" || view === "activity" || view === "tasks") {
      void loadAgent();
    }
  }

  startBtn.addEventListener("click", async () => {
    setAgentMsg("Đang mở trang chủ X và bắt đầu…");
    const res = await send("agent_start");
    if (res.ok && res.agent) {
      showAgentData(res.agent);
      setAgentMsg(
        res.agent.x.connected
          ? "Đã bắt đầu trên trang chủ X."
          : "Đã bắt đầu — đang chờ tab X kết nối (F5 trang X nếu cần).",
      );
    } else setAgentMsg(res.error ?? "Không bắt đầu được phiên.");
  });

  pauseBtn.addEventListener("click", async () => {
    const res = await send("agent_pause");
    if (res.ok && res.agent) {
      showAgentData(res.agent);
      setAgentMsg("Đã tạm dừng.");
    }
  });

  killBtn.addEventListener("click", async () => {
    const on = !(agent?.runtime.killSwitch);
    const res = await send("agent_kill_switch", { on });
    if (res.ok && res.agent) {
      showAgentData(res.agent);
      setAgentMsg(on ? "Đã bật dừng khẩn." : "Đã tắt dừng khẩn.");
    }
  });

  document.getElementById("btn-agent-tick")!.addEventListener("click", async () => {
    const res = await send("agent_tick");
    if (res.ok && res.agent) {
      showAgentData(res.agent);
      setAgentMsg("Đã chạy một bước.");
    }
  });

  document.getElementById("btn-open-x")!.addEventListener("click", async () => {
    setAgentMsg("Đang mở X Home…");
    const res = await send("open_x_home");
    if (res.agent) showAgentData(res.agent);
    if (res.ok && res.agent?.x.connected) {
      setAgentMsg("Đã kết nối tab X. Bấm Cuộn thử ngay.");
    } else if (res.ok) {
      setAgentMsg("Đã mở X — nếu Tab X vẫn “Chưa”, reload trang X rồi bấm lại.");
    } else {
      setAgentMsg(res.error ?? "Không mở được X.");
    }
  });

  document.getElementById("btn-force-scroll")!.addEventListener("click", async () => {
    setAgentMsg("Đang cuộn thử…");
    const res = await send("agent_force_scroll");
    if (res.agent) showAgentData(res.agent);
    if (res.ok) setAgentMsg("Đã gửi lệnh cuộn — nhìn tab X xem timeline có nhảy không.");
    else if (res.error === "no_x_tab") setAgentMsg("Chưa có tab X. Bấm Mở X Home trước.");
    else setAgentMsg(`Cuộn thử lỗi: ${res.error ?? "unknown"}`);
  });

  document.getElementById("btn-agent-reset-stats")!.addEventListener("click", async () => {
    const res = await send("agent_reset_stats");
    if (res.ok && res.agent) {
      showAgentData(res.agent);
      setAgentMsg("Đã reset thống kê ngày.");
    }
  });

  document.getElementById("ag-continuous-run")!.addEventListener("change", () => {
    const continuous = (document.getElementById("ag-continuous-run") as HTMLInputElement).checked;
    for (const id of ["ag-max-loops", "ag-session-limit"]) (document.getElementById(id) as HTMLInputElement).disabled = continuous;
  });

  document.getElementById("btn-behavior-save")!.addEventListener("click", async () => {
    const savingRevision = behaviorRevision;
    await saveUiPrefs();
    const res = await send("save_agent_settings", { settings: collectBehaviorForm() });
    if (res.ok && res.agent) {
      savedBehaviorRevision = savingRevision;
      showAgentData(res.agent);
      setBehaviorMsg("Đã lưu cấu hình hành vi.");
    } else setBehaviorMsg(res.error ?? "Không lưu được.");
  });

  document.getElementById("ag-speed-preset")!.addEventListener("change", async (event) => {
    event.stopPropagation();
    markBehaviorEdited();
    const presetRevision = behaviorRevision;
    const preset = (document.getElementById("ag-speed-preset") as HTMLSelectElement).value;
    const res = await send("apply_agent_speed_preset", { preset });
    if (res.ok && res.agent) {
      // Selecting a preset intentionally replaces the form if it has not since changed.
      if (behaviorRevision === presetRevision) savedBehaviorRevision = behaviorRevision;
      showAgentData(res.agent);
      setBehaviorMsg(`Đã áp preset ${preset}.`);
    }
  });

  document.getElementById("btn-activity-refresh")!.addEventListener("click", () => {
    void loadAgent().then(() => setActivityMsg("Đã làm mới."));
  });

  document.getElementById("btn-activity-clear")!.addEventListener("click", async () => {
    const res = await send("agent_clear_activity");
    if (res.ok && res.agent) {
      showAgentData(res.agent);
      setActivityMsg("Đã xóa nhật ký.");
    }
  });

  document.getElementById("btn-clear-queue")?.addEventListener("click", async () => {
    const res = await send("agent_clear_queue");
    if (res.ok && res.agent) {
      showAgentData(res.agent);
      setAgentMsg("Đã xóa hàng đợi.");
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && typeof msg === "object" && msg.type === "agent_state" && msg.agent) {
      showAgentData(msg.agent as AgentPublicState);
    }
  });

  return { showAgentData, loadAgent, onViewEnter };
}
