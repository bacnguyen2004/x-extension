import { generateDraft } from "../agent/ai-client.ts";
import type { AiSettings } from "../domain/ai-settings.ts";
import { readReplyAttempt } from "../x/reply-history.ts";
import { ownerPostReplyContext } from "../domain/reply-conversation.ts";

export async function generateManualReply(settings: AiSettings, payload: Record<string, unknown>, account: string | null) {
  const field = (key: string, limit: number) => typeof payload[key] === "string" ? (payload[key] as string).slice(0, limit) : "";
  const own = (account || "").replace(/^@/, "").toLowerCase();
  const sameAccount = !!own && field("own_handle", 16).toLowerCase() === own;
  if (payload.owner_post && !sameAccount) return { ok: false as const, error: "reply_identity_mismatch" };
  const commentAuthor = field("author", 100);
  const ownerPostReply = sameAccount ? ownerPostReplyContext(payload.owner_post, own, { author: commentAuthor, tweetId: field("tweet_id", 22), text: field("text", 20000) }) : undefined;
  if (payload.owner_post && !ownerPostReply) return { ok: false as const, error: "reply_context_invalid" };
  const mention = sameAccount && (payload.reply_mode === "mention_reply" || !!ownerPostReply);
  if (sameAccount && payload.already_replied === "true") return { ok: false as const, error: "already_replied" };
  if (own && typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const evidence = await readReplyAttempt(field("tweet_id", 22), own);
      if (evidence) return { ok: false as const, error: evidence.state === "confirmed" ? "already_replied" : "reply_attempt_exists" };
    } catch { return { ok: false as const, error: "reply_history_unavailable" }; }
  }
  const context = field("conversation_context", 6000);
  const parent = field("parent_text", 4000);
  const replyMode = mention ? "mention_reply" : "browse_reply";
  const result = await generateDraft(settings, replyMode, {
    author: field("author", 100), text: field("text", 20000), tweet_url: field("tweet_url", 2000), tweet_id: field("tweet_id", 22),
    parent_text: parent, conversation_context: `${mention ? `Current account receiving the mention: @${own}.\n` : ""}${context}`,
    already_replied: "unknown",
  }, { allowSkip: false, groundingReview: !!(ownerPostReply || parent.trim() || context.trim()), ownerPostReply });
  return result.ok ? { ...result, replyMode } : result;
}
