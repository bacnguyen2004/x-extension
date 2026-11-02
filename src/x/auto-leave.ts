// Shared between the isolated content script and the early MAIN-world guard.
// Only a timestamp crosses worlds; no extension credentials or messages.
export const AUTO_LEAVE_KEY = "xcc.autoLeaveUntil.v1";
export const AUTO_LEAVE_ATTR = "data-xcc-auto-leave-until";

export function armAutoLeave(deadlineAt: number): void {
  const until = Math.min(Date.now() + 15 * 60000, deadlineAt + 10 * 60000);
  if (typeof document !== "undefined") document.documentElement?.setAttribute(AUTO_LEAVE_ATTR, String(until));
  try { sessionStorage.setItem(AUTO_LEAVE_KEY, String(until)); } catch {}
}

export function clearAutoLeave(): void {
  if (typeof document !== "undefined") document.documentElement?.removeAttribute(AUTO_LEAVE_ATTR);
  try { sessionStorage.removeItem(AUTO_LEAVE_KEY); } catch {}
}

export function autoLeaveActive(doc: Document, storage?: Pick<Storage, "getItem">): boolean {
  let stored = 0;
  try { stored = Number(storage?.getItem(AUTO_LEAVE_KEY)); } catch {}
  const until = Math.max(Number(doc.documentElement?.getAttribute(AUTO_LEAVE_ATTR)) || 0, stored || 0);
  const now = Date.now();
  return Number.isFinite(until) && until > now && until <= now + 15 * 60000;
}

export function installLeaveGuard(win: Window): void {
  if (!["https://x.com", "https://twitter.com"].includes(win.location.origin)) return;
  const scope = win as Window & { __xccLeaveGuard?: boolean };
  if (scope.__xccLeaveGuard) return;
  scope.__xccLeaveGuard = true;
  win.addEventListener("beforeunload", event => {
    let storage: Storage | undefined;
    try { storage = win.sessionStorage; } catch {}
    if (!autoLeaveActive(win.document, storage)) return;
    // Installed at document_start, before X registers its unsaved-draft handler.
    // Allow the navigation itself while skipping the site's confirmation handler.
    event.stopImmediatePropagation();
    event.returnValue = "";
  }, { capture: true });
}
