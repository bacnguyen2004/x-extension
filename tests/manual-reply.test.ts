import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { readManualReplyRequest } from "../src/x/manual-reply.ts";
import { generateManualReply } from "../src/background/manual-reply.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";
import { generateDraft } from "../src/agent/ai-client.ts";
import { fillPromptTemplate } from "../src/agent/prompts.ts";
import { sanitizeQueue, makeJob } from "../src/domain/agent-queue.ts";

const parentId = "2112057695247180169", targetId = "2112057695247180170";
function completion(body: any, text: string | undefined) {
  const roles = body.messages[0].content.match(/Write AS @([^,]+), TO @([^ .]+)/);
  const content = body.messages[0].content.includes("Return only JSON:") && text !== "SKIP_REPLY"
    ? JSON.stringify({ reply: text, correct_recipient: true, correct_attribution: true, unsupported_visual_claims: false,
        responding_as: roles?.[1], responding_to: roles?.[2], correct_perspective: true, intent_consistent: true }) : text;
  return Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
}
function post(author: string, id: string, text: string, extra = "") {
  return `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${author}">${author}</a></div><a href="/${author}/status/${id}"><time></time></a>${extra}<div data-testid="tweetText">${text}</div><button data-testid="reply" data-post="${id}"></button></article>`;
}
function payload(body: string, path = `/henry/status/${targetId}`, identity = true) {
  const { document } = parseHTML(`${identity ? '<a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a>' : ''}<main>${body}</main>`);
  return readManualReplyRequest(document.querySelector(`button[data-post="${targetId}"]`)!, document as unknown as Document, path)!;
}

test("one manual Reply request detects direct interaction and preserves visible thread context", () => {
  const parent = post("owner", parentId, "My Muse version was made with Kite Agent Passport. Same hoodie energy.");
  const target = post("henry", targetId, "new profile pic", '<div>Replying to <a href="/owner">@owner</a></div>');
  const p = payload(parent + target);
  assert.equal(p.reply_mode, "mention_reply");
  assert.equal(p.own_handle, "owner");
  assert.equal(p.text, "new profile pic");
  assert.equal(p.parent_text, "", "a profile link cannot establish an exact parent ID");
  assert.match(p.conversation_context, /Kite Agent Passport/);
  assert.equal(p.author, "henry");
  assert.equal(p.tweet_id, targetId);
  const linked = payload(parent + post("henry", targetId, "new profile pic", `<a href="/owner/status/${parentId}">Reply to original</a>`));
  assert.equal(linked.reply_mode, "mention_reply");
  assert.match(linked.parent_text, /Kite Agent Passport/);
});

test("manual routing excludes unrelated feed posts, quoted mentions, unknown identity and own posts", () => {
  assert.equal(payload(post("henry", targetId, "Hi @owner")).reply_mode, "mention_reply");
  assert.equal(payload(post("henry", targetId, "Hi @owner_else")).reply_mode, "browse_reply");
  assert.equal(payload(post("henry", targetId, "Hello", post("bob", "2112057695247180171", "Hi @owner"))).reply_mode, "browse_reply");
  assert.equal(payload(post("owner", targetId, "Hi @owner")).reply_mode, "browse_reply");
  assert.equal(payload(post("henry", targetId, "Hi @owner"), "/home", false).reply_mode, "browse_reply");
  const feed = payload(post("bob", parentId, "Unrelated prior feed post") + post("henry", targetId, "Hi @owner"), "/home");
  assert.equal(feed.conversation_context, "", "Home feed order is not conversation context");
});

test("manual button selects the article's own ID and never borrows a quote or text link", () => {
  const p = payload(post("henry", targetId, 'new profile pic <a href="/henry/status/2112057695247180188">earlier post</a>', post("bob", "2112057695247180171", "quoted text")));
  assert.equal(p.tweet_id, targetId);
  assert.ok(!p.text.includes("quoted text"));
  assert.equal(p.tweet_url, `https://x.com/henry/status/${targetId}`);
});

test("manual Mentions uses its custom prompt/model and checks grounding in one response", async t => {
  const settings = createDefaultAiSettings(); settings.apiKey = "fake-key";
  settings.browseReply.enabled = false;
  settings.mentionReply = { ...settings.mentionReply, systemPrompt: "CUSTOM MENTIONS: Reply naturally. Return SKIP_REPLY if context is insufficient.", userPromptTemplate: "Author: {{author}}. Message: {{text}}", model: "mention-model" };
  const p = payload(post("owner", parentId, "Made with Kite Agent Passport.") + post("henry", targetId, "new profile pic", '<a href="/owner">@owner</a>'));
  const good = "Do you mean using the Muse version as a profile pic?";
  const replies = [good];
  const calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push(body);
    assert.equal(body.model, "mention-model");
    assert.match(body.messages[0].content, /CUSTOM MENTIONS/);
    assert.match(body.messages[0].content, /EXPLICIT REPLY REQUEST/);
    assert.match(body.messages[0].content, /never return SKIP or SKIP_REPLY/);
    assert.match(body.messages[1].content, /Made with Kite Agent Passport/);
    assert.match(body.messages[1].content, /new profile pic/);
    return completion(body, replies.shift());
  });
  assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: true, text: good, replyMode: "mention_reply" });
  assert.equal(calls.length, 1);
});

