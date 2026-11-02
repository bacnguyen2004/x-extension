import type { AgentSettings } from "../domain/agent-settings.ts";
import { makeJob, type AgentJob, type AgentQueueState } from "../domain/agent-queue.ts";
import { NOTIFICATION_BATCH_LIMIT } from "../domain/notification-batch.ts";
import type { TimelineTweet } from "../x/timeline.ts";
import { alreadyTracked, tweetUnreachable } from "./planner.ts";

export function selectNotificationDrafts(input: {
  candidates: TimelineTweet[]; settings: AgentSettings; queue: AgentQueueState; seenIds: string[];
  account: string; batchId: string; rng?: () => number;
}): AgentJob[] {
  const own = input.account.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(own) || !input.settings.executeActions || !input.settings.actions.reply) return [];
  const room = NOTIFICATION_BATCH_LIMIT;
  const eligible = input.candidates.filter(c => !c.promoted && c.authorHandle.toLowerCase() !== own &&
    c.notificationKind === 'direct' && !input.seenIds.includes(c.tweetId) &&
    !isLowValueNotification(c.text, own) &&
    !tweetUnreachable(input.queue, c.tweetId) && !alreadyTracked(input.queue, 'draft_reply', c.tweetId) && !alreadyTracked(input.queue, 'post_reply', c.tweetId));
  // Handle direct replies first; notification visits do not use feed probabilities.
  const priority = (c: TimelineTweet) => (c.notificationType === "reply" ? 10 : 0) + (/[?？]|\b(?:how|why|what|which|when|where|can you|could you)\b|tại sao|như thế nào/i.test(c.text || "") ? 2 : 0);
  eligible.sort((a, b) => priority(b) - priority(a));
  const result: AgentJob[] = [], selected = new Set<string>(), conversations = new Set<string>();
  for (const c of eligible) {
    if (result.length >= room) break;
    if (selected.has(c.tweetId)) continue;
    if (c.conversationId && conversations.has(c.conversationId)) continue;
    selected.add(c.tweetId);
    if (c.conversationId) conversations.add(c.conversationId);
    result.push(makeJob({ kind: 'draft_reply', source: 'browse', browseSurface: 'mentions', expectedAccount: own,
      notificationKind: c.notificationKind, notificationBatchId: input.batchId,
      tweetId: c.tweetId, tweetUrl: c.tweetUrl, authorHandle: c.authorHandle, tweetText: c.text,
      reason: c.notificationKind === 'direct' ? 'Thông báo: phản hồi trực tiếp' : 'Thông báo: bài mới từ chuông' }));
  }
  return result;
}

/** Unknown card text is read after opening; greetings/engagement bait need no AI request. */
export function isLowValueNotification(text: string | null, own: string): boolean {
  if (text == null) return false;
  const clean = text.replace(/@[a-z0-9_]+/gi, "").replace(/[\p{P}\p{S}]/gu, " ").trim().toLowerCase();
  return !clean || /^(?:hi|hello|hey|gm|gn|good morning|good night|nice|great|awesome|thanks|thank you|lfg|wagmi|xin chào|chào bạn|cảm ơn)(?:\s+(?:bro|sir|friend|ser|you|too|everyone))*$/.test(clean) ||
    /\b(?:follow me|follow back|follow for follow|check my profile|dm me for|claim your airdrop)\b/i.test(clean);
}
