/**
 * Lưu AI settings trong chrome.storage.local.
 * API key được mã hóa AES-GCM nhẹ bằng khóa dẫn xuất từ extension id (không phải KMS).
 * Không log apiKey.
 */

import {
  createDefaultAiSettings,
  migrateReplyPrompts,
  sanitizeAiSettings,
  toPublicAiSettings,
  type AiSettings,
  type AiSettingsPublic,
} from "../domain/ai-settings.ts";

const STORAGE_KEY = "pogoTaskReader.aiSettings.v1";
const ENC_PREFIX = "enc:v1:";

interface StoredBlob {
  provider: AiSettings["provider"];
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** plaintext legacy hoặc enc:v1:... */
  apiKey: string;
  reply: AiSettings["reply"];
  browseReply?: AiSettings["browseReply"];
  mentionReply?: AiSettings["mentionReply"];
  quote: AiSettings["quote"];
  post: AiSettings["post"];
}

async function deriveKey(extensionId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`pogo-ai-settings:${extensionId}`),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("pogo-task-reader-ai-v1"),
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
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext
  const rest = stored.slice(ENC_PREFIX.length);
  const [ivB64, dataB64] = rest.split(":");
  if (!ivB64 || !dataB64) return "";
  try {
    const key = await deriveKey(extensionId);
    const iv = b64decode(ivB64);
    const data = b64decode(dataB64);
    // Copy into a new ArrayBuffer to satisfy BufferSource typing (avoid SharedArrayBuffer mismatch).
    const ivBuf = new Uint8Array(iv).buffer;
    const dataBuf = new Uint8Array(data).buffer;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, key, dataBuf);
    return new TextDecoder().decode(plain);
  } catch {
    return "";
  }
}

export async function loadAiSettings(extensionId: string): Promise<AiSettings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const blob = raw[STORAGE_KEY];
  if (!blob || typeof blob !== "object") return createDefaultAiSettings();
  const stored = blob as StoredBlob;
  const apiKey = await decryptSecret(typeof stored.apiKey === "string" ? stored.apiKey : "", extensionId);
  const loaded = sanitizeAiSettings({ ...stored, apiKey });
  const migrated = migrateReplyPrompts(loaded);
  // Persist prompt Reply mới nếu vừa migrate từ bản cũ.
  if (
    migrated.reply.systemPrompt !== loaded.reply.systemPrompt ||
    migrated.reply.userPromptTemplate !== loaded.reply.userPromptTemplate ||
    migrated.browseReply.systemPrompt !== loaded.browseReply.systemPrompt || migrated.browseReply.userPromptTemplate !== loaded.browseReply.userPromptTemplate ||
    migrated.mentionReply.systemPrompt !== loaded.mentionReply.systemPrompt || migrated.mentionReply.userPromptTemplate !== loaded.mentionReply.userPromptTemplate
  ) {
    await saveAiSettings(migrated, extensionId);
  }
  return migrated;
}

export async function saveAiSettings(
  settings: AiSettings,
  extensionId: string,
): Promise<AiSettingsPublic> {
  const clean = sanitizeAiSettings(settings);
  const encryptedKey = await encryptSecret(clean.apiKey.trim(), extensionId);
  const blob: StoredBlob = {
    provider: clean.provider,
    baseUrl: clean.baseUrl,
    model: clean.model,
    temperature: clean.temperature,
    maxTokens: clean.maxTokens,
    apiKey: encryptedKey,
    reply: clean.reply,
    browseReply: clean.browseReply,
    mentionReply: clean.mentionReply,
    quote: clean.quote,
    post: clean.post,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: blob });
  return toPublicAiSettings(clean);
}

export async function clearAiApiKey(extensionId: string): Promise<AiSettingsPublic> {
  const current = await loadAiSettings(extensionId);
  current.apiKey = "";
  return saveAiSettings(current, extensionId);
}

export function publicFromSettings(settings: AiSettings): AiSettingsPublic {
  return toPublicAiSettings(settings);
}
