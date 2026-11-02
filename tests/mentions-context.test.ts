import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { collectVisibleMentionTweets, readConversationContext } from "../src/x/timeline.ts";

function post(author: string, id: string, text: string, extra = "") {
  return `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${author}">${author}</a></div><a href="/${author}/status/${id}"><time></time></a>${extra}<div data-testid="tweetText">${text}</div></article>`;
}
function doc(html: string) { return parseHTML(`<main>${html}</main>`).document as unknown as Document; }

test("Mentions accepts direct replies and @mentions, excludes bell posts, own posts and quoted mentions", () => {
  const document = doc(post("alice", "2112057695247180169", "What about fees?", '<div>Replying to <a href="/owner">@owner</a></div>') +
    post("bob", "2112057695247180170", "Hi @owner") + post("carol", "2112057695247180171", "A bell notification") +
    post("owner", "2112057695247180172", "Hi @owner") + post("dave", "2112057695247180173", "My comment", post("eve", "2112057695247180174", "Hi @owner")));
  assert.deepEqual(collectVisibleMentionTweets(document, "owner").map(p => p.authorHandle), ["alice", "bob"]);
  assert.ok(collectVisibleMentionTweets(document, "owner").every(p => p.directedToOwn));
  assert.deepEqual(collectVisibleMentionTweets(document, ""), []);
});

test("Context preserves visible thread posts but does not invent an exact parent from a profile link", () => {
  const parent = post("owner", "2112057695247180169", "Withdrawal fees fell to $1.");
  const targetId = "2112057695247180170";
  const context = readConversationContext(doc(parent + post("alice", targetId, "Is that permanent?", '<a href="/owner">@owner</a>') + post("bob", "2112057695247180171", "Later response")), targetId);
  assert.equal(context.parentText, "");
  assert.match(context.conversationContext, /exact parent not verified/);
  assert.match(context.conversationContext, /Withdrawal fees fell to \$1/);
  assert.ok(!context.conversationContext.includes("Later response"));
  const linked = readConversationContext(doc(parent + post("alice", targetId, "Is that permanent?", '<a href="/owner/status/2112057695247180169">Replying to original</a>')), targetId);
  assert.equal(linked.parentText, "Withdrawal fees fell to $1.");
  assert.deepEqual(readConversationContext(doc(parent), targetId), { parentText: "", conversationContext: "" });
});
