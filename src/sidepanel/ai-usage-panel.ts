import { priceKey, summarizeUsage, usageCost, usageEndpoint, type UsageData, type AiUsageKind } from "../domain/ai-usage.ts";
import type { AiSettingsPublic } from "../domain/ai-settings.ts";
export function initAiUsagePanel(send: (type: string, extra?: Record<string, unknown>) => Promise<any>) {
  const root = document.getElementById("ai-usage");
  let data: UsageData | null = null;
  let models: Array<{ endpoint: string; model: string }> = [];
  const summary = document.getElementById("ai-usage-summary")!;
  const details = document.getElementById("ai-usage-details")!;
  const prices = document.getElementById("ai-usage-prices")!;
  const msg = document.getElementById("ai-usage-msg")!;
  const period = document.getElementById("ai-usage-period") as HTMLSelectElement;
  const labels: Record<AiUsageKind, string> = { reply: "Pogo", browse_reply: "News Feed / ✨", mention_reply: "Mentions", quote: "Quote", post: "Post", other: "Khác" };
  const money = (value: number) => `$${value.toFixed(6)}`;
  const text = (tag: string, content: string) => { const el = document.createElement(tag); el.textContent = content; return el; };
  function renderSummary() {
    if (!data) return;
    const s = summarizeUsage(data, period.value as "today" | "month" | "all");
    const partial = s.unknown > 0 || s.unpriced > 0;
    summary.replaceChildren(text("strong", `${money(s.cost)}${partial ? " · chưa đầy đủ" : " · ước tính"}`),
      text("p", `${s.calls.toLocaleString("vi-VN")} lần gọi · ${s.input.toLocaleString("vi-VN")} token vào (${s.cached.toLocaleString("vi-VN")} cache) · ${s.output.toLocaleString("vi-VN")} token ra`),
      text("p", `${s.unpriced} lượt chưa có đơn giá · ${s.unknown} lượt chưa rõ usage. Ngày tính theo giờ Việt Nam.`));
    details.replaceChildren();
    const groups = new Map<string, { label: string; calls: number; input: number; output: number; cached: number; cost: number; incomplete: boolean }>();
    for (const row of s.rows) {
      const key = JSON.stringify([row.endpoint, row.model, row.kind]);
      let group = groups.get(key);
      if (!group) { group = { label: `${labels[row.kind] || "Khác"} · ${row.model} · ${row.endpoint}`, calls: 0, input: 0, output: 0, cached: 0, cost: 0, incomplete: false }; groups.set(key, group); }
      const cost = usageCost(row, data.prices[priceKey(row.endpoint, row.model)]);
      group.calls += row.calls; group.input += row.input; group.output += row.output; group.cached += row.cached; group.cost += cost || 0;
      group.incomplete ||= row.unknown > 0 || (cost === null && row.calls > row.unknown);
    }
    for (const group of groups.values()) {
      const item = document.createElement("div"); item.className = "ai-usage-item";
      item.append(text("strong", group.label), text("p", `${group.calls} API requests · ${group.input.toLocaleString("vi-VN")} input · ${group.output.toLocaleString("vi-VN")} output · ${group.cached.toLocaleString("vi-VN")} cached tokens · ${money(group.cost)}${group.incomplete ? " (chưa đầy đủ)" : ""}`)); details.append(item);
    }
    if (!groups.size) details.append(text("p", "Chưa có lượt gọi AI trong khoảng này."));
  }
  function renderPrices() {
    prices.replaceChildren();
    for (const model of models) {
      const row = document.createElement("fieldset"); row.className = "ai-price-row";
      row.dataset.endpoint = model.endpoint; row.dataset.model = model.model;
      row.append(text("legend", `${model.model} · ${model.endpoint}`));
      const price = data?.prices[priceKey(model.endpoint, model.model)];
      for (const [key, label] of [["input", "Đầu vào"], ["cached", "Đầu vào cache"], ["output", "Đầu ra"]] as const) {
        const field = document.createElement("label"); field.className = "field"; field.append(text("span", label));
        const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.max = "1000000"; input.step = "any"; input.dataset.rate = key;
        input.placeholder = "Chưa đặt giá"; input.value = price ? String(price[key]) : ""; field.append(input); row.append(field);
      }
      prices.append(row);
    }
  }
  async function load() {
    if (!root) return;
    try {
      const [usage, config] = await Promise.all([send("get_ai_usage"), send("get_ai_settings")]);
      if (!usage.ok || !usage.usage) throw new Error(usage.error || "Chưa đọc được chi phí.");
      data = usage.usage;
      const unique = new Map<string, { endpoint: string; model: string }>();
      for (const bucket of data!.buckets) unique.set(priceKey(bucket.endpoint, bucket.model), { endpoint: bucket.endpoint, model: bucket.model });
      const settings = config.settings as AiSettingsPublic | undefined;
      if (settings) for (const model of [settings.model, settings.reply.model, settings.browseReply.model, settings.mentionReply.model]) {
        if (model?.trim()) { const endpoint = usageEndpoint(settings.baseUrl); unique.set(priceKey(endpoint, model.trim()), { endpoint, model: model.trim() }); }
      }
      models = [...unique.values()]; renderSummary(); renderPrices();
      msg.textContent = `Bắt đầu ghi nhận: ${new Date(data!.startedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}.`;
    } catch (error) { msg.textContent = error instanceof Error ? error.message : "Không tải được chi phí."; }
  }
  document.getElementById("btn-ai-usage-refresh")?.addEventListener("click", () => { void load(); });
  period?.addEventListener("change", renderSummary);
  const save = document.getElementById("btn-ai-prices-save") as HTMLButtonElement;
  save?.addEventListener("click", async () => {
    const patch = [];
    for (const row of prices.querySelectorAll<HTMLElement>(".ai-price-row")) {
      const values = [...row.querySelectorAll<HTMLInputElement>("input")].map(input => input.value.trim());
      if (values.some(Boolean) && (!values.every(Boolean) || values.some(v => !Number.isFinite(Number(v)) || Number(v) < 0))) { msg.textContent = "Nhập đủ ba đơn giá không âm, hoặc để trống cả ba. Giá cache bằng giá đầu vào nếu không có giá riêng."; return; }
      patch.push({ endpoint: row.dataset.endpoint, model: row.dataset.model, price: values.every(v => v === "") ? null : { input: Number(values[0]), cached: Number(values[1]), output: Number(values[2]) } });
    }
    save.disabled = true;
    try { const result = await send("save_ai_prices", { prices: patch }); if (!result.ok) throw new Error(result.error || "Không lưu được đơn giá."); data = result.usage; renderSummary(); msg.textContent = "Đã lưu đơn giá. Toàn bộ thống kê được tính lại theo bảng giá này."; }
    catch (error) { msg.textContent = error instanceof Error ? error.message : "Không lưu được đơn giá."; }
    finally { save.disabled = false; }
  });
  return { load };
}