test("a reply to an owner's post does not silently fall back to News Feed when account identity mismatches", async t => {
  const settings = createDefaultAiSettings(); settings.apiKey = "fake-key";
  settings.browseReply.model = "feed-model"; settings.mentionReply.model = "mention-model";
  const p = payload(post("owner", parentId, "Made with Kite Agent Passport.") + post("henry", targetId, "new profile pic", '<a href="/owner">@owner</a>'));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls++;
    assert.equal(body.model, "feed-model");
    assert.match(body.messages[1].content, /Made with Kite Agent Passport/);
    return completion(body, "Do you mean using the Muse version as a profile pic?");
  });
  assert.deepEqual(await generateManualReply(settings, { ...p }, "other_account"), { ok: false, error: "reply_identity_mismatch" });
  assert.deepEqual(await generateManualReply(settings, { ...p }, null), { ok: false, error: "reply_identity_mismatch" });
  assert.equal(calls, 0);
});

test("visible previous replies require evidence for the exact parent, not merely thread proximity", () => {
  const target = post("henry", targetId, "new profile pic", '<a href="/owner">@owner</a>');
  const old = post("owner", "2112057695247180171", "Okayyy this one actually goes hard", `<a href="/henry/status/${targetId}">Replying to Henry</a>`);
  const found = payload(target + old);
  assert.equal(found.already_replied, "true");
  assert.match(found.conversation_context, /CONFIRMED OWN REPLIES TO THIS EXACT MESSAGE/);
  assert.equal(payload(target + post("owner", "2112057695247180171", "Unrelated own post")).already_replied, "unknown");
  assert.equal(payload(target + post("owner", "2112057695247180171", `<a href="/henry/status/${targetId}">A link in my post</a>`)).already_replied, "unknown");
  const nextId = "2112057695247180172";
  assert.equal(payload(target + post("owner", "2112057695247180171", "Reply to a different tweet", `<a href="/henry/status/${nextId}">Other turn</a>`)).already_replied, "unknown");
});

test("already_replied placeholders are supported, and confirmed Mentions stop before any AI call", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call AI for a confirmed duplicate"); });
  const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
  const vars = { author: "henry", text: "new profile pic", tweet_id: targetId, tweet_url: `https://x.com/henry/status/${targetId}`, already_replied: "true" };
  assert.equal(fillPromptTemplate("{{already_replied}}", vars), "true");
  assert.equal(fillPromptTemplate("{{already_replied}}", { ...vars, already_replied: undefined }), "unknown");
  assert.deepEqual(await generateDraft(settings, "mention_reply", vars), { ok: true, text: "", skipped: true });
  assert.deepEqual(await generateDraft(settings, "mention_reply", vars, { allowSkip: false }), { ok: false, error: "already_replied" });
});

test("manual reply history blocks confirmed and uncertain submissions by account plus tweet ID", async t => {
  const disk: Record<string, any> = { [`xcc.reply-attempt.v1.owner.${targetId}`]: { state: "confirmed", attemptedAt: Date.now() } };
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, patch); } } } } });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
  const p = payload(post("henry", targetId, "new profile pic", '<a href="/owner">@owner</a>'));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { calls++; return completion(JSON.parse(String(init.body)), "Do you mean using the Muse version as a profile pic?"); });
  assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: false, error: "already_replied" });
  disk[`xcc.reply-attempt.v1.owner.${targetId}`].state = "submitted";
  assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: false, error: "reply_attempt_exists" });
  assert.equal(calls, 0);
  assert.equal((await generateManualReply(settings, { ...p }, "other_account")).ok, true);
  assert.equal((await generateManualReply(settings, { ...p, tweet_id: "2112057695247180172" }, "owner")).ok, true);
  assert.equal(calls, 2);
});

for (const mode of ["mention_reply", "browse_reply"] as const) {
  test(`one-pass grounded review rejects cross-author details for ${mode}`, async t => {
    const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
    const p = payload(post(mode === "mention_reply" ? "owner" : "bob", parentId, "My hoodie and plush image.") + post("henry", targetId, "new profile pic"));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      calls++; const body = JSON.parse(String(init.body));
      assert.match(body.messages[0].content, /Keep claims attached to their labeled authors/);
      assert.match(body.messages[0].content, /Check these flags honestly/);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: "Your hoodie looks great!", correct_recipient: true, correct_attribution: false, unsupported_visual_claims: true }) } }] });
    });
    assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: false, error: "reply_grounding_failed", detail: "review_rejected" });
    assert.equal(calls, 1);
  });
}

