export function findXNavigationLink(doc: Document, raw: string, currentUrl: string): HTMLAnchorElement | null {
  let target: URL;
  const current = new URL(currentUrl);
  try { target = new URL(raw, current); } catch { return null; }
  if (!["https://x.com", "https://twitter.com"].includes(target.origin) || target.origin !== current.origin) return null;
  for (const link of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (link.closest('[aria-hidden="true"], [hidden]') || link.target === "_blank") continue;
    try {
      const url = new URL(link.getAttribute("href")!, current);
      if (url.origin === target.origin && url.pathname.replace(/\/$/, "") === target.pathname.replace(/\/$/, "") && url.search === target.search)
        return link;
    } catch {}
  }
  return null;
}
