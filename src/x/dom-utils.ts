import { ActionStoppedError, actionSignal, actionDeadline, assertActionActive } from "./action-control.ts";

export function sleep(ms: number): Promise<void> {
  assertActionActive();
  const signal = actionSignal();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ActionStoppedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.min(ms, Math.max(0, actionDeadline() - Date.now())));
    signal.addEventListener("abort", onAbort, { once: true });
  }).then(() => assertActionActive());
}

export async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs = 8000,
  stepMs = 200,
): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    assertActionActive();
    const v = fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

export function qs<T extends Element>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector(sel) as T | null;
}

export function qsa<T extends Element>(sel: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(sel)] as T[];
}

export function click(el: Element | null): boolean {
  assertActionActive();
  if (!el || !(el instanceof HTMLElement)) return false;
  el.click();
  return true;
}

function composerVisibleText(el: HTMLElement): string {
  return (el.innerText || el.textContent || (el as HTMLTextAreaElement).value || "").trim();
}

function focusComposer(el: HTMLElement): HTMLElement {
  const editable =
    (el.matches?.('[contenteditable="true"]') ? el : null) ||
    (el.querySelector?.('[contenteditable="true"]') as HTMLElement | null) ||
    el;
  try {
    editable.focus();
  } catch {
    /* ignore */
  }
  return editable;
}

function selectAllIn(el: HTMLElement): void {
  try {
    const sel = window.getSelection?.();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    try {
      document.execCommand("selectAll", false);
    } catch {
      /* ignore */
    }
  }
}

/** Gõ text vào contenteditable / textarea kiểu React (Draft.js trên X). */
export function setComposerText(el: HTMLElement, text: string): boolean {
  assertActionActive();
  const box = focusComposer(el);
  const value = String(text || "");

  // 1) Xóa nội dung cũ
  selectAllIn(box);
  try {
    document.execCommand("delete", false);
  } catch {
    /* ignore */
  }
  box.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }),
  );

  // 2) Ưu tiên paste — React/Draft.js trên X nhận ClipboardEvent ổn định hơn insertText.
  let pasted = false;
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", value);
    const pasteEv = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    } as ClipboardEventInit);
    pasted = box.dispatchEvent(pasteEv);
    if (composerVisibleText(box).length > 0) {
      return true;
    }
  } catch {
    pasted = false;
  }

  // 3) insertText + InputEvent
  focusComposer(box);
  selectAllIn(box);
  try {
    document.execCommand("insertText", false, value);
  } catch {
    /* ignore */
  }
  if ((box as HTMLTextAreaElement).value !== undefined && "value" in box) {
    const ta = box as HTMLTextAreaElement;
    const proto = window.HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc?.set?.call(ta, value);
  }
  box.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
  );
  box.dispatchEvent(new Event("change", { bubbles: true }));

  if (composerVisibleText(box).length > 0) return true;

  // 4) Fallback thô — vẫn kích hoạt input để UI biết có chữ
  box.textContent = value;
  box.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
  );
  return composerVisibleText(box).length > 0 || pasted;
}

/** Chờ nút Post/Reply bật (không disabled / aria-disabled). */
export async function waitForEnabledSubmit(
  findBtn: () => HTMLElement | null,
  timeoutMs = 10_000,
): Promise<HTMLElement | null> {
  return waitFor(() => {
    const b = findBtn();
    if (!b) return null;
    if (b.getAttribute("aria-disabled") === "true") return null;
    if ((b as HTMLButtonElement).disabled) return null;
    return b;
  }, timeoutMs, 250);
}

export function findTweetArticle(tweetId: string): HTMLElement | null {
  const articles = qsa<HTMLElement>('article[data-testid="tweet"]');
  let fallback: HTMLElement | null = null;
  for (const a of articles) {
    const links = qsa<HTMLAnchorElement>(`a[href*="/status/${tweetId}"]`, a);
    if (!links.length) continue;
    // Bỏ link nằm trong article lồng (quote) — ưu tiên article “sở hữu” status này.
    const nested = qsa<HTMLElement>('article[data-testid="tweet"]', a).filter((n) => n !== a);
    const own = links.some((link) => !nested.some((n) => n.contains(link)));
    if (own) return a;
    if (!fallback) fallback = a;
  }
  return fallback;
}

/** Nút action của chính article — không lấy like/RT trong quote lồng. */
export function findArticleAction(
  article: HTMLElement,
  testIds: string[],
): HTMLElement | null {
  const nested = qsa<HTMLElement>('article[data-testid="tweet"]', article).filter(
    (n) => n !== article,
  );
  for (const id of testIds) {
    for (const el of qsa<HTMLElement>(`[data-testid="${id}"]`, article)) {
      if (nested.some((n) => n.contains(el))) continue;
      return el;
    }
  }
  return null;
}
