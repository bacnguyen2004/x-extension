import { sleep } from "./dom-utils.ts";
import { ActionDeadlineError, assertActionActive } from "./action-control.ts";

export function createPagePause(readPage: () => string, wait = sleep, random = Math.random) {
  let settledPage: string | undefined;
  return async () => {
    assertActionActive();
    const deadline = Date.now() + 15000;
    let changes = 0;
    while (settledPage !== readPage()) {
      if (Date.now() >= deadline || changes++ >= 3) throw new ActionDeadlineError();
      const page = readPage();
      await wait(3000 + Math.floor(random() * 2001));
      assertActionActive();
      if (Date.now() >= deadline) throw new ActionDeadlineError();
      // A redirect or tab change during the pause needs its own pause.
      if (readPage() === page) settledPage = page;
    }
  };
}

export const pauseAfterPageChange = createPagePause(() => {
  const root = document.querySelector('[data-testid="primaryColumn"]') ?? document;
  const selected = root.querySelector('[role="tab"][aria-selected="true"], [role="tab"][data-selected="true"]');
  return `${location.href}|${selected?.getAttribute("aria-label") || selected?.textContent?.trim() || ""}`;
});
