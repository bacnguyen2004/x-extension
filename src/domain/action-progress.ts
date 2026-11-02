import type { ActionState } from "./types.ts";

export function actionHandled(action: ActionState): boolean {
  return action.status === "recorded" || !!action.local;
}

export function actionProgressLabel(action: ActionState): string {
  if (action.status === "recorded") return `Pogo đã ghi nhận${action.displayedPoints != null ? ` · ${action.displayedPoints} điểm` : ""}`;
  if (action.local?.state === "confirmed") return "Đã gửi";
  if (action.local?.state === "submitted") return "Đã gửi";
  if (action.local?.state === "uncertain") return "Đã bỏ qua";
  if (action.local?.state === "blocked") return "Đã bỏ qua · X không cho thực hiện";
  return action.status === "unknown" ? "Chưa rõ" : "Chưa thực hiện";
}
