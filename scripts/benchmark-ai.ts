/** Offline request replay: no API key, network call or generated-quality claim. */
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateDraft } from "../src/agent/ai-client.ts";
import { createDefaultAiSettings } from "../src/domain/ai-settings.ts";

const artifact = new URL("../artifacts/token-optimization/", import.meta.url);
const temp = new URL("../src/agent/.benchmark-before.ts", import.meta.url);
await writeFile(temp, await readFile(new URL("../fixtures/token-optimization/ai-client.before.txt", import.meta.url)));
const baseline = await import(temp.href);
const corpus = JSON.parse(await readFile(new URL("../fixtures/ai-token-corpus.json", import.meta.url), "utf8"));
const originalFetch = globalThis.fetch;
const rows: unknown[] = [];
try {
  for (const sample of corpus) {
    const vars = { author: "alice", text: sample.text, tweet_url: "https://x.com/alice/status/2112057695247180170", tweet_id: "2112057695247180170",
      parent_text: sample.parent_text, already_replied: sample.already_replied };
    const options = { preservePogo: sample.pogo, allowSkip: sample.review ? false : undefined, groundingReview: sample.review,
      ownerPostReply: sample.owner ? { owner: "owner", ownerPost: { author: "owner", tweetId: "2112057695247180169", text: sample.parent_text, relationship: "parent" },
        comment: { author: vars.author, tweetId: vars.tweet_id, text: sample.text } } : undefined };
    const runs: Record<string, unknown> = {};
    for (const [name, generate] of [["before", baseline.generateDraft], ["after", generateDraft]] as const) {
      const requests: any[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        const system = body.messages[0].content;
        let content = sample.reply;
        const flags = { reply: sample.reply, correct_recipient: true, correct_attribution: true, unsupported_visual_claims: false,
          responding_as: "owner", responding_to: "alice", correct_perspective: true, intent_consistent: true };
        if (system.includes("GROUNDED_REPLY_REVIEW") || system.includes("Return only JSON:")) content = JSON.stringify(flags);
        else if (system.includes("OWNER_POST_REPLY_UNDERSTANDING")) content = JSON.stringify({ ...flags, owner_post_id: "2112057695247180169",
          comment_id: vars.tweet_id, comment_intent: "A suggestion about the owner's avatar", subject: "owner_post", draft: sample.reply });
        return Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
      };
      const settings = { ...createDefaultAiSettings(), apiKey: "offline-fixture-key" };
      runs[name] = { result: await generate(settings, sample.kind, vars, options), requests };
    }
    rows.push({ id: sample.id, kind: sample.kind, pogo: !!sample.pogo, ...runs });
  }
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL("requests.json", artifact), JSON.stringify(rows, null, 2));
  console.log(`Captured ${rows.length} paired fixtures: ${fileURLToPath(new URL("requests.json", artifact))}`);
} finally {
  globalThis.fetch = originalFetch;
  await unlink(temp);
}
