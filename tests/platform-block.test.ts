import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { detectXPlatformBlock } from "../src/x/platform-block.ts";

test("only system alerts and own-account routes block execution", () => {
  const doc = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
  assert.equal(detectXPlatformBlock(doc(""), "/account/access"), "x_account_requires_attention");
  assert.equal(detectXPlatformBlock(doc(""), "/i/flow/login"), "x_account_requires_attention");
  assert.equal(detectXPlatformBlock(doc('<div role="alert">Rate limit exceeded</div>'), "/home"), "x_rate_limited");
  assert.equal(detectXPlatformBlock(doc('<article><div role="alert">Rate limit exceeded</div></article>'), "/someone/status/123"), null);
  assert.equal(detectXPlatformBlock(doc('<main>This account is suspended</main>'), "/someone"), null);
  assert.equal(detectXPlatformBlock(doc('<div role="alert">Something went wrong. Try again.</div>'), "/home"), null);
});
