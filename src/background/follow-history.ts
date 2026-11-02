import { isHandle } from "../domain/url.ts";
import type { FollowHistoryEntry } from "../domain/follow-history.ts";
import { parseHandleList } from "../domain/follow-settings.ts";

const KEY = "xContentCreator.followHistory.v1";
const OWNER_KEY = "xContentCreator.followHistoryOwner.v1";
let tail: Promise<unknown> = Promise.resolve();

function normalized(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

function entriesFromSaved(saved: unknown): FollowHistoryEntry[] {
  if (!Array.isArray(saved)) return [];
  const entries: FollowHistoryEntry[] = [];
  for (const item of saved) {
    const raw = typeof item === "string" ? { handle: item } : item;
    if (!raw || typeof raw !== "object" || typeof raw.handle !== "string") continue;
    const handle = normalized(raw.handle);
    if (!isHandle(handle)) continue;
    entries.push({ handle, status: raw.status === "requested" ? "requested" : "following",
      verified: typeof raw.verified === "boolean" ? raw.verified : null,
      followsYou: typeof raw.followsYou === "boolean" ? raw.followsYou : null,
      sorsa: typeof raw.sorsa === "number" && Number.isFinite(raw.sorsa) ? raw.sorsa : null,
      updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null });
  }
  return entries;
}

export async function loadFollowHistoryEntries(account: string): Promise<FollowHistoryEntry[]> {
  await tail;
  const owner = normalized(account);
  if (!isHandle(owner) || owner === "unknown") return [];
  const key = `${KEY}.${owner}`;
  const saved = (await chrome.storage.local.get(key))[key];
  const cache = (await chrome.storage.local.get("xContentCreator.sorsaCache.v1"))["xContentCreator.sorsaCache.v1"];
  return entriesFromSaved(saved).map(entry => {
    const cached = cache?.[entry.handle];
    return { ...entry, sorsa: typeof cached?.score === "number" && Number.isFinite(cached.score) ? cached.score : entry.sorsa };
  }).sort((first, second) => (second.updatedAt ?? 0) - (first.updatedAt ?? 0) || first.handle.localeCompare(second.handle));
}

export async function loadFollowHistory(account: string): Promise<Set<string>> {
  return new Set((await loadFollowHistoryEntries(account)).map(entry => entry.handle));
}

export async function readFollowHistoryView(currentAccount: string): Promise<{ account: string; connectedAccount: boolean; entries: FollowHistoryEntry[] }> {
  await tail;
  const current = normalized(currentAccount);
  let account = isHandle(current) && current !== "unknown" ? current : "";
  const connectedAccount = !!account;
  if (!account) {
    const saved = await chrome.storage.local.get(null);
    const owner = typeof saved[OWNER_KEY] === "string" ? normalized(saved[OWNER_KEY]) : "";
    if (isHandle(owner) && owner !== "unknown") account = owner;
    else {
      const accounts = Object.keys(saved).filter(key => key.startsWith(`${KEY}.`)).map(key => key.slice(KEY.length + 1)).filter(isHandle);
      if (accounts.length === 1) account = accounts[0];
    }
  }
  return { account, connectedAccount, entries: await loadFollowHistoryEntries(account) };
}

export function rememberFollow(account: string, handle: string, following = true, metadata: Partial<Pick<FollowHistoryEntry, "verified" | "followsYou" | "sorsa" | "status">> = {}): Promise<void> {
  const owner = normalized(account), target = normalized(handle);
  if (!isHandle(owner) || owner === "unknown" || !isHandle(target) || owner === target) return Promise.resolve();
  const request = tail.then(async () => {
    const key = `${KEY}.${owner}`;
    const saved = (await chrome.storage.local.get(key))[key];
    const entries = entriesFromSaved(saved);
    const previous = entries.find(entry => entry.handle === target);
    const next = entries.filter(entry => entry.handle !== target);
    if (following) next.push({ handle: target, status: "following", verified: null, followsYou: null, sorsa: null,
      ...previous, ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value != null)), updatedAt: Date.now() });
    const changes: Record<string, unknown> = { [key]: next, [OWNER_KEY]: owner };
    if (following) {
      const settingsKey = "xContentCreator.follow.v1";
      const settings = (await chrome.storage.local.get(settingsKey))[settingsKey];
      if (settings && typeof settings === "object" && typeof settings.usernameList === "string") {
        const handles = parseHandleList(settings.usernameList);
        if (handles.includes(target)) changes[settingsKey] = { ...settings,
          usernameList: handles.filter(handle => handle !== target).map(handle => `@${handle}`).join("\n") };
      }
    }
    await chrome.storage.local.set(changes);
  });
  tail = request.catch(() => {});
  return request;
}
