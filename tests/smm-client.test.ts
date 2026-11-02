import assert from "node:assert/strict";
import test from "node:test";
import {
  buildParameters,
  callSmm,
  SMM_API_URL,
} from "../src/api/smm-client.ts";

test("builds supported read and maintenance requests", () => {
  assert.deepEqual(buildParameters("services"), { action: "services" });
  assert.deepEqual(buildParameters("status", { ids: "1, 2 2" }), {
    action: "status",
    orders: "1,2",
  });
  assert.deepEqual(buildParameters("refill", { ids: "8" }), {
    action: "refill",
    order: "8",
  });
  assert.deepEqual(buildParameters("refill_status", { ids: "4,5" }), {
    action: "refill_status",
    refills: "4,5",
  });
  assert.deepEqual(buildParameters("cancel", { ids: "9" }), {
    action: "cancel",
    orders: "9",
  });
});

test("builds add order for X status link", () => {
  const p = buildParameters("add", {
    service: "123",
    link: "https://x.com/alice/status/999?s=20",
    quantity: 1000,
  });
  assert.equal(p.action, "add");
  assert.equal(p.service, "123");
  assert.equal(p.link, "https://x.com/alice/status/999");
  assert.equal(p.quantity, "1000");
});

test("rejects add orders and invalid identifiers", () => {
  assert.throws(() => buildParameters("add", { ids: "1" }), /ID dịch vụ/);
  assert.throws(() => buildParameters("status", { ids: "1,abc" }), /chữ số/);
  assert.throws(
    () =>
      buildParameters("add", {
        service: "1",
        link: "https://example.com/x",
        quantity: 10,
      }),
    /bài viết trên X/,
  );
});

test("posts form data without exposing key in URL", async () => {
  let request: { url: string; options: RequestInit } | undefined;
  const data = (await callSmm("balance", {}, "secret", async (url, options) => {
    request = { url: String(url), options: options ?? {} };
    return {
      ok: true,
      text: async () => '{"balance":"3.5","currency":"USD"}',
    } as Response;
  })) as { balance: string };
  assert.equal(request!.url, SMM_API_URL);
  assert.equal(request!.options.method, "POST");
  assert.equal(request!.options.redirect, "error");
  assert.ok(request!.options.signal instanceof AbortSignal);
  const body = request!.options.body as URLSearchParams;
  assert.equal(body.get("key"), "secret");
  assert.equal(data.balance, "3.5");
});

test("rejects malformed status paths and URLs containing credentials", () => {
  for (const link of ["https://x.com/alice/status/999oops", "https://x.com/alice/status/999/unrelated", "https://user:password@x.com/alice/status/999"]) {
    assert.throws(() => buildParameters("add", { service: "1", link, quantity: 10 }), /bài viết trên X/);
  }
  assert.equal(buildParameters("add", { service: "1", link: "https://x.com/alice/status/999/photo/1", quantity: 10 }).link, "https://x.com/alice/status/999");
});

test("an unresponsive SMM request terminates when its timeout expires", async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 15000);
    return controller.signal;
  });
  const request = callSmm("services", {}, "test-key", async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
  }));
  await assert.rejects(request, { name: "TimeoutError" });
});
