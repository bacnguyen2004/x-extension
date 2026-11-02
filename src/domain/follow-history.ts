export interface FollowHistoryEntry {
  handle: string;
  status: "following" | "requested";
  verified: boolean | null;
  followsYou: boolean | null;
  sorsa: number | null;
  updatedAt: number | null;
}
