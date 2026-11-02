/** Reloading/updating an extension invalidates scripts already injected into tabs. */
export function extensionContextAlive(): boolean {
  try { return typeof chrome.runtime.id === "string" && chrome.runtime.id.length > 0; }
  catch { return false; }
}

export function showContextReloadNotice(): void {
  document.documentElement.dataset.xContentCreator = "reload_required";
  if (document.getElementById("xcc-context-reload")) return;
  const button = document.createElement("button");
  button.id = "xcc-context-reload";
  button.type = "button";
  button.textContent = "Extension đã cập nhật hoặc mất kết nối. Bấm tải lại tab để tiếp tục.";
  button.setAttribute("style", "position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;padding:12px;border:1px solid #c8dadd;border-radius:10px;background:#fff;color:#154d59;font:13px/1.5 sans-serif;cursor:pointer;box-shadow:0 3px 16px #0002;");
  button.addEventListener("click", () => location.reload());
  (document.body || document.documentElement).appendChild(button);
}
