/** Cuộn có kiểm soát trên timeline X. */

export interface ScrollBurstOptions {
  /** Tổng px muốn cuộn xuống. */
  distancePx: number;
  /** Số bước nhỏ trong một burst. */
  steps: number;
  /** Delay giữa các bước (ms). */
  stepDelayMs: number;
}

export interface ScrollTarget {
  scrollBy(options: { top: number; behavior?: ScrollBehavior }): void;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  scrollY?: number;
}

export function isLikelyScrollable(el: {
  scrollHeight?: number;
  clientHeight?: number;
}): boolean {
  const sh = el.scrollHeight ?? 0;
  const ch = el.clientHeight ?? 0;
  return sh > ch + 40;
}

/**
 * X thường cuộn ở window / primaryColumn, không phải main.
 * Trả về danh sách target theo thứ tự ưu tiên.
 */
export function pickScrollRoots(
  doc: Document,
  win: ScrollTarget | null = typeof window !== "undefined" ? (window as unknown as ScrollTarget) : null,
): ScrollTarget[] {
  const out: ScrollTarget[] = [];
  const push = (t: ScrollTarget | null | undefined) => {
    if (!t || typeof t.scrollBy !== "function") return;
    if (!out.includes(t)) out.push(t);
  };

  const primary = doc.querySelector('[data-testid="primaryColumn"]') as HTMLElement | null;
  if (primary) {
    // Tìm con overflow trong cột chính.
    const nodes = primary.querySelectorAll("div");
    let best: HTMLElement | null = null;
    let bestDelta = 0;
    for (const n of nodes) {
      const style = win && "getComputedStyle" in globalThis ? getComputedStyle(n) : null;
      const overflowY = style?.overflowY ?? "";
      if (overflowY === "auto" || overflowY === "scroll" || (!style && isLikelyScrollable(n))) {
        const delta = (n.scrollHeight || 0) - (n.clientHeight || 0);
        if (delta > bestDelta) {
          bestDelta = delta;
          best = n;
        }
      }
    }
    if (best) push(best);
    const primaryStyle = typeof getComputedStyle === "function" ? getComputedStyle(primary).overflowY : "";
    if (!primaryStyle || primaryStyle === "auto" || primaryStyle === "scroll") push(primary);
  }

  const main = doc.querySelector('main[role="main"]') as HTMLElement | null;
  const mainStyle = main && typeof getComputedStyle === "function" ? getComputedStyle(main).overflowY : "";
  if (!mainStyle || mainStyle === "auto" || mainStyle === "scroll") push(main);
  push(doc.scrollingElement as ScrollTarget | null);
  push(doc.documentElement as unknown as ScrollTarget);
  push(doc.body as unknown as ScrollTarget);
  push(win);

  return out;
}

export function pickScrollRoot(
  doc: Document,
  win: ScrollTarget | null = typeof window !== "undefined" ? (window as unknown as ScrollTarget) : null,
): ScrollTarget | null {
  const roots = pickScrollRoots(doc, win);
  return roots.find((r) => isLikelyScrollable(r)) || roots[0] || null;
}

export function planScrollBurst(
  distancePx: number,
  steps = 3,
): { perStep: number; steps: number } {
  const s = Math.max(1, Math.min(8, Math.round(steps)));
  const dist = Math.max(80, Math.min(2400, Math.round(distancePx)));
  return { perStep: Math.round(dist / s), steps: s };
}

/** Use one working root per step; extras are fallbacks, not extra scrolls. */
export async function runScrollBurst(
  root: ScrollTarget,
  opts: ScrollBurstOptions,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  extras: ScrollTarget[] = [],
  isStopped: () => boolean = () => false,
): Promise<number> {
  const plan = planScrollBurst(opts.distancePx, opts.steps);
  let total = 0;
  const targets = [root, ...extras.filter((t) => t !== root)];
  let active: ScrollTarget | null = null;
  const position = (target: ScrollTarget) => {
    const value = typeof target.scrollY === "number" ? target.scrollY : target.scrollTop;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  for (let i = 0; i < plan.steps; i++) {
    if (isStopped()) break;
    let stepMoved = false;
    const stepTargets: ScrollTarget[] = active ? [active, ...targets.filter((t) => t !== active)] : targets;
    for (const t of stepTargets) {
      if (isStopped()) return total;
      try {
        const before = position(t);
        // auto = đáng tin hơn smooth (smooth hay bị X nuốt / chậm).
        t.scrollBy({ top: plan.perStep, behavior: "auto" });
        let after = position(t);
        const settleDeadline = Date.now() + 800;
        // Rendering/compositor work can apply scroll after scrollBy returns.
        // Measure again before trying an alias of the same document scroll root.
        for (let elapsed = 0; before != null && after === before && elapsed < 800 && Date.now() < settleDeadline; elapsed += 100) {
          if (isStopped()) return total;
          await wait(100);
          if (isStopped()) return total;
          after = position(t);
        }
        const moved = before != null && after != null ? Math.max(0, after - before) : plan.perStep;
        if (moved > 0) { total += moved; active = t; stepMoved = true; break; }
      } catch {
        // ignore
      }
    }
    if (!stepMoved) break;
    if (i < plan.steps - 1) await wait(opts.stepDelayMs);
  }
  return total;
}
