/**
 * Nút "Tạo Reply" trên timeline X (UX tham khảo X68 — code riêng).
 * Click → mở composer → AI soạn → dán text; user tự bấm Post.
 * Badge Sorsa nằm ở x-sorsa-badge.ts.
 */

import { readManualReplyRequest, type ManualReplyPayload } from "../x/manual-reply.ts";
import { confirmOwnReply, readReplyAttempt, submitReplyOnce } from "../x/reply-history.ts";
import { detectXIdentity } from "../x/identity.ts";
import { manualReplyError } from "./manual-reply-error.ts";

declare const chrome: typeof globalThis.chrome;

const BTN_CLASS = "xcc-create-reply-btn";
const STYLE_ID = "xcc-tweet-ui-style";
const LOG = "[x-content-creator/ui]";

let generating = false;
let observer: MutationObserver | null = null;
let scanScheduled = false;
let enableReplyBtn = true;
let manualDraft: { composer: HTMLElement; payload: ManualReplyPayload; pathname: string } | null = null;
let postListenerInstalled = false;

function watchManualPost(): void {
  if (postListenerInstalled) return;
  postListenerInstalled = true;
  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button[data-testid="reply"]')) { manualDraft = null; return; }
    const post = target?.closest('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
    const draft = manualDraft;
    if (!event.isTrusted || !post || !draft || !draft.composer.isConnected || post.hasAttribute("disabled") || post.getAttribute("aria-disabled") === "true") return;
    const scope = draft.composer.closest('[role="dialog"]');
    if (scope ? !scope.contains(post) : !!post.closest('[role="dialog"]')) return;
    const own = detectXIdentity(document, location.pathname).handle || "";
    if (own.toLowerCase() !== draft.payload.own_handle.toLowerCase() || location.pathname !== draft.pathname || !draft.composer.textContent?.trim()) return;
    manualDraft = null;
    // The user already clicked Post. This callback does not click or send anything.
    // Submission is uncertain until X confirms it, and must never be auto-retried.
    void submitReplyOnce(draft.payload.tweet_id, own, () => true).catch(() => {
      toast("Chưa lưu được lần gửi reply. Kiểm tra trên X trước khi tạo lại.", "warning");
    });
  }, true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toast(message: string, kind: "info" | "success" | "error" | "warning" = "info"): void {
  const el = document.createElement("div");
  el.textContent = message;
  const bg =
    kind === "error"
      ? "rgba(244,33,46,.95)"
      : kind === "success"
        ? "rgba(0,186,124,.95)"
        : kind === "warning"
          ? "rgba(255,168,0,.95)"
          : "rgba(29,155,240,.95)";
  el.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:2147483647;
    padding:10px 16px;border-radius:9999px;
    font:500 13px system-ui,sans-serif;color:#fff;pointer-events:none;
    background:${bg};box-shadow:0 4px 16px rgba(0,0,0,.25);
    transition:opacity .25s ease;
  `;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
  }, 2500);
  setTimeout(() => el.remove(), 2900);
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${BTN_CLASS} {
      margin-left: 8px;
      padding: 4px 10px;
      border-radius: 9999px;
      border: 1px solid rgb(29, 155, 240);
      background: transparent;
      color: rgb(29, 155, 240);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      font-family: system-ui, -apple-system, sans-serif;
      transition: background-color .15s ease;
      line-height: 1.2;
    }
    .${BTN_CLASS}:hover { background: rgba(29, 155, 240, 0.12); }
    .${BTN_CLASS}:disabled { opacity: 0.55; cursor: wait; }
    .${BTN_CLASS}[data-hidden="1"] { display: none !important; }
  `;
  document.documentElement.appendChild(style);
}

async function waitComposer(timeoutMs = 5000): Promise<HTMLElement | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const box =
      (document.querySelector('[data-testid="tweetTextarea_0"]') as HTMLElement | null) ||
      (document.querySelector('div[role="textbox"][contenteditable="true"]') as HTMLElement | null);
    if (box) {
      const editable =
        (box.matches?.('[contenteditable="true"]') ? box : null) ||
        (box.querySelector('[contenteditable="true"]') as HTMLElement | null) ||
        box;
      return editable;
    }
    await sleep(120);
  }
  return null;
}

async function pasteIntoComposer(el: HTMLElement, text: string): Promise<boolean> {
  try {
    el.focus();
  } catch {
    /* ignore */
  }
  await sleep(80);
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }),
    );
    await sleep(150);
    const got = (el.innerText || el.textContent || "").trim();
    if (got.includes(text.slice(0, Math.min(24, text.length)))) return true;
  } catch {
    /* fall through */
  }
  try {
    document.execCommand("insertText", false, text);
    await sleep(100);
    return (el.innerText || el.textContent || "").trim().length > 0;
  } catch {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    return true;
  }
}

function requestGenerate(payload: ManualReplyPayload): Promise<{ ok: boolean; text?: string; error?: string; detail?: string; skipped?: boolean; replyMode?: string }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "x_ui_generate_reply", ...payload },
        (res: { ok?: boolean; text?: string; error?: string; detail?: string; skipped?: boolean; reply_mode?: string } | undefined) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({ ok: !!res?.ok, text: res?.text, error: res?.error, detail: res?.detail, skipped: res?.skipped, replyMode: res?.reply_mode });
        },
      );
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

