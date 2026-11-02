/** Work budgets and waits are operational pacing, independent of platform limits. */
export type RestReason = "high_load" | "normal_load" | "low_load" | "no_tasks" | "errors" | "daily_goal" | "session";
export interface AdaptiveRestState {
  activeMs: number;
  workCount: number;
  resumeAt: number | null;
  reason: RestReason | null;
  waitStartedAt: number | null;
  creditFrom: number | null;
  creditUntil: number | null;
}
const MINUTE = 60000;
export function restProfile(backlog: number, workCount: number) {
  if (backlog >= 20 || workCount >= 30) return { reason: "high_load" as const, workMs: 30 * MINUTE, restMs: 20 * MINUTE };
  if (backlog >= 5 || workCount >= 10) return { reason: "normal_load" as const, workMs: 45 * MINUTE, restMs: 15 * MINUTE };
  return { reason: "low_load" as const, workMs: 60 * MINUTE, restMs: 10 * MINUTE };
}
export function readAdaptiveRest(value: AdaptiveRestState | undefined, now: number): AdaptiveRestState {
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const state: AdaptiveRestState = {
    activeMs: finite(value?.activeMs) ? Math.min(value.activeMs, 86400000) : 0,
    workCount: finite(value?.workCount) ? Math.min(value.workCount, 100000) : 0,
    resumeAt: finite(value?.resumeAt) && value.resumeAt <= now + 86400000 ? value.resumeAt : null,
    reason: value?.reason && ["high_load", "normal_load", "low_load", "no_tasks", "errors", "daily_goal", "session"].includes(value.reason) ? value.reason : null,
    waitStartedAt: finite(value?.waitStartedAt) ? Math.min(value.waitStartedAt, now) : null,
    creditFrom: finite(value?.creditFrom) ? value.creditFrom : null,
    creditUntil: finite(value?.creditUntil) ? value.creditUntil : null,
  };
  // Credit only a previously scheduled productive pacing gap, never browser downtime.
  if (state.creditFrom != null && state.creditUntil != null) {
    state.activeMs += Math.max(0, Math.min(now, state.creditUntil) - state.creditFrom);
  }
  state.creditFrom = null; state.creditUntil = null;
  if (state.resumeAt != null && state.resumeAt <= now) {
    const periodic = ["high_load", "normal_load", "low_load"].includes(state.reason || "");
    const recovered = state.waitStartedAt != null && now - state.waitStartedAt >= restProfile(0, state.workCount).restMs;
    if (periodic || recovered) { state.activeMs = 0; state.workCount = 0; }
    state.resumeAt = null; state.reason = null;
    if (periodic || recovered) state.waitStartedAt = null;
  }
  return state;
}
export function waitForRest(state: AdaptiveRestState, reason: RestReason, resumeAt: number, now: number): AdaptiveRestState {
  // Replace the current wait. Never add a new duration onto an old deadline.
  return { ...state, reason, resumeAt, waitStartedAt: state.waitStartedAt ?? now, creditFrom: null, creditUntil: null };
}
export function periodicRest(state: AdaptiveRestState, backlog: number, now: number): AdaptiveRestState {
  if (state.resumeAt != null && state.resumeAt > now) return state;
  const profile = restProfile(backlog, state.workCount);
  return state.activeMs >= profile.workMs ? waitForRest(state, profile.reason, now + profile.restMs, now) : state;
}
export function recordActiveWork(state: AdaptiveRestState, elapsed: number, delay: number, now: number, units = 1): AdaptiveRestState {
  return { ...state, activeMs: state.activeMs + Math.max(0, Math.min(elapsed, 300000)), workCount: state.workCount + Math.max(0, units),
    resumeAt: null, reason: null, waitStartedAt: null,
    creditFrom: delay > 0 ? now : null, creditUntil: delay > 0 ? now + Math.min(delay, 120000) : null };
}
export function adaptiveErrorDelay(failures: number): number {
  return [1, 2, 5, 15][Math.min(3, Math.max(0, failures - 1))] * MINUTE;
}
export function idlePogoDelay(nextScanAt: number | null | undefined, now: number): number {
  return Math.max(5 * MINUTE, Math.min(10 * MINUTE, (nextScanAt ?? now + 10 * MINUTE) + 20000 - now));
}
export function restReasonLabel(reason: RestReason | null): string {
  return ({ high_load: "Tải cao", normal_load: "Tải bình thường", low_load: "Tải thấp", no_tasks: "Chưa có task phù hợp",
    errors: "Chờ phục hồi sau lỗi", daily_goal: "Đủ mục tiêu hôm nay", session: "Chờ phiên Pogo" })[reason || "no_tasks"];
}
