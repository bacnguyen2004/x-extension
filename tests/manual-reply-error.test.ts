import assert from "node:assert/strict";
import test from "node:test";
import { manualReplyError } from "../src/content/manual-reply-error.ts";

test("manual reply errors distinguish response format from rejected claims and missing source text", () => {
  assert.match(manualReplyError("reply_grounding_failed", "invalid_review_format"), /sai định dạng/);
  assert.match(manualReplyError("reply_grounding_failed", "review_rejected"), /người nói/);
  assert.match(manualReplyError("source_text_missing"), /Chưa đọc được chữ/);
  assert.match(manualReplyError("reply_quality_failed", "too_long"), /độ dài/);
  assert.match(manualReplyError("already_replied"), /đã trả lời đúng bài/);
  assert.equal(manualReplyError("http_429"), "http_429");
});