async function onCreateReply(nativeReplyBtn: HTMLElement, uiBtn: HTMLButtonElement): Promise<void> {
  if (document.documentElement.dataset.xContentCreator === "reload_required") {
    toast("Extension đã cập nhật. Tải lại tab X để tiếp tục.", "warning");
    return;
  }
  if (generating) {
    toast("Đang soạn reply, chờ chút…", "warning");
    return;
  }
  generating = true;
  const prev = uiBtn.textContent || "✨ Tạo Reply";
  uiBtn.disabled = true;
  uiBtn.textContent = "⏳…";
  try {
    // Read the selected post before opening a dialog can replace its article.
    const payload = readManualReplyRequest(nativeReplyBtn, document, location.pathname);
    if (!payload) throw new Error("Không đọc được nội dung bài");
    if (payload.own_handle) {
      if (payload.already_replied === "true") {
        await confirmOwnReply(payload.tweet_id, payload.own_handle);
        toast("Bạn đã trả lời đúng bài này. Không tạo reply trùng.", "warning");
        return;
      }
      const evidence = await readReplyAttempt(payload.tweet_id, payload.own_handle);
      if (evidence) {
        toast(evidence.state === "confirmed" ? "Bạn đã trả lời đúng bài này. Không tạo reply trùng." : "Đã có lần gửi reply cho bài này, cần kiểm tra kết quả trên X trước.", "warning");
        return;
      }
    }
    nativeReplyBtn.click();
    await sleep(900 + Math.floor(Math.random() * 700));
    toast(payload.owner_post ? "Đang đọc bài của bạn và bình luận để tạo phản hồi…" : "Đang soạn reply…", "info");
    const gen = await requestGenerate(payload);
    if (gen.skipped) {
      toast("AI bỏ qua: chưa có reply phù hợp hoặc thiếu ngữ cảnh.", "info");
      return;
    }
    if (!gen.ok || !gen.text?.trim()) {
      throw new Error(manualReplyError(gen.error, gen.detail));
    }
    const composer = await waitComposer(5000);
    if (!composer) throw new Error("Không mở được ô reply");
    const ok = await pasteIntoComposer(composer, gen.text.trim());
    if (!ok) throw new Error("Không dán được vào composer");
    manualDraft = payload.own_handle ? { composer, payload, pathname: location.pathname } : null;
    uiBtn.textContent = "✅";
    toast(`Reply sẵn sàng${gen.replyMode ? ` · ${gen.replyMode === "mention_reply" ? "Mentions" : "News Feed"}` : ""} — kiểm tra rồi bấm Post`, "success");
  } catch (e) {
    console.error(LOG, e);
    uiBtn.textContent = "❌";
    toast(e instanceof Error ? e.message : "Lỗi tạo reply", "error");
  } finally {
    setTimeout(() => {
      uiBtn.textContent = prev;
      uiBtn.disabled = false;
    }, 1800);
    generating = false;
  }
}

function injectNearReply(nativeBtn: HTMLElement): void {
  if (nativeBtn.dataset.xccReplyInjected === "1") return;
  const group = nativeBtn.closest('[role="group"]') || nativeBtn.parentElement;
  if (!group) return;
  if (group.querySelector(`.${BTN_CLASS}`)) {
    nativeBtn.dataset.xccReplyInjected = "1";
    return;
  }
  nativeBtn.dataset.xccReplyInjected = "1";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.textContent = "✨ Tạo Reply";
  btn.setAttribute("aria-label", "Tạo reply bằng AI (X Content Creator)");
  btn.tabIndex = 0;
  if (!enableReplyBtn) btn.dataset.hidden = "1";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void onCreateReply(nativeBtn, btn);
  });
  group.appendChild(btn);
}

function scan(): void {
  if (document.documentElement.dataset.xContentCreator === "reload_required") { observer?.disconnect(); return; }
  try {
    if (!enableReplyBtn) {
      document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
        (b as HTMLElement).dataset.hidden = "1";
      });
      return;
    }
    document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
      delete (b as HTMLElement).dataset.hidden;
    });
    document.querySelectorAll('button[data-testid="reply"]').forEach((el) => {
      injectNearReply(el as HTMLElement);
    });
  } catch (e) {
    console.error(LOG, "scan failed", e);
  }
}

function loadPrefs(): void {
  try {
    chrome.storage.local.get(["xContentCreator.ui.v1"], (raw) => {
      const ui = raw["xContentCreator.ui.v1"] as { enableCreateReply?: boolean } | undefined;
      enableReplyBtn = ui?.enableCreateReply !== false;
      scan();
    });
  } catch {
    enableReplyBtn = true;
  }
}

export function startXTweetUi(): void {
  try {
    watchManualPost();
    ensureStyles();
    loadPrefs();
    scan();
    setTimeout(() => scan(), 800);
    if (!observer) {
      observer = new MutationObserver(() => {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
          scanScheduled = false;
          scan();
        });
      });
      try {
        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
        });
      } catch (e) {
        console.warn(LOG, "observer failed", e);
      }
    }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes["xContentCreator.ui.v1"]) return;
        const next = changes["xContentCreator.ui.v1"].newValue as
          | { enableCreateReply?: boolean }
          | undefined;
        enableReplyBtn = next?.enableCreateReply !== false;
        scan();
      });
    } catch {
      /* ignore */
    }
    console.info(LOG, "reply UI ready");
  } catch (e) {
    console.error(LOG, "startXTweetUi failed", e);
  }
}
