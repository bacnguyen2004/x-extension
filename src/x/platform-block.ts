/** Scope limits to account routes and system alerts, never tweet/profile text. */
export function detectXPlatformBlock(doc: Pick<Document, "querySelectorAll">, path: string): string | null {
  if (/^\/(?:account\/access|i\/flow\/(?:challenge|login)|login)(?:\/|$)/i.test(path)) return "x_account_requires_attention";
  for (const alert of doc.querySelectorAll('[role="alert"], [data-testid="toast"]')) {
    if (alert.closest('article, [data-testid="UserCell"]')) continue;
    if (alert.closest('[hidden], [aria-hidden="true"]')) continue;
    if (/rate limit exceeded|you(?:'ve| have) reached (?:your |the )?(?:daily |follow |following )?limit|bạn đã đạt giới hạn/i.test(alert.textContent || "")) return "x_rate_limited";
  }
  return null;
}
