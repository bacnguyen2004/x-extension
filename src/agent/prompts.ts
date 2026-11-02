export interface PromptVars {
  author: string;
  text: string;
  tweet_url: string;
  tweet_id: string;
  parent_text?: string;
  conversation_context?: string;
  already_replied?: string;
  /** Explicit prior reply texts supplied by the caller, never inferred from an unlabeled thread. */
  previous_replies?: readonly string[];
}

export function fillPromptTemplate(template: string, vars: PromptVars): string {
  return template.replace(/\{\{(author|text|tweet_url|tweet_id|parent_text|conversation_context|already_replied)\}\}/g, (_match, key: Exclude<keyof PromptVars, "previous_replies">) =>
    vars[key] || (key === "author" || key === "already_replied" ? "unknown" : ""),
  );
}

export function cleanAiOutput(raw: string): string {
  let t = raw.trim();
  // Bỏ fence markdown nếu có.
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  // Cắt quote bao ngoài.
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Mechanical checks only; relevance and substance are checked in the editing pass. */
export function replyIssue(reply: string, post: string, conversational = false): string | null {
  if (isAiSkip(reply)) return "empty_or_skip";
  if (Array.from(reply).length > 280) return "too_long";
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const normalized = normalize(reply);
  if (!normalized) return "empty_content";
  const greeting = conversational && /^(gm|gn|hello|hi|hey|thanks|thank you|haha|chào|cảm ơn|早安|谢谢)$/.test(normalized);
  if (normalized === normalize(post) && !greeting) return "repeats_post";
  if (/^(great (post|insight|news)|well said|absolutely agree|this is huge|game changer|interesting perspective|couldn t agree more|exciting times ahead|the future is bright|this is the way)( indeed| absolutely| thanks| thank you)?$/.test(normalized)) {
    return "generic_praise";
  }
  return null;
}

/**
 * Detect an invalid SKIP placeholder so it is rewritten, never published.
 */
export function isAiSkip(text: string): boolean {
  const t = text.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!t) return true;
  if (isSkipReply(t)) return true;
  if (/^SKIP\.?$/i.test(t)) return true;
  // Một dòng duy nhất bắt đầu bằng SKIP (tránh false positive trong câu dài).
  if (/^SKIP\b/i.test(t) && t.length <= 24 && !/\s{2,}|\n/.test(t.slice(4))) {
    return true;
  }
  return false;
}

export function isSkipReply(text: string): boolean {
  return /^SKIP_REPLY[.!]?$/i.test(cleanAiOutput(text));
}