for (const badReview of [
  "New profile pic, same hoodie energy? The plush era is hard to top.",
  JSON.stringify({ reply: "That plush version makes for a solid profile pic.", correct_recipient: true, correct_attribution: false, unsupported_visual_claims: true }),
  JSON.stringify({ reply: "An unverified answer", correct_recipient: "true", correct_attribution: true, unsupported_visual_claims: false }),
]) {
  test("invalid or rejected one-pass grounding cannot be returned as a manual draft", async t => {
    const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
    const p = payload(post("owner", parentId, "My hoodie and plush image.") + post("henry", targetId, "new profile pic"));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { calls++; return Response.json({ choices: [{ message: { content: badReview } }] }); });
    assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: false, error: "reply_grounding_failed", detail: badReview.startsWith("{") ? "review_rejected" : "invalid_review_format" });
    assert.equal(calls, 1);
  });
}

test("a manual button reply without thread context accepts plain text in one request", async t => {
  const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
  const p = payload(post("henry", targetId, "new profile pic"), "/home");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls++;
    assert.ok(!body.messages[0].content.includes("Return only JSON:"));
    assert.match(body.messages[0].content, /standalone post needs no parent/);
    return completion(body, "Is this the one you plan to use as your profile pic?");
  });
  const result = await generateManualReply(settings, { ...p }, "owner");
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

for (const mention of [false, true]) test(`standalone ${mention ? "mention" : "feed post"} needs no thread history to create a reply`, async t => {
  const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
  const text = mention ? "Cảm ơn @owner đã chia sẻ cách giảm phí chuyển tiền." : "Nhóm mình giảm họp xuống hai buổi mỗi tuần để tăng thời gian tập trung.";
  const good = mention ? "Mong là cách này giúp bạn tiết kiệm được chút phí." : "Có thêm thời gian tập trung sẽ hữu ích, miễn là người đang bị vướng vẫn có cách nhờ hỗ trợ trong ngày.";
  const p = payload(post("henry", targetId, text), "/home");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body));
    assert.ok(!body.messages[0].content.includes("Return only JSON:"));
    assert.match(body.messages[0].content, /Do not return a refusal/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: good } }] });
  });
  assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: true, text: good, replyMode: mention ? "mention_reply" : "browse_reply" });
  assert.equal(calls, 1);
});

test("an incoming comment under the owner's visible post keeps owner roles in one response", async t => {
  const ownPost = "Same hair. Same hoodie energy. The agent turned me into a plush. This is the Muse version I made.";
  const p = payload(post("owner", parentId, ownPost) + post("henry", targetId, "new profile pic"));
  assert.equal(p.reply_mode, "mention_reply");
  assert.equal(p.owner_post?.relationship, "thread_context");
  assert.equal(p.parent_text, "");
  const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
  const good = "Haha, this might have to be my new PFP.";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls++;
    assert.match(body.messages[0].content, /Write AS @owner, TO @henry/);
    assert.match(body.messages[0].content, /does not mean the commenter changed theirs/);
    assert.match(body.messages[0].content, /thread_context is not a verified parent/);
    assert.ok(body.messages[1].content.indexOf(ownPost) < body.messages[1].content.indexOf('"text":"new profile pic"'));
    return completion(body, good);
  });
  assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: true, text: good, replyMode: "mention_reply" });
  assert.equal(calls, 1);
});

test("swapped owner/commenter roles are rejected in the only response", async t => {
  const p = payload(post("owner", parentId, "My generated avatar.") + post("henry", targetId, "new profile pic"));
  const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ choices: [{ message: { content: JSON.stringify({ responding_as: "henry", responding_to: "owner", reply: "Why did you switch?", correct_recipient: true, correct_attribution: true, unsupported_visual_claims: false, correct_perspective: true, intent_consistent: true }) } }] }); });
  assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: false, error: "reply_grounding_failed", detail: "review_rejected" });
  assert.equal(calls, 1);
});

test("owner-reply skip cannot trigger an automatic paid rewrite", async t => {
  const p = payload(post("owner", parentId, "My new avatar.") + post("henry", targetId, "new profile pic"));
  const settings = { ...createDefaultAiSettings(), apiKey: "fake-key" };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ choices: [{ message: { content: "SKIP_REPLY" } }] }); });
  assert.deepEqual(await generateManualReply(settings, { ...p }, "owner"), { ok: false, error: "reply_grounding_failed", detail: "invalid_review_format" });
  assert.equal(calls, 1);
});

test("owner-post metadata survives queue restoration while invalid metadata is discarded", () => {
  const p = payload(post("owner", parentId, "My generated avatar.") + post("henry", targetId, "new profile pic"));
  const job = makeJob({ kind: "draft_reply", source: "browse", browseSurface: "mentions", ownerPost: p.owner_post, tweetId: targetId, authorHandle: "henry", tweetUrl: p.tweet_url, tweetText: p.text });
  assert.deepEqual(sanitizeQueue({ jobs: [job] }).jobs[0].ownerPost, p.owner_post);
  assert.equal(sanitizeQueue({ jobs: [{ ...job, ownerPost: { author: "???", tweetId: "invalid", text: "Untrusted", relationship: "parent" } }] }).jobs[0].ownerPost, undefined);
});
