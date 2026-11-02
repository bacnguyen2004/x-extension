import type { FollowHistoryEntry } from "../domain/follow-history.ts";

export function renderFollowHistory(container: HTMLElement, entries: FollowHistoryEntry[]): void {
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "fh-empty";
    empty.innerHTML = "<strong>Chưa có tài khoản phù hợp</strong><span>Danh sách tự bổ sung khi follow hoặc khi X hiện Following.</span>";
    container.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "fh-row";
    const top = document.createElement("div");
    top.className = "fh-row-top";
    const link = document.createElement("a");
    link.href = `https://x.com/${encodeURIComponent(entry.handle)}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `@${entry.handle}`;
    const status = document.createElement("span");
    status.className = entry.status === "requested" ? "fh-badge fh-badge-open" : "fh-badge";
    status.textContent = entry.status === "requested" ? "Đã gửi yêu cầu" : "Following";
    top.append(link, status);
    const meta = document.createElement("div");
    meta.className = "fh-meta";
    meta.textContent = [entry.verified === null ? "Tick: chưa rõ" : entry.verified ? "Có tick" : "Không tick",
      entry.sorsa === null ? "Sorsa: chưa có dữ liệu" : `Sorsa: ${entry.sorsa}`,
      entry.followsYou === null ? "Follow back: chưa rõ" : entry.followsYou ? "Có follow back" : "Chưa follow back"].join(" · ");
    const date = document.createElement("div");
    date.className = "fh-meta";
    date.textContent = entry.updatedAt ? `Ghi nhận: ${new Date(entry.updatedAt).toLocaleString("vi-VN")}` : "Dữ liệu từ danh sách cũ";
    row.append(top, meta, date);
    container.append(row);
  }
}

export function followHistoryCsv(entries: FollowHistoryEntry[]): string {
  const rows = [["Username", "Trạng thái", "Tick", "Sorsa", "Follow back", "Ghi nhận"], ...entries.map(entry => [
    entry.handle, entry.status === "requested" ? "Requested" : "Following",
    entry.verified === null ? "Unknown" : entry.verified ? "Yes" : "No", entry.sorsa ?? "",
    entry.followsYou === null ? "Unknown" : entry.followsYou ? "Yes" : "No",
    entry.updatedAt ? new Date(entry.updatedAt).toISOString() : "",
  ])];
  return "\uFEFF" + rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

export function initFollowHistoryPanel(send: (type: string) => Promise<{ ok: boolean; account?: string; connectedAccount?: boolean; entries?: FollowHistoryEntry[]; error?: string }>): { onViewEnter: (view: string) => void } {
  const list = document.getElementById("fh-list");
  if (!list) return { onViewEnter() {} };
  const search = document.getElementById("fh-search") as HTMLInputElement;
  const filter = document.getElementById("fh-filter") as HTMLSelectElement;
  const count = document.getElementById("fh-count")!;
  const message = document.getElementById("fh-msg")!;
  let entries: FollowHistoryEntry[] = [];
  let active = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function filtered(): FollowHistoryEntry[] {
    const query = search.value.replace(/^@/, "").trim().toLowerCase();
    return entries.filter(entry => entry.handle.includes(query) && (filter.value === "back" ? entry.followsYou === true
      : filter.value === "no-back" ? entry.followsYou === false : filter.value === "verified" ? entry.verified === true : true));
  }
  function paint(): void {
    const visible = filtered();
    count.textContent = `${visible.length} / ${entries.length} tài khoản`;
    renderFollowHistory(list!, visible);
  }
  async function refresh(): Promise<void> {
    const request = ++revision;
    message.textContent = "Đang đọc danh sách…";
    try {
      const result = await send("get_follow_history");
      if (request !== revision) return;
      if (!result.ok) { message.textContent = result.error || "Không đọc được danh sách."; return; }
      entries = result.entries ?? [];
      message.textContent = result.account ? `${result.connectedAccount === false ? "Danh sách đã lưu của" : "Tài khoản X:"} @${result.account}. Khi tool gặp người đã Following, người đó tự được thêm vào đây.` : "Chưa nhận diện được tài khoản X. Mở tab X đã đăng nhập để tool tự ghi nhận người đã Following.";
      paint();
    } catch { if (request === revision) message.textContent = "Không kết nối được extension."; }
  }
  search.addEventListener("input", paint);
  filter.addEventListener("change", paint);
  document.getElementById("fh-refresh")!.addEventListener("click", () => { void refresh(); });
  document.getElementById("fh-export")!.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([followHistoryCsv(filtered())], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "following.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (!active || area !== "local" || !Object.keys(changes).some(key => key.startsWith("xContentCreator.followHistory.v1.") || key === "xContentCreator.sorsaCache.v1")) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void refresh(); }, 300);
  });
  return { onViewEnter(view) { active = view === "follow"; if (active) void refresh(); } };
}
