import { isHandle, isTweetId } from "./url.ts";

export interface OwnerPost {
  author: string;
  tweetId: string;
  text: string;
  relationship: "parent" | "thread_context";
}
export interface OwnerPostReply {
  owner: string;
  ownerPost: OwnerPost;
  comment: { author: string; tweetId: string; text: string };
}
export function sanitizeOwnerPost(raw: unknown): OwnerPost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Partial<OwnerPost>;
  return typeof p.author === "string" && isHandle(p.author) && typeof p.tweetId === "string" && isTweetId(p.tweetId) &&
    typeof p.text === "string" && p.text.trim() && (p.relationship === "parent" || p.relationship === "thread_context")
    ? { author: p.author, tweetId: p.tweetId, text: p.text.slice(0, 4000), relationship: p.relationship } : undefined;
}
export function ownerPostReplyContext(raw: unknown, owner: string, comment: OwnerPostReply["comment"]): OwnerPostReply | undefined {
  const post = sanitizeOwnerPost(raw);
  const own = owner.replace(/^@/, "").toLowerCase();
  return post && isHandle(own) && post.author.toLowerCase() === own && isHandle(comment.author) && comment.author.toLowerCase() !== own &&
    isTweetId(comment.tweetId) && comment.tweetId !== post.tweetId && comment.text.trim()
    ? { owner: own, ownerPost: post, comment } : undefined;
}
