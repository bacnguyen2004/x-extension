/**
 * Meta từ GET /api/feed: retweet_power + polling (đối soát).
 * Dữ liệu đọc trực tiếp từ phản hồi API.
 */

export type ApiRetweetPower = {
  used: number;
  full: number;
  reduced: number;
  /** Lượt đủ điểm còn lại (0..full). */
  remaining: number;
  /** Tổng lượt còn thưởng full+reduced (0..full+reduced). */
  earningRemaining: number;
};

function intField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return null;
}

/** Map retweet_power API → remaining / earningRemaining cho ledger hiện tại. */
export function extractRetweetPower(body: unknown): ApiRetweetPower | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).retweet_power;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const used = intField(o.used);
  if (used == null || used < 0) return null;
  const full = intField(o.full) ?? 10;
  const reduced = intField(o.reduced) ?? 10;
  if (full < 0 || full > 20 || reduced < 0 || reduced > 20) return null;
  const earningRemaining = Math.max(0, full + reduced - used);
  const remaining = used >= full ? 0 : full - used;
  // Ledger observe yêu cầu max(0, earning − 10) === remaining khi full band = 10.
  // Với full ≠ 10 vẫn trả remaining/earning nhất quán theo API.
  return { used, full, reduced, remaining, earningRemaining };
}

/**
 * nextScanAt = last_swept_at + n * interval, chọn mốc gần nhất trong cửa sổ
 * mà observePogoSettlementClock chấp nhận (−60s … +11 phút).
 */
export function extractPollingNextScanAt(body: unknown, now = Date.now()): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).polling;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const last = typeof o.last_swept_at === "string" ? Date.parse(o.last_swept_at) : NaN;
  if (!Number.isFinite(last)) return null;
  const intervalSec = intField(o.interval_seconds) ?? 600;
  if (intervalSec < 30 || intervalSec > 3600) return null;
  const intervalMs = intervalSec * 1000;
  let next = last + intervalMs;
  // Đẩy tới chu kỳ còn hợp lệ nếu feed cũ.
  while (next < now - 60_000) next += intervalMs;
  if (next > now + 660_000) return null;
  return next;
}
