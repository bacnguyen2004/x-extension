export type AiUsageKind = "reply" | "browse_reply" | "mention_reply" | "quote" | "post" | "other";
export interface TokenUsage { input: number; cached: number; output: number }
export interface AiPrice { input: number; cached: number; output: number }
export interface UsageBucket extends TokenUsage { day: string; endpoint: string; model: string; kind: AiUsageKind; calls: number; unknown: number }
export interface UsageData { startedAt: number; buckets: UsageBucket[]; prices: Record<string, AiPrice> }
export function usageDay(at = Date.now()): string { return new Date(at + 7 * 3600000).toISOString().slice(0, 10); }
export function usageEndpoint(url: string): string {
  try { const u = new URL(url); return (u.origin + u.pathname).replace(/\/+$/, ""); } catch { return "custom"; }
}
export function priceKey(endpoint: string, model: string): string { return JSON.stringify([endpoint, model]); }
export function readTokenUsage(body: unknown): TokenUsage | null {
  const u = (body as any)?.usage;
  const valid = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!u || !valid(u.prompt_tokens) || !valid(u.completion_tokens)) return null;
  return { input: u.prompt_tokens, output: u.completion_tokens,
    cached: valid(u.prompt_tokens_details?.cached_tokens) ? Math.min(u.prompt_tokens, u.prompt_tokens_details.cached_tokens) : 0 };
}
export function usageCost(tokens: TokenUsage, price?: AiPrice): number | null {
  return price ? ((tokens.input - tokens.cached) * price.input + tokens.cached * price.cached + tokens.output * price.output) / 1e6 : null;
}
export function summarizeUsage(data: UsageData, period: "today" | "month" | "all", at = Date.now()) {
  const today = usageDay(at);
  const rows = data.buckets.filter(b => period === "all" || (period === "today" ? b.day === today : b.day.slice(0, 7) === today.slice(0, 7)));
  let cost = 0, calls = 0, unknown = 0, unpriced = 0, input = 0, cached = 0, output = 0;
  for (const row of rows) {
    const amount = usageCost(row, data.prices[priceKey(row.endpoint, row.model)]);
    calls += row.calls; unknown += row.unknown; input += row.input; cached += row.cached; output += row.output;
    if (amount === null) unpriced += row.calls - row.unknown; else cost += amount;
  }
  return { cost, calls, unknown, unpriced, input, cached, output, rows };
}
