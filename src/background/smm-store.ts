/**
 * Lưu SMM settings + lịch sử đơn.
 * API key mã hóa AES-GCM nhẹ (cùng kiểu AI store, salt riêng).
 */

import {
  createDefaultSmmSettings,
  createEmptyScanSnapshot,
  sanitizeSmmSettings,
  toPublicSmmSettings,
  type SmmOrderEntry,
  type SmmPublicState,
  type SmmScanSnapshot,
  type SmmSettings,
  type SmmSettingsPublic,
} from "../domain/smm-settings.ts";
import type { SmmService } from "../api/smm-client.ts";

const SETTINGS_KEY = "xContentCreator.smm.v1";
const ORDERS_KEY = "xContentCreator.smmOrders.v1";
const ENC_PREFIX = "enc:v1:";
const MAX_ORDERS = 200;

interface StoredBlob {
  apiKey: string;
  viewServiceId: string;
  viewOrderQuantity: number;
  likeServiceId: string;
  likeOrderQuantity: number;
  autoOrder: boolean;
  scanUsername: string;
  scanLimit: number;
  minViews: number;
  minLikes: number;
  minReposts: number;
  minReplies: number;
  scanDelaySec: number;
}

let cachedServices: SmmService[] = [];
let balanceCache: { balance: string | null; currency: string | null } = {
  balance: null,
  currency: null,
};
let scanSnapshot: SmmScanSnapshot = createEmptyScanSnapshot();
let scanCancelRequested = false;

async function deriveKey(extensionId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`xcc-smm-settings:${extensionId}`),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("xcc-smm-v1"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encryptSecret(plain: string, extensionId: string): Promise<string> {
  if (!plain) return "";
  const key = await deriveKey(extensionId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return `${ENC_PREFIX}${b64encode(iv.buffer)}:${b64encode(cipher)}`;
}

async function decryptSecret(stored: string, extensionId: string): Promise<string> {
  if (!stored) return "";
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const rest = stored.slice(ENC_PREFIX.length);
  const [ivB64, dataB64] = rest.split(":");
  if (!ivB64 || !dataB64) return "";
  try {
    const key = await deriveKey(extensionId);
    const iv = b64decode(ivB64);
    const data = b64decode(dataB64);
    const ivBuf = new Uint8Array(iv).buffer;
    const dataBuf = new Uint8Array(data).buffer;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, key, dataBuf);
    return new TextDecoder().decode(plain);
  } catch {
    return "";
  }
}

export async function loadSmmSettings(extensionId: string): Promise<SmmSettings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  const blob = raw[SETTINGS_KEY];
  if (!blob || typeof blob !== "object") return createDefaultSmmSettings();
  const stored = blob as StoredBlob;
  const apiKey = await decryptSecret(
    typeof stored.apiKey === "string" ? stored.apiKey : "",
    extensionId,
  );
  return sanitizeSmmSettings({ ...stored, apiKey });
}

export async function saveSmmSettings(
  settings: SmmSettings,
  extensionId: string,
): Promise<SmmSettingsPublic> {
  const clean = sanitizeSmmSettings(settings);
  const encryptedKey = await encryptSecret(clean.apiKey.trim(), extensionId);
  const blob: StoredBlob = {
    apiKey: encryptedKey,
    viewServiceId: clean.viewServiceId,
    viewOrderQuantity: clean.viewOrderQuantity,
    likeServiceId: clean.likeServiceId,
    likeOrderQuantity: clean.likeOrderQuantity,
    autoOrder: clean.autoOrder,
    scanUsername: clean.scanUsername,
    scanLimit: clean.scanLimit,
    minViews: clean.minViews,
    minLikes: clean.minLikes,
    minReposts: clean.minReposts,
    minReplies: clean.minReplies,
    scanDelaySec: clean.scanDelaySec,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: blob });
  return toPublicSmmSettings(clean);
}

