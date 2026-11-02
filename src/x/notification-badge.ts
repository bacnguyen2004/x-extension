/** Read the Notifications badge only, never numbers elsewhere in the page. */
export function readNotificationBadge(doc: Document): number | null {
  const link = doc.querySelector('[data-testid="AppTabBar_Notifications_Link"]') || doc.querySelector('nav a[href="/notifications"]');
  if (!link) return null;
  for (const el of [link, ...link.querySelectorAll('[aria-label], span')]) {
    const label = el.getAttribute('aria-label') || '';
    const match = label.match(/(\d[\d,.]*)(?:\+)?\s*(?:unread|new|notification|thông báo|mục chưa đọc)/i) ||
      label.match(/(?:unread|notifications?|thông báo)[^\d]{0,20}(\d[\d,.]*)/i);
    const text = (el.textContent || '').trim();
    const raw = match?.[1] || (/^\d{1,4}\+?$/.test(text) ? text : '');
    if (raw) return Math.min(9999, Number(raw.replace(/[^\d]/g, '')));
  }
  // An unnumbered dot is not a verified numeric count.
  if ([...link.querySelectorAll('[aria-label]')].some(el => /unread|new|mới|chưa đọc/i.test(el.getAttribute('aria-label') || ''))) return null;
  return 0;
}
