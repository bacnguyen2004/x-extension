/**
 * GET /api/bounties + POST /api/bounties/{id}/claim. Token chỉ truyền lúc gọi.
 */

import {
  extractBountyArray,
  mergeBountyObservation,
  normalizePogoBounty,
  type PogoAccountEconomy,
  type PogoBounty,
} from "../domain/pogo-bounty.ts";

export const POGO_BOUNTIES_URL = "https://pogo.social/api/bounties";
export const POGO_ME_URL = "https://pogo.social/api/me";

export type BountiesFetchResult =
  | { ok: true; bounties: PogoBounty[]; httpStatus: number }
  | { ok: false; httpStatus: number | null; error: string; login_required: boolean; code?: string };

export type BountyClaimResult =
  | { ok: true; status: string; httpStatus: number }
  | { ok: false; httpStatus: number | null; error: string; login_required: boolean; code?: string };

export type MeEconomyResult =
  | { ok: true; account: PogoAccountEconomy; httpStatus: number }
  | { ok: false; httpStatus: number | null; error: string; login_required: boolean };

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function errorCode(body: unknown, httpStatus: number): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    if (typeof o.code === "string" && o.code.trim()) return o.code.trim();
    const nested = o.error;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const code = (nested as Record<string, unknown>).code;
      if (typeof code === "string" && code.trim()) return code.trim();
    }
  }
  return `http_${httpStatus}`;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchPogoBounties(token: string, prev: PogoBounty[] = []): Promise<BountiesFetchResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false, httpStatus: null, error: "Token trống.", login_required: true };
  }

  let response: Response;
  try {
    response = await fetch(POGO_BOUNTIES_URL, {
      method: "GET",
      headers: authHeaders(trimmed),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return {
      ok: false,
      httpStatus: null,
      error: "Không gọi được https://pogo.social/api/bounties (mạng hoặc CORS).",
      login_required: false,
    };
  }

  const body = await readJson(response);
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      httpStatus: response.status,
      error: `API trả ${response.status}. Token hết hạn hoặc không hợp lệ.`,
      login_required: true,
      code: errorCode(body, response.status),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      error: `API trả HTTP ${response.status}.`,
      login_required: false,
      code: errorCode(body, response.status),
    };
  }

  if (!Array.isArray(body) && !(body && typeof body === "object" && Array.isArray((body as { bounties?: unknown }).bounties))) {
    return { ok: false, httpStatus: response.status, error: "API bounty trả dữ liệu không hợp lệ.", login_required: false, code: "invalid_response" };
  }
  const prevById = new Map(prev.map((b) => [b.id, b]));
  const bounties: PogoBounty[] = [];
  for (const item of extractBountyArray(body)) {
    const rawId = item && typeof item === "object" ? Number((item as { id?: unknown }).id) : NaN;
    const bounty = normalizePogoBounty(item, Number.isFinite(rawId) ? prevById.get(rawId) ?? null : null);
    if (bounty) bounties.push(mergeBountyObservation(bounty, Number.isFinite(rawId) ? prevById.get(rawId) ?? null : null));
  }
  return { ok: true, bounties, httpStatus: response.status };
}

export async function claimPogoBounty(token: string, bountyId: number): Promise<BountyClaimResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false, httpStatus: null, error: "Token trống.", login_required: true };
  }
  if (!Number.isInteger(bountyId) || bountyId <= 0) {
    return { ok: false, httpStatus: null, error: "bounty_id không hợp lệ.", login_required: false };
  }

  let response: Response;
  try {
    response = await fetch(`${POGO_BOUNTIES_URL}/${bountyId}/claim`, {
      method: "POST",
      headers: authHeaders(trimmed),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return {
      ok: false,
      httpStatus: null,
      error: "Không gọi được API claim bounty (mạng).",
      login_required: false,
    };
  }

  const body = await readJson(response);
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      httpStatus: response.status,
      error: "Token hết hạn / không hợp lệ.",
      login_required: true,
      code: errorCode(body, response.status),
    };
  }
  if (!response.ok) {
    const code = errorCode(body, response.status);
    return {
      ok: false,
      httpStatus: response.status,
      error: code,
      login_required: false,
      code,
    };
  }

  let status: string | null = null;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const claim = (body as Record<string, unknown>).claim;
    if (claim && typeof claim === "object" && !Array.isArray(claim)) {
      const raw = (claim as Record<string, unknown>).status;
      if (typeof raw === "string" && ["claimed", "completed", "exported", "paid"].includes(raw.trim())) status = raw.trim();
    }
  }
  if (!status) return { ok: false, httpStatus: response.status, error: "Chưa xác định được kết quả join từ API.", login_required: false, code: "claim_response_uncertain" };
  return { ok: true, status, httpStatus: response.status };
}

export async function fetchPogoMeEconomy(token: string): Promise<MeEconomyResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false, httpStatus: null, error: "Token trống.", login_required: true };
  }

  let response: Response;
  try {
    response = await fetch(POGO_ME_URL, {
      method: "GET",
      headers: authHeaders(trimmed),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return {
      ok: false,
      httpStatus: null,
      error: "Không gọi được /api/me (mạng).",
      login_required: false,
    };
  }

  const body = await readJson(response);
  if (response.status === 401 || response.status === 403) {
    return { ok: false, httpStatus: response.status, error: "Token hết hạn / không hợp lệ.", login_required: true };
  }
  if (!response.ok) {
    return { ok: false, httpStatus: response.status, error: `API trả HTTP ${response.status}.`, login_required: false };
  }

  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const wallet = o.wallet && typeof o.wallet === "object" && !Array.isArray(o.wallet)
    ? (o.wallet as Record<string, unknown>)
    : null;
  const balance = typeof o.balance === "number" && Number.isFinite(o.balance) ? o.balance : null;
  const debt = typeof o.debt_owed === "number" && Number.isFinite(o.debt_owed) ? o.debt_owed : 0;
  const walletType = wallet && typeof wallet.wallet_type === "string" ? wallet.wallet_type : null;
  return {
    ok: true,
    httpStatus: response.status,
    account: { balance, debtOwed: Math.max(0, debt), walletType },
  };
}
