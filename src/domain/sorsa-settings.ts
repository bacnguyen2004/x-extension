/**
 * Helpers hiển thị Sorsa Score (badge trên timeline X).
 * Điểm lấy public: GET https://api.sorsa.io/v1/accounts/search?query=&type=twitter
 */

/** Ngưỡng màu giống UX X68 (low / medium / high). */
export function sorsaTier(score: number): "low" | "medium" | "high" {
  if (score < 200) return "low";
  if (score < 600) return "medium";
  return "high";
}

export function formatSorsaScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  const n = Math.round(score * 10) / 10;
  if (n >= 1000) {
    const k = n / 1000;
    const t = k >= 10 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "");
    return `${t}k`;
  }
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1).replace(/\.0$/, "");
}
