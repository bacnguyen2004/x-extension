/**
 * Sorsa badges on X — UI mirrored from CHEOX68/X68 score-badge.css
 * (glowing pill + tier dot). Scores via SW. No innerHTML (Trusted Types).
 */

import { sorsaTier } from "../domain/sorsa-settings.ts";

declare const chrome: typeof globalThis.chrome;

const BADGE = "xcc-sorsa-badge";
const COMPACT = "xcc-sorsa-compact";
const PROFILE = "xcc-sorsa-profile";
// X makes the entire account row clickable. Only reject action buttons,
// not the UserCell that contains both the name and the Follow button.
const ACTION_CONTROL = 'button:not([data-testid="UserCell"]), [role="button"]:not([data-testid="UserCell"])';
const STYLE_ID = "xcc-sorsa-style-x68";
const LOG = "[x-content-creator/sorsa]";

let enabled = true;
let observer: MutationObserver | null = null;
let scanScheduled = false;

type CacheEntry =
  | { status: "loading" }
  | { status: "ok"; score: number | null }
  | { status: "err"; error: string };

const mem = new Map<string, CacheEntry>();
const queue: string[] = [];
let pumping = false;

function formatScore(score: number): string {
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** CSS adapted from X68 score-badge.css — class prefix xcc-sorsa-*. */
function ensureStyles(): void {
  for (const id of [
    "xcc-sorsa-style",
    "xcc-sorsa-style-v2",
    "xcc-sorsa-style-v3",
    "xcc-sorsa-style-basic",
  ]) {
    document.getElementById(id)?.remove();
  }
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.xcc-sorsa-off .${BADGE} { display: none !important; }

.${BADGE} {
  --tier: #94a3b8;
  --tier-soft: rgba(148, 163, 184, 0.14);
  --tier-line: rgba(148, 163, 184, 0.32);

  all: initial;
  display: inline-flex;
  align-items: center;
  position: relative;
  flex: 0 0 auto;
  vertical-align: middle;
  margin: 2px 0 2px 6px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
  color: #e2e8f0;
  cursor: default;
  user-select: none;
  isolation: isolate;
}

.${BADGE}[data-tier="low"] {
  --tier: #ff5c7a;
  --tier-soft: rgba(255, 92, 122, 0.13);
  --tier-line: rgba(255, 92, 122, 0.38);
}
.${BADGE}[data-tier="medium"] {
  --tier: #ffb347;
  --tier-soft: rgba(255, 179, 71, 0.13);
  --tier-line: rgba(255, 179, 71, 0.38);
}
.${BADGE}[data-tier="high"] {
  --tier: #00d4aa;
  --tier-soft: rgba(0, 212, 170, 0.13);
  --tier-line: rgba(0, 212, 170, 0.38);
}

.xcc-sorsa-inner {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--tier-soft);
  border: 1px solid var(--tier-line);
  backdrop-filter: saturate(140%) blur(6px);
  -webkit-backdrop-filter: saturate(140%) blur(6px);
  box-shadow: 0 0 10px -2px color-mix(in srgb, var(--tier) 45%, transparent);
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1),
              box-shadow 0.15s ease,
              background-color 0.2s ease;
}

.${BADGE}:hover .xcc-sorsa-inner {
  transform: translateY(-1px);
  box-shadow: 0 3px 12px -4px var(--tier),
              0 0 14px -2px color-mix(in srgb, var(--tier) 55%, transparent);
}

.xcc-sorsa-seg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.xcc-sorsa-label {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.55;
}

.xcc-sorsa-val {
  font-weight: 700;
  color: var(--tier);
}

.xcc-sorsa-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--tier);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tier) 22%, transparent),
              0 0 8px color-mix(in srgb, var(--tier) 70%, transparent);
}

