import assert from "node:assert/strict";
import test from "node:test";
import { saveAgentSettings, getAgentPublicState } from "../src/background/agent-store.ts";
import { createDefaultAgentSettings } from "../src/domain/agent-settings.ts";
import { makeJob } from "../src/domain/agent-queue.ts";

test("saving the missing username reopens pre-submit failures and retains attempted replies", async t => {
  const common = { kind: "post_reply" as const, source: "manual" as const, authorHandle: "alice", tweetText: "A post", tweetUrl: "https://x.com/alice/status/2112057695247180180", draftText: "A prepared reply" };
  const failed = makeJob({ ...common, tweetId: "2112057695247180180", status: "failed", error: "reply_identity_missing" });
  const uncertain = makeJob({ ...common, tweetId: "2112057695247180181", status: "skipped", error: "reply_submission_uncertain", verification: "uncertain" });
  const sent = makeJob({ ...common, tweetId: "2112057695247180182", status: "done", verification: "submitted" });
  const disk: Record<string, unknown> = { "xContentCreator.agentQueue.v1": { jobs: [failed, uncertain, sent] } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: { id: "username-test", sendMessage: async () => {} }, storage: { local: { get: async (key: string) => ({ [key]: disk[key] }), set: async (patch: object) => { Object.assign(disk, structuredClone(patch)); } } } } });
  t.after(() => original ? Object.defineProperty(globalThis, "chrome", original) : Reflect.deleteProperty(globalThis, "chrome"));
  await saveAgentSettings({ ...createDefaultAgentSettings(), ownHandle: "me" });
  const result = await getAgentPublicState();
  assert.equal(result.recentJobs.find(job => job.id === failed.id)?.status, "pending");
  assert.equal(result.recentJobs.find(job => job.id === uncertain.id)?.status, "skipped");
  assert.equal(result.recentJobs.find(job => job.id === sent.id)?.status, "done");
});
