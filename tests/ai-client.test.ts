import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  draftKindForJobSource,
  generateDraft,
  generateWithChatCompletions,
} from "../src/agent/ai-client.ts";
import { cleanAiOutput, fillPromptTemplate } from "../src/agent/prompts.ts";
import { createDefaultAiSettings, migrateReplyPrompts } from "../src/domain/ai-settings.ts";
import { normalizeApiCampaign } from "../src/api/feed-adapter.ts";
import { sanitizeQueue, makeJob } from "../src/domain/agent-queue.ts";

const vars = { author: "author1", text: "We cut withdrawal fees from $5 to $1.", tweet_url: "https://x.com/author1/status/111", tweet_id: "111" };
const settings = { ...createDefaultAiSettings(), apiKey: "test-key" };
const good = "Cutting withdrawals to $1 makes smaller transfers less costly. Is that a permanent fee change or a temporary subsidy?";

function mockResponses(t: TestContext, replies: Array<string | number>) {
  const calls: Array<{ model: string; temperature?: number; max_tokens?: number; max_completion_tokens?: number; reasoning_effort?: string; messages: Array<{ role: string; content: string }> }> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const reply = replies.shift();
    assert.notEqual(reply, undefined, "unexpected extra AI call");
    if (typeof reply === "number") return new Response("error", { status: reply });
    return Response.json({ choices: [{ message: { content: reply }, finish_reason: "stop" }] });
  });
  return calls;
}

test("reply uses a separate editing pass with original text and writing instructions", async (t) => {
  const calls = mockResponses(t, ["Great news for everyone!", good]);
  assert.deepEqual(await generateDraft(settings, "reply", vars), { ok: true, text: good });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].messages[1].content.includes(vars.text));
  assert.ok(calls[1].messages[0].content.includes(settings.reply.systemPrompt));
});

