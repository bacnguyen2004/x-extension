import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProviderPreset,
  createDefaultAiSettings,
  DEFAULT_REPLY_SYSTEM,
  migrateReplyPrompts,
  maskApiKey,
  resolveFeatureModel,
  sanitizeAiSettings,
  toPublicAiSettings,
} from "../src/domain/ai-settings.ts";

test("default AI settings prefer OpenAI GPT", () => {
  const s = createDefaultAiSettings();
  assert.equal(s.provider, "openai");
  assert.equal(s.baseUrl, "https://api.openai.com/v1");
  assert.equal(s.model, "gpt-4o-mini");
  assert.equal(s.temperature, 0.7);
  assert.equal(s.maxTokens, 300);
  assert.equal(s.reply.enabled, true);
  assert.ok(s.reply.systemPrompt.includes("Never return SKIP") || s.reply.systemPrompt.includes("No SKIP"));
  assert.ok(s.reply.userPromptTemplate.includes("{{author}}"));
  assert.ok(s.reply.userPromptTemplate.includes("{{text}}"));
  assert.ok(s.reply.userPromptTemplate.includes("{{tweet_url}}"));
  assert.ok(s.reply.userPromptTemplate.includes("{{tweet_id}}"));
  assert.equal(s.browseReply.enabled, true);
  assert.ok(s.browseReply.systemPrompt.includes("post's language"));
  assert.ok(s.browseReply.systemPrompt.includes("15–45"));
  assert.notEqual(s.browseReply.systemPrompt, s.reply.systemPrompt);
  assert.equal(s.mentionReply.enabled, true);
  assert.ok(s.mentionReply.systemPrompt.includes("current incoming message's primary language"));
  assert.ok(s.mentionReply.userPromptTemplate.includes("{{conversation_context}}"));
  assert.notEqual(s.mentionReply.systemPrompt, s.browseReply.systemPrompt);
  assert.equal(s.quote.enabled, true);
  assert.equal(s.post.enabled, false);
});

test("sanitize fills browseReply and mentionReply defaults without touching reply", () => {
  const s = sanitizeAiSettings({
    provider: "openai",
    reply: {
      enabled: true,
      systemPrompt: "CUSTOM POGO REPLY",
      userPromptTemplate: "pogo {{text}}",
    },
  });
  assert.equal(s.reply.systemPrompt, "CUSTOM POGO REPLY");
  assert.equal(s.browseReply.enabled, true);
  assert.ok(s.browseReply.systemPrompt.includes("post's language"));
  assert.equal(s.mentionReply.enabled, true);
  assert.ok(s.mentionReply.systemPrompt.includes("current incoming message's primary language"));
  assert.equal(s.reply.model, "");
  assert.equal(s.browseReply.model, "");
  assert.equal(s.mentionReply.model, "");
});

test("resolveFeatureModel falls back to global model", () => {
  const s = createDefaultAiSettings();
  s.model = "gpt-4o-mini";
  s.reply.model = "";
  s.browseReply.model = "grok-4.7";
  s.mentionReply.model = "mention-model-z";
  assert.equal(resolveFeatureModel(s, s.reply), "gpt-4o-mini");
  assert.equal(resolveFeatureModel(s, s.browseReply), "grok-4.7");
  assert.equal(resolveFeatureModel(s, s.mentionReply), "mention-model-z");
});

test("migrateReplyPrompts upgrades legacy Vietnamese reply prompts", () => {
  const s = createDefaultAiSettings();
  s.reply.systemPrompt =
    "Bạn viết reply ngắn trên X/Twitter. Giọng tự nhiên, không spam, không lộ là bot. Tiếng Anh trừ khi bài gốc tiếng Việt.";
  s.reply.userPromptTemplate =
    "Bài gốc (@{{author}}):\n{{text}}\n\nViết nội dung phù hợp. Chỉ trả về text đăng, không giải thích.";
  const next = migrateReplyPrompts(s);
  assert.equal(next.reply.systemPrompt, DEFAULT_REPLY_SYSTEM);
  assert.ok(next.reply.userPromptTemplate.includes("Original post"));
});

test("public settings hide api key", () => {
  const s = createDefaultAiSettings();
  s.apiKey = "sk-abcdefghijklmnop";
  const pub = toPublicAiSettings(s);
  assert.equal(pub.hasApiKey, true);
  assert.equal(pub.apiKeyMasked, maskApiKey(s.apiKey));
  assert.equal("apiKey" in pub, false);
});

test("Mentions migrates a known old context template and preserves custom system instructions", () => {
  const s = createDefaultAiSettings();
  s.mentionReply.systemPrompt = "CUSTOM OWNER VOICE";
  s.mentionReply.userPromptTemplate = `Mention author: {{author}}
Mention to answer:
{{text}}
Parent post (empty means unavailable):
{{parent_text}}
Earlier conversation (empty means unavailable):
{{conversation_context}}
Post URL: {{tweet_url}}
Tweet ID: {{tweet_id}}
Reply directly in the mention's language. Use only supported facts; if essential context is missing, return SKIP_REPLY.`;
  const migrated = migrateReplyPrompts(s);
  assert.equal(migrated.mentionReply.systemPrompt, "CUSTOM OWNER VOICE");
  assert.ok(migrated.mentionReply.userPromptTemplate.includes("{{already_replied}}"));
  s.mentionReply.userPromptTemplate = "Custom request for {{text}}";
  assert.equal(migrateReplyPrompts(s).mentionReply.userPromptTemplate, "Custom request for {{text}}");
});

test("sanitize clamps and applies provider preset fields", () => {
  const s = sanitizeAiSettings({
    provider: "spacexai",
    apiKey: "xai-test",
    baseUrl: "",
    model: "",
    temperature: 9,
    maxTokens: 10,
  });
  assert.equal(s.provider, "spacexai");
  assert.equal(s.baseUrl, "https://api.x.ai/v1");
  assert.equal(s.model, "grok-4.7");
  assert.equal(s.temperature, 2);
  assert.equal(s.maxTokens, 32);
});

test("applyProviderPreset keeps api key", () => {
  const s = createDefaultAiSettings();
  s.apiKey = "sk-keep";
  const next = applyProviderPreset(s, "spacexai");
  assert.equal(next.apiKey, "sk-keep");
  assert.equal(next.provider, "spacexai");
  assert.equal(next.model, "grok-4.7");
});
