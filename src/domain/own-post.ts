export function isOwnPost(ownHandle: string | null | undefined, author: string | null | undefined, url?: string | null): boolean {
  const own = (ownHandle || "").trim().replace(/^@/, "").toLowerCase();
  if (!own) return false;
  const handle = (author || "").trim().replace(/^@/, "").toLowerCase();
  const urlHandle = url?.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/\d+/i)?.[1]?.toLowerCase();
  return handle === own || urlHandle === own;
}
