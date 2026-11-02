/**
 * POST https://pogo.social/api/me/follow-check
 * Body rỗng (content-length: 0) — chỉ Bearer. Tương đương nút "I followed. Check now".
 */

export const POGO_FOLLOW_CHECK_URL = "https://pogo.social/api/me/follow-check";

export type FollowCheckResult =
  | {
      ok: true;
      httpStatus: number;
      checked: boolean;
      targetFollowed: boolean | null;
      unlockedCount: number;
      awardedCount: number;
      awardedPoints: number;
      unlockedPoints: number;
    }
  | {
      ok: false;
      httpStatus: number | null;
      error: string;
      login_required: boolean;
    };

function asBoolOrNull(v: unknown): boolean | null {
  if (v === true) return true;
  if (v === false) return false;
  return null;
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function postPogoFollowCheck(token: string): Promise<FollowCheckResult> {
  const auth = token.trim();
  if (!auth) {
    return { ok: false, httpStatus: null, error: "no_token", login_required: true };
  }

  let res: Response;
  try {
    res = await fetch(POGO_FOLLOW_CHECK_URL, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${auth}`,
        Accept: "*/*",
      },
      // Pogo gửi content-length: 0 — không set body.
    });
  } catch {
    return {
      ok: false,
      httpStatus: null,
      error: "Không gọi được https://pogo.social/api/me/follow-check (mạng).",
      login_required: false,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      httpStatus: res.status,
      error: "Token hết hạn / không hợp lệ.",
      login_required: true,
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      error: `follow-check HTTP ${res.status}`,
      login_required: false,
    };
  }

  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return {
    ok: true,
    httpStatus: res.status,
    checked: o.checked === true,
    targetFollowed: asBoolOrNull(o.target_followed),
    unlockedCount: asNum(o.unlocked_count),
    awardedCount: asNum(o.awarded_count),
    awardedPoints: asNum(o.awarded_points),
    unlockedPoints: asNum(o.unlocked_points),
  };
}