test("browse_reply uses browseReply prompts, not Pogo reply prompts", async (t) => {
  const custom = {
    ...settings,
    browseReply: {
      ...settings.browseReply,
      systemPrompt: "BROWSE LIGHT ANALYSIS. Match post language. Never return SKIP.",
      userPromptTemplate: "Browse post {{text}}. Never return SKIP.",
      model: "browse-model-x",
    },
  };
  const calls = mockResponses(t, ["Nhẹ nhàng vậy cũng hay.", "Nhẹ nhàng vậy cũng hay."]);
  assert.deepEqual(await generateDraft(custom, "browse_reply", vars), {
    ok: true,
    text: "Nhẹ nhàng vậy cũng hay.",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "browse-model-x");
  assert.ok(calls[0].messages[0].content.includes("BROWSE LIGHT ANALYSIS"));
  assert.ok(!calls[0].messages[0].content.includes(settings.reply.systemPrompt.slice(0, 40)));
  assert.ok(calls[0].messages[0].content.includes("primary language"));
});

test("mention_reply uses mentionReply prompts, not browseReply", async (t) => {
  const custom = {
    ...settings,
    mentionReply: {
      ...settings.mentionReply,
      systemPrompt: "MENTION WARM REPLY. Match post language. Never return SKIP.",
      userPromptTemplate: "Mention post {{text}}. Never return SKIP.",
      model: "mention-model-z",
    },
  };
  const calls = mockResponses(t, ["Cảm ơn đã nhắc nhé.", "Cảm ơn đã nhắc nhé."]);
  assert.deepEqual(await generateDraft(custom, "mention_reply", vars), {
    ok: true,
    text: "Cảm ơn đã nhắc nhé.",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "mention-model-z");
  assert.ok(calls[0].messages[0].content.includes("MENTION WARM REPLY"));
  assert.ok(!calls[0].messages[0].content.includes(settings.browseReply.systemPrompt.slice(0, 40)));
  assert.ok(calls[0].messages[0].content.includes("natural tone"));
});

test("draftKindForJobSource routes mentions to mention_reply", () => {
  assert.equal(draftKindForJobSource("pogo"), "reply");
  assert.equal(draftKindForJobSource("browse", "home"), "browse_reply");
  assert.equal(draftKindForJobSource("browse", "following"), "browse_reply");
  assert.equal(draftKindForJobSource("browse", "lists"), "browse_reply");
  assert.equal(draftKindForJobSource("browse", "mentions"), "mention_reply");
  assert.equal(draftKindForJobSource("manual"), "browse_reply");
});

test("pogo reply uses reply.model when set", async (t) => {
  const custom = {
    ...settings,
    model: "global-model",
    reply: { ...settings.reply, model: "pogo-model-y" },
  };
  const calls = mockResponses(t, [good, good]);
  assert.deepEqual(await generateDraft(custom, "reply", vars), { ok: true, text: good });
  assert.equal(calls[0].model, "pogo-model-y");
});

test("SKIP is rewritten into a reply without skipping the task", async (t) => {
  const calls = mockResponses(t, ["SKIP", "SKIP", good]);
  assert.deepEqual(await generateDraft(settings, "reply", vars), { ok: true, text: good });
  assert.equal(calls.length, 3);
});

test("repeated invalid output fails after a bounded retry; SKIP is never returned as text", async (t) => {
  const calls = mockResponses(t, ["SKIP", "SKIP", "SKIP"]);
  assert.deepEqual(await generateDraft(settings, "reply", vars), { ok: false, error: "reply_quality_failed" });
  assert.equal(calls.length, 3);
});

for (const invalid of ["Great insight!", vars.text, "x".repeat(350)]) {
  test(`editor rewrites invalid output: ${invalid.slice(0, 24)}`, async (t) => {
    const calls = mockResponses(t, [good, invalid, good]);
    assert.deepEqual(await generateDraft(settings, "reply", vars), { ok: true, text: good });
    assert.equal(calls.length, 3);
    assert.ok(calls[2].messages[1].content.includes(invalid));
  });
}

test("editing API failure is reported without publishing the unchecked first draft", async (t) => {
  mockResponses(t, [good, 429]);
  assert.deepEqual(await generateDraft(settings, "reply", vars), { ok: false, error: "http_429" });
});

test("quote keeps its single-call behavior", async (t) => {
  const calls = mockResponses(t, [good]);
  assert.deepEqual(await generateDraft(settings, "quote", vars), { ok: true, text: good });
  assert.equal(calls.length, 1);
});

for (const kind of ["browse_reply", "mention_reply"] as const) {
  test(`${kind} honors SKIP_REPLY without an editing call`, async t => {
    const calls = mockResponses(t, ["SKIP_REPLY"]);
    assert.deepEqual(await generateDraft(settings, kind, vars), { ok: true, text: "", skipped: true });
    assert.equal(calls.length, 1);
  });
  test(`${kind} accepts a valid draft without a second call`, async t => {
    const calls = mockResponses(t, [good, "SKIP_REPLY"]);
    assert.deepEqual(await generateDraft(settings, kind, vars), { ok: true, text: good });
    assert.equal(calls.length, 1);
  });
}

test("Pogo rewrites SKIP_REPLY instead of silently skipping its task", async t => {
  mockResponses(t, ["SKIP_REPLY", "SKIP_REPLY", good]);
  assert.deepEqual(await generateDraft(settings, "reply", vars), { ok: true, text: good });
});

for (const replies of [["SKIP_REPLY", good], [good, "SKIP_REPLY", good]]) {
  test(`intentional Reply validates its first response (${replies[0]}) without another paid call`, async t => {
    const calls = mockResponses(t, [...replies]);
    const result = await generateDraft(settings, "browse_reply", vars, { allowSkip: false });
    assert.equal(result.ok, replies[0] === good);
    assert.equal(calls.length, 1);
    assert.ok(calls.every(c => c.messages[0].content.includes("EXPLICIT REPLY REQUEST")));
    assert.ok(calls.every(c => c.messages[0].content.includes("never return SKIP or SKIP_REPLY")));
  });
}

test("intentional Reply never publishes or silently skips repeated SKIP_REPLY output", async t => {
  const calls = mockResponses(t, ["SKIP_REPLY", "SKIP_REPLY", "SKIP_REPLY"]);
  assert.deepEqual(await generateDraft(settings, "browse_reply", vars, { allowSkip: false }), { ok: false, error: "reply_quality_failed", detail: "empty_or_skip" });
  assert.equal(calls.length, 1);
});

test("Mentions includes conversation context in one AI pass and permits a brief greeting", async t => {
  const calls = mockResponses(t, ["GM", "GM"]);
  const context = { ...vars, text: "GM", parent_text: "Our fees fell to $1.", conversation_context: "@owner: Our fees fell to $1." };
  assert.deepEqual(await generateDraft(settings, "mention_reply", context), { ok: true, text: "GM" });
  assert.equal(calls.length, 1);
  for (const call of calls) {
    assert.ok(call.messages[1].content.includes(context.parent_text));
    assert.ok(call.messages[1].content.includes(context.conversation_context));
  }
  assert.equal(fillPromptTemplate("{{parent_text}} / {{conversation_context}}", { ...context, parent_text: "$& {{text}}" }), "$& {{text}} / @owner: Our fees fell to $1.");
});

test("long original text survives API normalization, queue restore, and prompt filling", () => {
  const text = "Post detail. ".repeat(500) + "Important final qualification.";
  const campaign = normalizeApiCampaign({ tweet_id: "2112057695247180169", author_handle: "author1", text });
  assert.equal(campaign?.text, text);
  const job = makeJob({ kind: "draft_reply", tweetId: "111", authorHandle: "author1", tweetUrl: vars.tweet_url, tweetText: campaign!.text, source: "pogo" });
  const restored = sanitizeQueue({ jobs: [job] }).jobs[0];
  assert.equal(restored.tweetText, text);
  assert.ok(fillPromptTemplate(settings.reply.userPromptTemplate, { ...vars, text: restored.tweetText! }).includes(text));
});

test("template values are literal; post text cannot introduce placeholders or replacement tokens", () => {
  assert.equal(fillPromptTemplate("{{text}} / {{tweet_id}}", { ...vars, text: "$& {{tweet_id}}" }), "$& {{tweet_id}} / 111");
});

test("cleaning preserves full reply so the editor can shorten it instead of cutting a sentence", () => {
  const long = "This is a complete sentence. ".repeat(20);
  assert.equal(cleanAiOutput(long), long.trim());
});

test("custom prompts survive migration, even if they mention specificity or SKIP", () => {
  const custom = { ...settings, reply: { ...settings.reply, systemPrompt: "SPECIFICITY matters. Never return SKIP. My custom voice.", userPromptTemplate: "ORIGINAL POST {{text}}. Never return SKIP. My custom template." } };
  assert.deepEqual(migrateReplyPrompts(custom), custom);
});

for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.4"]) {
  test(`${model} uses reasoning-compatible parameters and respects the token budget`, async (t) => {
    const calls = mockResponses(t, [good]);
    await generateWithChatCompletions({ ...settings, model, maxTokens: 2048 }, "system", "post");
    assert.equal(calls[0].reasoning_effort, "low");
    assert.equal(calls[0].max_completion_tokens, 2048);
    assert.ok(!("max_tokens" in calls[0]));
    assert.ok(!("temperature" in calls[0]));
  });
}

for (const config of [settings, { ...settings, provider: "spacexai" as const, baseUrl: "https://api.x.ai/v1", model: "grok-4.7" }, { ...settings, provider: "custom" as const, baseUrl: "https://example.com/v1", model: "gpt-6.1-sol" }]) {
  test(`preserves existing parameter contract for ${config.baseUrl}/${config.model}`, async (t) => {
    const calls = mockResponses(t, [good]);
    await generateWithChatCompletions(config, "system", "post");
    assert.equal(calls[0].temperature, config.temperature);
    assert.equal(calls[0].max_tokens, config.maxTokens);
    assert.ok(!("reasoning_effort" in calls[0]));
  });
}

test("API error identifies the rejected parameter and redacts API keys", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "unsupported_parameter", param: "temperature", message: `temperature is unsupported. ${settings.apiKey} Bearer secret-value sk-another-secret` } }, { status: 400 }));
  const result = await generateDraft(settings, "reply", vars);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "http_400");
  assert.equal(result.configurationError, true);
  assert.ok(result.detail?.includes("temperature"));
  assert.ok(!result.detail?.includes(settings.apiKey));
  assert.ok(!result.detail?.includes("secret-value"));
  assert.ok(!result.detail?.includes("sk-another-secret"));
});

test("retries without temperature when model rejects it", async (t) => {
  let calls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (calls === 1) {
      return Response.json(
        { error: { code: "unsupported_parameter", param: "temperature", message: "Unsupported value: 'temperature'" } },
        { status: 400 },
      );
    }
    return Response.json({ choices: [{ message: { content: "Concrete take on the fee cut." }, finish_reason: "stop" }] });
  });
  const result = await generateWithChatCompletions(settings, "system", "post");
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.ok("temperature" in bodies[0]);
  assert.ok(!("temperature" in bodies[1]));
});

test("token exhaustion reports a token-budget issue without publishing partial content", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: "Partial sentence" }, finish_reason: "length" }] }));
  const result = await generateDraft({ ...settings, model: "gpt-6.1-sol" }, "reply", vars);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "incomplete_content");
  assert.equal(result.configurationError, true);
  assert.ok(result.detail?.includes("Max tokens"));
});
