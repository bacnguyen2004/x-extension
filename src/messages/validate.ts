export interface MessageSenderLike {
  id?: string;
  url?: string;
  tab?: { id?: number } | undefined;
  frameId?: number;
}

export function isExtensionPageSender(sender: MessageSenderLike, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  if (!sender.url) return false;
  return sender.url.startsWith(`chrome-extension://${extensionId}/`);
}

export function isXTabSender(sender: MessageSenderLike, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  // frameId có thể thiếu trên một số bản Chrome; tab top-frame vẫn hợp lệ.
  if (sender.frameId != null && typeof sender.frameId !== "number") return false;
  if (sender.tab?.id == null) return false;
  if (!sender.url) return false;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.origin !== "https://x.com" && url.origin !== "https://twitter.com") return false;
  if (url.username || url.password) return false;
  // Chỉ nhận top frame (0) hoặc frameId không khai báo.
  if (typeof sender.frameId === "number" && sender.frameId !== 0) return false;
  return true;
}

