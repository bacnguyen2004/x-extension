import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildContentPrompts, contentIssue } from "../src/agent/content-policy.ts";
import { generateDraft } from "../src/agent/ai-client.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";
import type { PromptVars } from "../src/agent/prompts.ts";
import { fillPromptTemplate } from "../src/agent/prompts.ts";

const settings = { ...createDefaultAiSettings(), apiKey: "test-key" };
const vars: PromptVars = { author: "alice", text: "Withdrawal fees fell from $5 to $1.", tweet_id: "2112057695247180170", tweet_url: "https://x.com/alice/status/2112057695247180170" };
const good = "A $1 fee makes small transfers more practical, especially for people moving only a few dollars.";

for (const kind of ["browse_reply", "mention_reply", "quote", "post"] as const) {
  test(`${kind} accepts valid content in exactly one request and never truncates it`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ choices: [{ finish_reason: "stop", message: { content: good } }] }); });
    const config = { ...settings, post: { ...settings.post, enabled: true } };
    assert.deepEqual(await generateDraft(config, kind, vars), { ok: true, text: good });
    assert.equal(calls, 1);
  });
}

for (const source of ["", " \n ", "https://example.com", "@alice #news https://example.com", "📷"]) {
  test(`unusable source ${JSON.stringify(source)} is filtered without API`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call API"); });
    assert.deepEqual(await generateDraft(settings, "browse_reply", { ...vars, text: source }), { ok: true, text: "", skipped: true });
    assert.deepEqual(await generateDraft(settings, "browse_reply", { ...vars, text: source }, { allowSkip: false }), { ok: false, error: "source_text_missing" });
    assert.equal(calls, 0);
  });
}

test("confirmed feed duplicate is rejected before requesting a new draft, while unknown is not false evidence", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ choices: [{ message: { content: good } }] }); });
  assert.deepEqual(await generateDraft(settings, "browse_reply", { ...vars, already_replied: "true" }), { ok: true, text: "", skipped: true });
  assert.equal(calls, 0);
  assert.equal((await generateDraft(settings, "browse_reply", { ...vars, already_replied: "unknown" })).ok, true);
  assert.equal(calls, 1);
});

for (const [text, issue] of [
  ["Great insight!", "generic_praise"], [vars.text, "repeats_post"], ["a".repeat(281), "too_long"],
  ['{"reply":"unexpected JSON"}', "invalid_format"], ["- First idea\n- Second idea", "invalid_format"],
  ["Reply: This would help small transfers.", "invalid_format"],
  ["Lower fees help. #crypto #moon", "hashtag_spam"],
  ["Lower fees help. Lower fees help.", "repetitive_output"],
] as const) {
  test(`mechanical validation rejects ${issue} without a paid repair`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ choices: [{ message: { content: text } }] }); });
    assert.deepEqual(await generateDraft(settings, "browse_reply", vars), { ok: false, error: "reply_quality_failed", detail: issue });
    assert.equal(calls, 1);
  });
}

test("language, previous-response duplication, Unicode length and casual replies are checked locally", () => {
  assert.equal(contentIssue("This is the best choice for your team.", "Nhóm mình cần giảm số cuộc họp để có thời gian tập trung.", false), "wrong_language");
  assert.equal(contentIssue(good, vars.text, false, [good.toUpperCase()]), "duplicate_reply");
  assert.equal(contentIssue("GM", "GM", true), null);
  assert.equal(contentIssue("😀".repeat(281), vars.text, false), "too_long");
});

test("default request removes URLs/IDs, deduplicates repeated context and preserves the entire source", () => {
  const long = "A specific detail. ".repeat(500) + "Important final qualification: this is a trial, not a permanent change.";
  const prompts = buildContentPrompts(settings, "browse_reply", { ...vars, text: long, conversation_context: "@bob: A previous point.\n\n@bob: A previous point.\n\n@alice: Different speaker." });
  assert.ok(prompts.user.includes(long));
  assert.ok(!prompts.user.includes(vars.tweet_id));
  assert.ok(!prompts.user.includes(vars.tweet_url));
  assert.equal(prompts.user.split("@bob: A previous point.").length - 1, 1);
  assert.ok(prompts.user.includes("@alice: Different speaker."));
});

test("custom templates keep explicit URLs/IDs, source facts and literal replacement text", () => {
  const custom = { ...settings, browseReply: { ...settings.browseReply, systemPrompt: "Use my personal voice.", userPromptTemplate: "{{text}} / {{tweet_url}} / {{tweet_id}}" } };
  const prompts = buildContentPrompts(custom, "browse_reply", { ...vars, text: "$& {{tweet_id}}", parent_text: "A necessary parent qualification." });
  assert.ok(prompts.system.startsWith("Use my personal voice."));
  assert.ok(prompts.user.startsWith(`$& {{tweet_id}} / ${vars.tweet_url} / ${vars.tweet_id}`));
  assert.ok(prompts.user.includes("A necessary parent qualification."));
});

test("owner context is validated before the API and exact parent content is represented once", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call API"); });
  const owner = { owner: "owner", ownerPost: { author: "owner", tweetId: "2112057695247180169", text: "My generated avatar.", relationship: "parent" as const },
    comment: { author: vars.author, tweetId: vars.tweet_id, text: vars.text } };
  const prompts = buildContentPrompts(settings, "mention_reply", { ...vars, parent_text: owner.ownerPost.text }, { ownerPostReply: owner });
  assert.equal(prompts.user.split(owner.ownerPost.text).length - 1, 1);
  assert.deepEqual(JSON.parse(prompts.user).parent, { ref: "owner_post" });
  assert.deepEqual(await generateDraft(settings, "mention_reply", vars, { ownerPostReply: { ...owner, comment: { ...owner.comment, author: "wrong" } } }), { ok: false, error: "reply_context_invalid" });
  assert.equal(calls, 0);
});

test("Pogo bypasses optimized prefilters, system prompt and one-call policy", async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ choices: [{ message: { content: good } }] }); });
  assert.equal((await generateDraft(settings, "reply", vars)).ok, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].messages[0].content, settings.reply.systemPrompt);
  bodies.length = 0;
  assert.equal((await generateDraft(settings, "quote", vars, { preservePogo: true })).ok, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].messages[0].content, settings.quote.systemPrompt);
  assert.equal(bodies[0].messages[1].content, fillPromptTemplate(settings.quote.userPromptTemplate, vars));
});

test("Pogo generation body remains identical to the captured original implementation", () => {
  const before = readFileSync(new URL("../fixtures/token-optimization/ai-client.before.txt", import.meta.url), "utf8");
  const after = readFileSync(new URL("../src/agent/ai-client.ts", import.meta.url), "utf8");
  const original = before.slice(before.indexOf("export async function generateDraft("));
  const preserved = after.slice(after.indexOf("async function generatePogoDraft("), after.lastIndexOf("export async function generateDraft(")).trim();
  assert.equal(preserved, original.replace("export async function generateDraft(", "async function generatePogoDraft(").trim());
});
