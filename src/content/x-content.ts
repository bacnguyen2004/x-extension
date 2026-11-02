/**
 * Entry content script X — Phase 1–3.
 * Logic lệnh nằm ở x-commands.ts / x/actions/*.
 */

import { handleXCommand, snapshot } from "./x-commands.ts";
import { startXTweetUi } from "./x-tweet-ui.ts";
import { startSorsaBadges } from "./x-sorsa-badge.ts";
import { startFollowingObserver } from "./x-follow-history.ts";
import { stopActions } from "../x/action-control.ts";
import { extensionContextAlive, showContextReloadNotice } from "./extension-context.ts";
import { clearAutoLeave } from "../x/auto-leave.ts";
import { watchDraftConfirmations } from "../x/draft-confirmation.ts";

declare const chrome: typeof globalThis.chrome;

const LOG = "[x-content-creator/x]";
const originOk =
  location.origin === "https://x.com" || location.origin === "https://twitter.com";

const scope = globalThis as typeof globalThis & { __xccXContentBoot?: boolean };

if (originOk) {
  let port: chrome.runtime.Port | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => {
    stopActions();
    clearAutoLeave();
    port = null;
    showContextReloadNotice();
  };

  function scheduleConnect(delayMs: number): void {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect(), delayMs);
  }

  function connect(): void {
    if (!extensionContextAlive()) { invalidate(); return; }
    if (port) return;
    try {
      const connected = chrome.runtime.connect({ name: "x-tab" });
      port = connected;
      connected.onMessage.addListener((msg: unknown) => {
        if (!extensionContextAlive()) { invalidate(); return; }
        void handleXCommand(connected, msg).catch(() => { if (!extensionContextAlive()) invalidate(); });
      });
      connected.onDisconnect.addListener(() => {
        try { void chrome.runtime.lastError; } catch { /* Context was replaced. */ }
        if (port !== connected) return;
        port = null;
        stopActions();
        if (!extensionContextAlive()) { invalidate(); return; }
        // SW MV3 hay ngủ — reconnect nhanh để agent tick không bỏ lỡ.
        scheduleConnect(400);
      });
      connected.postMessage(snapshot());
      console.info(LOG, "port connected", location.href);
    } catch {
      port = null;
      if (!extensionContextAlive()) invalidate();
      else scheduleConnect(1500);
    }
  }

  // SW gửi x_ensure_port khi Map port trong worker trống (sau ngủ/dậy).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object" || (msg as { type?: string }).type !== "x_ensure_port") return;
    if (!extensionContextAlive()) {
      invalidate();
      sendResponse({ ok: false, error: "context_dead" });
      return true;
    }
    if (!port) connect();
    else {
      try { port.postMessage(snapshot()); }
      catch { port = null; connect(); }
    }
    sendResponse({ ok: true, connected: !!port });
    return true;
  });

  if (!scope.__xccXContentBoot) {
    scope.__xccXContentBoot = true;
    document.documentElement.dataset.xContentCreator = "connected";
    connect();
    watchDraftConfirmations(document);
    startXTweetUi();
    startSorsaBadges();
    startFollowingObserver();
    console.info(LOG, "boot", location.href);

    let lastIdentity = "";
    const heartbeat = setInterval(() => {
      if (!extensionContextAlive()) { invalidate(); clearInterval(heartbeat); return; }
      // Lỗi cũ: !port thì return mãi — không bao giờ reconnect.
      if (!port) { connect(); return; }
      const current = snapshot();
      const identity = JSON.stringify([current.href, current.handle, current.composerPresent, current.onHome, current.notificationCount]);
      if (identity === lastIdentity) return;
      try {
        port.postMessage(current);
        lastIdentity = identity;
      } catch {
        port = null;
        if (!extensionContextAlive()) invalidate();
        else connect();
      }
    }, 1500);
  } else {
    // Re-inject sau khi SW nudge — chỉ cần nối lại port.
    connect();
  }
}
