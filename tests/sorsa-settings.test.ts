import assert from "node:assert/strict";
import test from "node:test";
import { formatSorsaScore, sorsaTier } from "../src/domain/sorsa-settings.ts";

test("sorsaTier thresholds match X68-style bands", () => {
  assert.equal(sorsaTier(0), "low");
  assert.equal(sorsaTier(199), "low");
  assert.equal(sorsaTier(200), "medium");
  assert.equal(sorsaTier(599), "medium");
  assert.equal(sorsaTier(600), "high");
  assert.equal(sorsaTier(1400), "high");
});

test("formatSorsaScore compact display", () => {
  assert.equal(formatSorsaScore(0), "0");
  assert.equal(formatSorsaScore(55), "55");
  assert.equal(formatSorsaScore(1400), "1.4k");
  assert.equal(formatSorsaScore(10000), "10k");
  assert.equal(formatSorsaScore(1.25), "1.3");
});