export async function clearSmmApiKey(extensionId: string): Promise<SmmSettingsPublic> {
  const current = await loadSmmSettings(extensionId);
  current.apiKey = "";
  return saveSmmSettings(current, extensionId);
}

export async function loadSmmOrders(): Promise<SmmOrderEntry[]> {
  const raw = await chrome.storage.local.get(ORDERS_KEY);
  const list = raw[ORDERS_KEY];
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === "object")
    .map((e) => {
      const o = e as Record<string, unknown>;
      return {
        id: String(o.id || `${o.at}-${o.order}`),
        at: typeof o.at === "number" ? o.at : Date.now(),
        order: String(o.order || ""),
        service: String(o.service || ""),
        quantity: typeof o.quantity === "number" ? o.quantity : 0,
        metric: o.metric === "likes" ? ("likes" as const) : ("views" as const),
        postId: typeof o.postId === "string" ? o.postId : undefined,
        url: String(o.url || ""),
      };
    })
    .filter((e) => e.order);
}

// Serialize read/modify/write so independent orders cannot overwrite each other.
let orderWrites: Promise<unknown> = Promise.resolve();

function updateOrders<T>(write: () => Promise<T>): Promise<T> {
  const result = orderWrites.then(write, write);
  orderWrites = result.catch(() => {});
  return result;
}

export function pushSmmOrder(
  entry: Omit<SmmOrderEntry, "id" | "at"> & { id?: string; at?: number },
): Promise<SmmOrderEntry[]> {
  return updateOrders(() => appendSmmOrder(entry));
}

async function appendSmmOrder(
  entry: Omit<SmmOrderEntry, "id" | "at"> & { id?: string; at?: number },
): Promise<SmmOrderEntry[]> {
  const list = await loadSmmOrders();
  if (entry.order && list.some((x) => x.order === String(entry.order))) return list;
  const next: SmmOrderEntry = {
    id: entry.id || `smm-${Date.now()}-${entry.order}`,
    at: entry.at || Date.now(),
    order: String(entry.order),
    service: String(entry.service),
    quantity: Number(entry.quantity) || 0,
    metric: entry.metric === "likes" ? "likes" : "views",
    postId: entry.postId,
    url: String(entry.url || ""),
  };
  const updated = [next, ...list].slice(0, MAX_ORDERS);
  await chrome.storage.local.set({ [ORDERS_KEY]: updated });
  return updated;
}

export async function clearSmmOrders(): Promise<void> {
  await updateOrders(() => chrome.storage.local.set({ [ORDERS_KEY]: [] }));
}

export function setCachedSmmServices(services: SmmService[]): void {
  cachedServices = Array.isArray(services) ? services : [];
}

export function getCachedSmmServices(): SmmService[] {
  return cachedServices;
}

export function setSmmBalanceCache(balance: string | null, currency: string | null): void {
  balanceCache = { balance, currency };
}

export function getSmmBalanceCache(): { balance: string | null; currency: string | null } {
  return balanceCache;
}

export function getSmmScanSnapshot(): SmmScanSnapshot {
  return scanSnapshot;
}

export function setSmmScanSnapshot(next: SmmScanSnapshot): void {
  scanSnapshot = next;
}

export function requestSmmScanCancel(): void {
  scanCancelRequested = true;
}

export function takeSmmScanCancel(): boolean {
  const v = scanCancelRequested;
  scanCancelRequested = false;
  return v;
}

export function isSmmScanCancelRequested(): boolean {
  return scanCancelRequested;
}

export function resetSmmScanCancel(): void {
  scanCancelRequested = false;
}

export async function getSmmPublicState(extensionId: string): Promise<SmmPublicState> {
  const settings = await loadSmmSettings(extensionId);
  const recentOrders = await loadSmmOrders();
  return {
    settings: toPublicSmmSettings(settings),
    balance: balanceCache.balance,
    currency: balanceCache.currency,
    servicesLoaded: cachedServices.length,
    recentOrders: recentOrders.slice(0, 50),
    scan: scanSnapshot,
  };
}
