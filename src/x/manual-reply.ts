import { detectXIdentity } from "./identity.ts";
import { isDirectMention, readConversationContext, readTweetArticle, readOwnRepliesToTweet } from "./timeline.ts";
import type { OwnerPost } from "../domain/reply-conversation.ts";

export interface ManualReplyPayload {
  author: string; text: string; tweet_url: string; tweet_id: string;
  reply_mode: "browse_reply" | "mention_reply"; own_handle: string;
  parent_text: string; conversation_context: string;
  already_replied: "true" | "unknown";
  owner_post?: OwnerPost;
}
export function readManualReplyRequest(button: Element, doc: Document, pathname: string): ManualReplyPayload | null {
  const article = button.closest('article[data-testid="tweet"]');
  if (!article) return null;
  const tweet = readTweetArticle(article);
  if (!tweet) return null;
  const own = detectXIdentity(doc, pathname).handle || "";
  const context: ReturnType<typeof readConversationContext> = /^\/[A-Za-z0-9_]+\/status\/\d+(?:\/|$)/.test(pathname)
    ? readConversationContext(doc, tweet.tweetId, own) : { parentText: "", conversationContext: "" };
  const replyingInOwnThread = !!context.ownerPost && tweet.author.toLowerCase() !== own.toLowerCase();
  const ownReplies = readOwnRepliesToTweet(doc, tweet.tweetId, own);
  return { author: tweet.author, text: tweet.text, tweet_url: tweet.tweetUrl, tweet_id: tweet.tweetId,
    reply_mode: isDirectMention(article, own) || replyingInOwnThread ? "mention_reply" : "browse_reply", own_handle: own,
    ...(replyingInOwnThread ? { owner_post: context.ownerPost } : {}),
    parent_text: context.parentText,
    already_replied: ownReplies.length ? "true" : "unknown",
    conversation_context: `${context.conversationContext}${ownReplies.length ? `\nCONFIRMED OWN REPLIES TO THIS EXACT MESSAGE:\n${ownReplies.slice(-3).map(p => `@${own} (#${p.tweetId}): ${p.text}`).join('\n')}` : ''}`.slice(0, 6000) };
}
