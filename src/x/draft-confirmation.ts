import { autoLeaveActive } from "./auto-leave.ts";

const clickedAt = new WeakMap<HTMLElement, number>();

/** Only draft/leave confirmations, never a generic confirmationSheetConfirm. */
export function dismissDraftConfirmation(doc: Document): boolean {
  const context = /save (post|reply)|save.{0,40}draft|discard.{0,40}draft|unsent|unposted|leave.{0,30}(page|site)|lưu (bài đăng|trả lời)|lưu.{0,30}nháp|bỏ.{0,30}nháp|chưa.{0,20}(gửi|lưu)|rời khỏi.{0,20}trang/i;
  const accept = /^(discard(?: draft)?|don['’]t save|do not save|leave(?: (?:page|site))?|bỏ(?: bản nháp)?|hủy bản nháp|không lưu|rời khỏi(?: trang)?|xóa bản nháp)$/i;
  for (const dialog of doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-testid="sheetDialog"]')) {
    if (dialog.closest('[hidden], [aria-hidden="true"]') || !context.test(dialog.textContent || "")) continue;
    for (const button of dialog.querySelectorAll<HTMLElement>('button, [role="button"]')) {
      const label = (button.getAttribute("aria-label") || button.textContent || "").replace(/\s+/g, " ").trim();
      if (!accept.test(label) || button.getAttribute("aria-disabled") === "true" || (button as HTMLButtonElement).disabled) continue;
      if (Date.now() - (clickedAt.get(button) ?? -Infinity) < 1000) continue;
      clickedAt.set(button, Date.now());
      button.click();
      return true;
    }
  }
  return false;
}

/** Called even after cancellation, but touches only the exact text this action filled. */
export function cleanupOwnedComposer(box: HTMLElement, text: string, doc: Document): boolean {
  const current = () => ((box as HTMLTextAreaElement).value ?? box.innerText ?? box.textContent ?? "").trim();
  if (!box.isConnected || current() !== text.trim()) return false;
  try {
    box.focus();
    const range = doc.createRange(); range.selectNodeContents(box);
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    doc.execCommand("delete", false);
  } catch {}
  if (current()) box.textContent = "";
  if ("value" in box) (box as HTMLTextAreaElement).value = "";
  const Input = doc.defaultView?.InputEvent ?? doc.defaultView?.Event ?? Event;
  box.dispatchEvent(new Input("input", { bubbles: true, inputType: "deleteContentBackward", data: null } as InputEventInit));
  box.dispatchEvent(new (doc.defaultView?.Event ?? Event)("change", { bubbles: true }));
  const dialog = box.closest('[role="dialog"]');
  dialog?.querySelector<HTMLElement>('[data-testid="app-bar-close"], [aria-label="Close"], [aria-label="Đóng"]')?.click();
  dismissDraftConfirmation(doc);
  return !current();
}

export function watchDraftConfirmations(doc: Document): void {
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      let storage: Storage | undefined;
      try { storage = doc.defaultView?.sessionStorage; } catch {}
      if (autoLeaveActive(doc, storage)) dismissDraftConfirmation(doc);
    });
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
}