.xcc-sorsa-seg-missing,
.xcc-sorsa-seg-error {
  font-size: 10.5px;
  font-weight: 600;
  color: rgba(226, 232, 240, 0.4);
  letter-spacing: 0.01em;
}
.xcc-sorsa-seg-error { color: #fbbf24; }

.xcc-sorsa-skeleton {
  width: 44px;
  height: 9px;
  border-radius: 5px;
  overflow: hidden;
  background: rgba(148, 163, 184, 0.16);
}

.xcc-sorsa-shimmer {
  display: block;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.22) 50%,
    transparent 100%
  );
  animation: xcc-sorsa-shimmer 1.15s ease-in-out infinite;
}

@keyframes xcc-sorsa-shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.${BADGE}.${PROFILE} { margin: 6px 0 0; }
.${BADGE}.${PROFILE} .xcc-sorsa-inner { padding: 5px 11px; font-size: 13px; gap: 7px; }
.${BADGE}.${PROFILE} .xcc-sorsa-val { font-size: 14px; letter-spacing: -0.01em; }

.${BADGE}.${COMPACT} .xcc-sorsa-inner { padding: 2px 6px; gap: 4px; }
.${BADGE}.${COMPACT} .xcc-sorsa-label { display: none; }
`;
  document.documentElement.appendChild(style);
}

function setBadgeChildren(badge: HTMLElement, children: HTMLElement[]): void {
  while (badge.firstChild) badge.removeChild(badge.firstChild);
  for (const child of children) badge.appendChild(child);
}

function buildScoreInner(scoreText: string): HTMLElement {
  const inner = el("span", "xcc-sorsa-inner");
  const seg = el("span", "xcc-sorsa-seg xcc-sorsa-seg-score");
  seg.appendChild(el("span", "xcc-sorsa-dot"));
  seg.appendChild(el("span", "xcc-sorsa-label", "S"));
  seg.appendChild(el("span", "xcc-sorsa-val", scoreText));
  inner.appendChild(seg);
  return inner;
}

function buildLoadingInner(): HTMLElement {
  const inner = el("span", "xcc-sorsa-inner");
  const seg = el("span", "xcc-sorsa-seg xcc-sorsa-skeleton");
  seg.appendChild(el("span", "xcc-sorsa-shimmer"));
  inner.appendChild(seg);
  return inner;
}

function buildMissingInner(text: string, error = false): HTMLElement {
  const inner = el("span", "xcc-sorsa-inner");
  inner.appendChild(
    el("span", error ? "xcc-sorsa-seg xcc-sorsa-seg-error" : "xcc-sorsa-seg xcc-sorsa-seg-missing", text),
  );
  return inner;
}

/**
 * Paint X68-style inner structure. Skip DOM rewrite when state/value unchanged
 * so MutationObserver does not loop.
 */
function paint(badge: HTMLElement, handle: string): void {
  let title = `Sorsa @${handle}`;
  let state = "pending";
  let tier = "pending";
  let valueKey = "";
  let inner: HTMLElement;

  const entry = mem.get(handle);
  if (!entry || entry.status === "loading") {
    title += ": đang tải…";
    state = "pending";
    tier = "pending";
    valueKey = "loading";
    inner = buildLoadingInner();
  } else if (entry.status === "err") {
    title += `: ${entry.error}`;
    state = "error";
    tier = "none";
    valueKey = `err:${entry.error}`;
    inner = buildMissingInner("Lỗi", true);
  } else if (entry.score == null) {
    title += ": chưa có trong Sorsa";
    state = "missing";
    tier = "none";
    valueKey = "missing";
    inner = buildMissingInner("—");
  } else {
    const text = formatScore(entry.score);
    title = `Sorsa Score @${handle}: ${entry.score}`;
    state = "ready";
    tier = Number.isFinite(entry.score) ? sorsaTier(entry.score) : "none";
    valueKey = `ok:${text}`;
    inner = buildScoreInner(text);
  }

  if (badge.dataset.tier !== tier) badge.dataset.tier = tier;
  if (badge.dataset.state !== state) badge.dataset.state = state;
  if (badge.title !== title) badge.title = title;
  if (badge.getAttribute("aria-label") !== title) badge.setAttribute("aria-label", title);

  if (badge.dataset.paint !== valueKey) {
    badge.dataset.paint = valueKey;
    setBadgeChildren(badge, [inner]);
  }
}

const CACHE_KEY = "xContentCreator.sorsaCache.v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 24;

type DiskCacheEntry = { score: number | null; at: number; error?: string };

/** Trick X68: đọc cache local trước → mở trang là hiện điểm ngay, không chờ API. */
function hydrateFromDiskCache(): Promise<number> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([CACHE_KEY], (raw) => {
        const map = (raw[CACHE_KEY] || {}) as Record<string, DiskCacheEntry>;
        const now = Date.now();
        let n = 0;
        for (const [handle, entry] of Object.entries(map)) {
          if (!entry || typeof entry.at !== "number") continue;
          if (now - entry.at > CACHE_TTL_MS) continue;
          if (entry.error && entry.score == null) {
            mem.set(handle, { status: "err", error: entry.error });
          } else {
            mem.set(handle, { status: "ok", score: entry.score ?? null });
          }
          n++;
        }
        resolve(n);
      });
    } catch {
      resolve(0);
    }
  });
}

function requestScoresBatch(
  usernames: string[],
): Promise<{
  ok: boolean;
  scores?: Record<string, { score?: number | null; error?: string }>;
  error?: string;
}> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "x_ui_sorsa_scores", usernames },
        (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({
            ok: !!res?.ok,
            scores: res?.scores,
            error: res?.error,
          });
        },
      );
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function paintHandle(handle: string): void {
  document.querySelectorAll(`.${BADGE}[data-handle="${CSS.escape(handle)}"]`).forEach((el) => {
    paint(el as HTMLElement, handle);
  });
}

function enqueue(handle: string): void {
  const existing = mem.get(handle);
  // Đã có điểm từ cache → không fetch lại.
  if (existing && existing.status === "ok") {
    paintHandle(handle);
    return;
  }
  if (existing && existing.status === "loading") return;
  mem.set(handle, { status: "loading" });
  if (!queue.includes(handle)) queue.push(handle);
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      if (!enabled) {
        queue.length = 0;
        break;
      }
      // Batch + song song; public v1 không cần ApiKey.
      const batch = queue.splice(0, BATCH_SIZE);
      const res = await requestScoresBatch(batch);
      const scores = res.scores || {};
      for (const h of batch) {
        const item = scores[h];
        if (item && "error" in item && item.error && !("score" in item && item.score !== undefined)) {
          mem.set(h, { status: "err", error: String(item.error) });
        } else if (item && "score" in item) {
          mem.set(h, { status: "ok", score: item.score ?? null });
        } else if (res.ok) {
          mem.set(h, { status: "ok", score: null });
        } else {
          mem.set(h, { status: "err", error: res.error || "error" });
        }
        paintHandle(h);
      }
    }
  } finally {
    pumping = false;
    if (queue.length > 0) void pump();
  }
}

function handleFromHref(href: string): string | null {
  try {
    const path = href.startsWith("http") ? new URL(href).pathname : href;
    const m = path.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    if (!m) return null;
    const reserved = new Set([
      "home", "explore", "search", "notifications", "messages", "settings",
      "i", "compose", "login", "signup", "tos", "privacy", "jobs", "intent",
      "share", "hashtag", "following", "followers", "status", "photo", "chat",
    ]);
    if (reserved.has(m[1].toLowerCase())) return null;
    return m[1];
  } catch {
    return null;
  }
}

function handleFromProfileUrl(): string | null {
  try {
    const path = location.pathname.replace(/\/+$/, "");
    const m = path.match(
      /^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|media|likes|highlights|articles|superfollows|following|followers|verified_followers))?$/i,
    );
    if (!m) return null;
    const reserved = new Set([
      "home", "explore", "search", "notifications", "messages", "settings",
      "i", "compose", "login", "signup", "tos", "privacy", "jobs", "intent", "share", "hashtag",
    ]);
    if (reserved.has(m[1].toLowerCase())) return null;
    return m[1];
  } catch {
    return null;
  }
}

function handleFromEl(root: Element): string | null {
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest(`.${BADGE}`)) continue;
    const href = a.getAttribute("href") || "";
    if (!/^\/[A-Za-z0-9_]{1,15}\/?$/.test(href)) continue;
    const handle = handleFromHref(href);
    if (handle) return handle;
  }
  const copy = root.cloneNode(true) as Element;
  copy.querySelectorAll(`.${BADGE}`).forEach((badge) => badge.remove());
  return (copy.textContent || "").match(/@([A-Za-z0-9_]{1,15})\b/)?.[1] ?? null;
}

function isFlexRow(el: Element): boolean {
  try {
    const cs = getComputedStyle(el);
    if (cs.display !== "flex" && cs.display !== "inline-flex") return false;
    return cs.flexDirection === "row" || cs.flexDirection === "row-reverse";
  } catch {
    return false;
  }
}

function isFlexColumn(el: Element): boolean {
  try {
    const cs = getComputedStyle(el);
    if (cs.display !== "flex" && cs.display !== "inline-flex") return false;
    return cs.flexDirection === "column" || cs.flexDirection === "column-reverse";
  } catch {
    return false;
  }
}

/** Con trực tiếp của row chứa node (để insert cạnh đúng). */
function directChildContaining(row: Element, node: Element): Element | null {
  let cur: Element | null = node;
  while (cur && cur.parentElement && cur.parentElement !== row) {
    cur = cur.parentElement;
  }
  return cur && cur.parentElement === row ? cur : null;
}

/**
 * Hàng ngang INNERMOST chứa display name (+ tick).
 * Bắt buộc flex-direction:row — tránh cột (badge bị đẩy lên trên tên).
 */
function findNameRow(nameRoot: Element): Element {
  // Account lists do not always expose User-Name. Anchor to the actual
  // display-name link instead of picking an arbitrary flex row in UserCell.
  const controls = ACTION_CONTROL;
  const nameLink = Array.from(nameRoot.querySelectorAll('a[href]')).find((link) => {
    if (link.closest(controls)) return false;
    const href = link.getAttribute("href") || "";
    if (!/^\/[A-Za-z0-9_]{1,15}\/?$/.test(href) || !handleFromHref(href)) return false;
    const text = (link.textContent || "").trim();
    return !!text && !text.startsWith("@");
  });
  if (nameLink) {
    const parent = nameLink.parentElement;
    if (parent && nameRoot.contains(parent) && isFlexRow(parent) &&
        !parent.closest(controls) && !parent.querySelector(controls)) return parent;
    const rows = Array.from(nameLink.querySelectorAll("div, span")).filter((el) =>
      !el.closest(`.${BADGE}`) && isFlexRow(el) && !!el.textContent?.trim() &&
      !el.querySelector(controls));
    return rows.find((el) => !rows.some((other) => other !== el && el.contains(other))) || nameLink;
  }
  const candidates: Element[] = [];
  nameRoot.querySelectorAll("div, span").forEach((el) => {
    if (el.closest(controls) || el.querySelector(controls)) return;
    if (el.closest(`.${BADGE}`) || el.closest("a")) return;
    if (!isFlexRow(el)) return;
    const t = (el.textContent || "").replace(/\b\d+(\.\d+)?k\b/gi, " ").trim();
    if (!t || t.startsWith("@") || t.length > 120) return;
    // Bỏ hàng chỉ có @handle.
    if (/^@[A-Za-z0-9_]{1,15}$/.test(t)) return;
    candidates.push(el);
  });

  // Innermost: không chứa candidate khác.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!;
    if (!candidates.some((o) => o !== c && c.contains(o))) return c;
  }
  if (candidates[0]) return candidates[0];
  if (isFlexRow(nameRoot)) return nameRoot;
  return nameRoot;
}

/**
 * Tick xanh / affiliate — ưu tiên; không có thì lấy khối tên (link).
 * Trả về con trực tiếp của row để insertAfter.
 */
function findPlaceAfterAnchor(row: Element): Element | null {
  const markerEls = row.querySelectorAll(
    [
      '[data-testid="icon-verified"]',
      'svg[aria-label*="Verified" i]',
      'svg[aria-label*="verified" i]',
      'svg[aria-label*="xác nhận" i]',
      'svg[aria-label*="Xác nhận" i]',
      '[data-testid*="affiliate" i]',
      'img[alt*="affiliate" i]',
      'a[href*="/i/verified"]',
      'a[href*="affiliate"]',
    ].join(","),
  );

  let lastMarker: Element | null = null;
  markerEls.forEach((el) => {
    const child = directChildContaining(row, el);
    if (child && child !== row && !child.classList.contains(BADGE)) lastMarker = child;
  });
  if (lastMarker) return lastMarker;

  // Svg / img ngay sau link tên (verified không aria-label).
  const nameLink = row.querySelector('a[href^="/"]');
  if (nameLink) {
    const nameChild = directChildContaining(row, nameLink);
    if (nameChild) {
      let sib: Element | null = nameChild.nextElementSibling;
      while (sib) {
        if (sib.classList.contains(BADGE)) {
          sib = sib.nextElementSibling;
          continue;
        }
        if (sib.querySelector("svg, img") || sib.tagName === "SVG" || sib.tagName === "IMG") {
          return sib;
        }
        sib = sib.nextElementSibling;
      }
      return nameChild;
    }
  }

  return null;
}

/** Chèn bên phải: sau tick/affiliate/tên — không bao giờ firstChild của cột. */
function placeBadgeInRow(row: Element, badge: HTMLElement): void {
  if (row.closest(ACTION_CONTROL)) return;
  // Nếu nhầm cột → tìm lại hàng ngang bên trong.
  let target = row;
  if (isFlexColumn(target)) {
    const inner = findNameRow(target);
    if (inner !== target && isFlexRow(inner)) target = inner;
  }

  const anchor = findPlaceAfterAnchor(target);
  if (anchor?.parentElement === target) {
    if (badge.previousElementSibling !== anchor || badge.parentElement !== target) {
      target.insertBefore(badge, anchor.nextSibling);
    }
    return;
  }
  if (anchor?.parentElement) {
    anchor.parentElement.insertBefore(badge, anchor.nextSibling);
    return;
  }
  if (badge.parentElement !== target) target.appendChild(badge);
}

function ensureBadge(
  nameRoot: Element,
  handle: string,
  opts: { compact?: boolean; profile?: boolean } = {},
): void {
  const key = handle.toLowerCase();
  const row = findNameRow(nameRoot);
  const existing = Array.from(nameRoot.querySelectorAll<HTMLElement>(`.${BADGE}`));
  let badge = existing.shift();
  for (const duplicate of existing) duplicate.remove();
  if (!badge) {
    badge = document.createElement("span");
    badge.className = BADGE;
  }
  badge.classList.toggle(COMPACT, !!opts.compact);
  badge.classList.toggle(PROFILE, !!opts.profile);
  // X reuses account rows while scrolling: always bind to the current account.
  if (badge.dataset.handle !== key) badge.dataset.handle = key;
  placeBadgeInRow(row, badge);
  enqueue(key);
  paint(badge, key);
}

function authorFromArticle(article: Element): string | null {
  const name = article.querySelector('[data-testid="User-Name"]');
  if (!name) return null;
  return handleFromEl(name);
}

function scanTweets(): void {
  document.querySelectorAll('article[data-testid="tweet"]').forEach((art) => {
    const nameRoot = art.querySelector('[data-testid="User-Name"]');
    if (!nameRoot) return;
    const handle = authorFromArticle(art);
    if (!handle) return;
    ensureBadge(nameRoot, handle);
  });
}

function scanProfile(): void {
  const urlHandle = handleFromProfileUrl();
  const column =
    document.querySelector('[data-testid="primaryColumn"]') ||
    document.querySelector('main[role="main"]') ||
    document;

  column.querySelectorAll('[data-testid="UserName"]').forEach((root) => {
    if (root.closest('article[data-testid="tweet"]')) return;
    if (root.closest('[data-testid="UserCell"]')) return;
    const handle = handleFromEl(root) || urlHandle;
    if (!handle) return;
    ensureBadge(root, handle, { profile: true });
  });
}

/** Following / Followers — UserCell: cạnh phải sau tick, compact để không wrap. */
function scanUserCells(): void {
  document.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
    const nameRoot =
      cell.querySelector('[data-testid="User-Name"]') ||
      cell.querySelector('[data-testid="UserName"]');
    const handle =
      (nameRoot ? handleFromEl(nameRoot) : null) || handleFromEl(cell);
    if (!handle) return;

    if (nameRoot) {
      ensureBadge(nameRoot, handle, { compact: true });
      return;
    }

    // Không có User-Name: tìm hàng ngang có tên trong cell.
    ensureBadge(cell, handle, { compact: true });
  });
}

function scan(): void {
  if (document.documentElement.dataset.xContentCreator === "reload_required") { observer?.disconnect(); return; }
  try {
    if (!enabled) {
      document.documentElement.classList.add("xcc-sorsa-off");
      return;
    }
    if (document.documentElement.classList.contains("xcc-sorsa-off")) {
      document.documentElement.classList.remove("xcc-sorsa-off");
    }
    scanTweets();
    scanProfile();
    scanUserCells();
  } catch (e) {
    console.error(LOG, "scan failed", e);
  }
}

function loadPrefs(): void {
  try {
    chrome.storage.local.get(["xContentCreator.ui.v1"], (raw) => {
      const ui = raw["xContentCreator.ui.v1"] as { enableSorsaBadge?: boolean } | undefined;
      enabled = ui?.enableSorsaBadge !== false;
      scan();
    });
  } catch {
    enabled = true;
  }
  try {
    chrome.runtime.sendMessage({ type: "x_ui_sorsa_prefs" }, () => {
      if (chrome.runtime.lastError) {
        console.warn(LOG, chrome.runtime.lastError.message);
      } else {
        console.info(LOG, "prefs", { enabled, cached: mem.size, mode: "public" });
      }
      scan();
    });
  } catch {
    /* ignore */
  }
}

export function startSorsaBadges(): void {
  try {
    ensureStyles();
    // Cache trước → mở Following/timeline là hiện điểm luôn (không chờ API).
    void hydrateFromDiskCache().then((n) => {
      console.info(LOG, "hydrated cache", n);
      loadPrefs();
      scan();
    });
    setTimeout(() => scan(), 500);
    setTimeout(() => scan(), 1500);
    if (!observer) {
      // Debounce nhẹ — tránh quét liên tục làm badge “giật”.
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      observer = new MutationObserver(() => {
        if (scanScheduled) return;
        scanScheduled = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          scanScheduled = false;
          debounceTimer = null;
          requestAnimationFrame(() => scan());
        }, 120);
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes["xContentCreator.ui.v1"]) {
          const next = changes["xContentCreator.ui.v1"].newValue as
            | { enableSorsaBadge?: boolean }
            | undefined;
          enabled = next?.enableSorsaBadge !== false;
          scan();
        }
      });
    } catch {
      /* ignore */
    }
    console.info(LOG, "ready");
  } catch (e) {
    console.error(LOG, "start failed", e);
  }
}
