import { fetchPogoFeed, type FeedFetchResult } from "../api/feed-client.ts";
import { getApiSessionRevision } from "./api-session.ts";
import { notifyTelegram } from "./telegram-notify.ts";

export const POGO_AUTH_HOST = "com.xcontentcreator.pogo_auth";
export const POGO_AUTH_ALARM = "pogo-auth-renew";
const KEY = "xContentCreator.pogoNativeAuth.v1";
let lastError: string | null = null;
let retryAfter = 0;
let inFlight: Promise<void> | null = null;
type Verified = Extract<FeedFetchResult, { ok: true }>;

export function bearerExpiresAt(token: string | null): number | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    const body = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof body.exp === "number" && Number.isFinite(body.exp) ? body.exp * 1000 : null;
  } catch { return null; }
}

export async function getNativeAuthState() {
  const raw = (await chrome.storage.local.get(KEY))[KEY];
  return { enabled: raw?.enabled === true, lastError, extensionId: chrome.runtime.id };
}

export async function setNativeAuthEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEY]: { enabled } });
  retryAfter = 0; lastError = null;
  if (enabled) await chrome.alarms.create(POGO_AUTH_ALARM, { periodInMinutes: 1 });
  else await chrome.alarms.clear(POGO_AUTH_ALARM);
}

export function createNativeAuthProvider(commit: (token: string, verified: Verified, revision: number) => Promise<void>) {
  return async (current: string | null): Promise<void> => {
    if (!(await getNativeAuthState()).enabled) return;
    const state = (await chrome.storage.local.get("pogoTaskReader.state"))["pogoTaskReader.state"];
    const expires = bearerExpiresAt(current);
    if (expires && expires > Date.now() + 300000 && !state?.login_required) return;
    if (inFlight) return inFlight;
    if (Date.now() < retryAfter) return;
    retryAfter = Date.now() + 60000;
    const revision = getApiSessionRevision();
    const request = (async () => {
      try {
        const native = await new Promise<{ ok?: boolean; token?: string; error?: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("auth_timeout")), 60000);
          Promise.resolve().then(() => chrome.runtime.sendNativeMessage(POGO_AUTH_HOST, { action: "get_token" })).then(
            value => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); reject(new Error("native_host_unavailable")); },
          );
        });
        if (revision !== getApiSessionRevision() || !(await getNativeAuthState()).enabled) return;
        if (!native.ok || typeof native.token !== "string") throw new Error(native.error || "native_auth_failed");
        const verified = await fetchPogoFeed(native.token);
        if (revision !== getApiSessionRevision() || !(await getNativeAuthState()).enabled) return;
        if (!verified.ok) throw new Error("pogo_token_verification_failed");
        await commit(native.token, verified, revision);
        lastError = null;
        if (!bearerExpiresAt(native.token)) retryAfter = Date.now() + 300000;
      } catch (error) {
        const allowed = ["native_host_unavailable", "auth_timeout", "telegram_not_configured", "pogo_endpoint_not_configured", "telegram_login_required", "credentials_unavailable", "invalid_pogo_login_config", "pogo_login_rejected", "pogo_login_failed", "pogo_token_missing", "dependencies_missing", "telegram_or_pogo_unavailable", "pogo_account_mismatch", "pogo_identity_unverified", "pogo_token_verification_failed"];
        lastError = error instanceof Error && allowed.includes(error.message) ? error.message : "native_auth_failed";
        await notifyTelegram("pogo_auth_error");
      }
    })().finally(() => { if (inFlight === request) inFlight = null; });
    inFlight = request;
    await request;
  };
}
