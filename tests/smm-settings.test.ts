import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultSmmSettings,
  describeSmmOrderError,
  requireSmmOrder,
  sanitizeSmmSettings,
  toPublicSmmSettings,
  validateSmmServices,
} from "../src/domain/smm-settings.ts";

test("sanitizeSmmSettings defaults and clamps", () => {
  const s = sanitizeSmmSettings({
    scanUsername: "@Alice_01",
    scanLimit: 999,
    viewServiceId: "42",
    autoOrder: true,
  });
  assert.equal(s.scanUsername, "Alice_01");
  assert.equal(s.scanLimit, 500);
  assert.equal(s.viewServiceId, "42");
  assert.equal(s.autoOrder, true);
  assert.equal(s.minViews, 1000);
});

test("toPublicSmmSettings masks api key", () => {
  const pub = toPublicSmmSettings({
    ...createDefaultSmmSettings(),
    apiKey: "secret",
  });
  assert.equal(pub.hasKey, true);
  assert.equal("apiKey" in pub, false);
});

test("validateSmmServices checks Default type and qty range", () => {
  const services = [
    { service: 10, type: "Default", min: 100, max: 5000, name: "X Views" },
    { service: 20, type: "Default", min: 10, max: 200, name: "X Likes" },
  ];
  validateSmmServices(services, {
    minViews: 1000,
    minLikes: 50,
    viewServiceId: "10",
    likeServiceId: "20",
    viewOrderQuantity: 1000,
    likeOrderQuantity: 50,
  });
  // Empty like ID = skip likes even when minLikes > 0 (optional metric).
  validateSmmServices(services, {
    minViews: 1000,
    minLikes: 50,
    viewServiceId: "10",
    likeServiceId: "",
    viewOrderQuantity: 1000,
    likeOrderQuantity: 50,
  });
  assert.throws(
    () =>
      validateSmmServices(services, {
        minViews: 1000,
        minLikes: 0,
        viewServiceId: "99",
        likeServiceId: "",
        viewOrderQuantity: 1000,
        likeOrderQuantity: 50,
      }),
    /không tồn tại/,
  );
  assert.throws(
    () =>
      validateSmmServices(
        [{ service: 10, type: "Custom Comments", min: 1, max: 10 }],
        {
          minViews: 1,
          minLikes: 0,
          viewServiceId: "10",
          likeServiceId: "",
          viewOrderQuantity: 5,
          likeOrderQuantity: 1,
        },
      ),
    /Default/,
  );
});

test("requireSmmOrder and describeSmmOrderError", () => {
  assert.equal(requireSmmOrder({ order: "12345" }), "12345");
  assert.throws(() => requireSmmOrder({ order: "0" }), /mã đơn/);
  const msg = describeSmmOrderError(new Error("Incorrect service ID"), "9", "view");
  assert.match(msg, /#9/);
});
