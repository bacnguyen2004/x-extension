import { usageDay, usageEndpoint, priceKey, readTokenUsage, type AiUsageKind, type UsageData, type AiPrice } from "../domain/ai-usage.ts";
const KEY = "xContentCreator.aiUsage.v1";
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn); tail = result.catch(() => {}); return result;
}
async function load(): Promise<UsageData> {
  const raw = (await chrome.storage.local.get(KEY))[KEY] as UsageData | undefined;
  return raw && Array.isArray(raw.buckets) && raw.prices ? raw : { startedAt: Date.now(), buckets: [], prices: {} };
}
export function getAiUsage(): Promise<UsageData> { return serial(load); }
export function recordAiUsage(baseUrl: string, model: string, kind: AiUsageKind, body: unknown): Promise<void> {
  // Tracking must never turn a successful generation into a retry or duplicate post.
  if (typeof chrome === "undefined" || !chrome.storage?.local) return Promise.resolve();
  return serial(async () => {
    const data = await load(), day = usageDay(), endpoint = usageEndpoint(baseUrl);
    let bucket = data.buckets.find(b => b.day === day && b.endpoint === endpoint && b.model === model && b.kind === kind);
    if (!bucket) { bucket = { day, endpoint, model, kind, calls: 0, unknown: 0, input: 0, cached: 0, output: 0 }; data.buckets.push(bucket); }
    bucket.calls++;
    const tokens = readTokenUsage(body);
    if (tokens) { bucket.input += tokens.input; bucket.cached += tokens.cached; bucket.output += tokens.output; }
    else bucket.unknown++;
    await chrome.storage.local.set({ [KEY]: data });
  }).catch(() => {});
}
export function saveAiPrices(raw: unknown): Promise<UsageData> {
  return serial(async () => {
    if (!Array.isArray(raw) || raw.length > 100) throw new Error("Danh sách đơn giá không hợp lệ.");
    const patch: Record<string, AiPrice | null> = {};
    for (const row of raw) {
      if (!row || typeof row.endpoint !== "string" || typeof row.model !== "string" || !row.model.trim() || row.model.length > 200) throw new Error("Model không hợp lệ.");
      const key = priceKey(usageEndpoint(row.endpoint), row.model.trim());
      if (row.price === null) { patch[key] = null; continue; }
      const price = row.price;
      if (!price || ![price.input, price.cached, price.output].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e6)) throw new Error("Đơn giá phải là số không âm (USD / 1 triệu token).");
      patch[key] = { input: price.input, cached: price.cached, output: price.output };
    }
    const data = await load();
    for (const [key, price] of Object.entries(patch)) { if (price) data.prices[key] = price; else delete data.prices[key]; }
    await chrome.storage.local.set({ [KEY]: data });
    return data;
  });
}
