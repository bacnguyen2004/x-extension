import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  detectAccountUnavailable,
  isAccountUnavailableError,
} from "../src/x/account-status.ts";

test("detectAccountUnavailable catches suspended / restricted / missing", () => {
  const { document: doc1 } = parseHTML(`<!doctype html><html><body>
    <div data-testid="primaryColumn">Account suspended. Learn more</div>
  </body></html>`);
  assert.equal(detectAccountUnavailable(doc1), "profile_suspended");

  const { document: doc2 } = parseHTML(`<!doctype html><html><body>
    <div data-testid="primaryColumn">
      Caution: This account has an unusually large number of posts.
      This profile may have been temporarily restricted.
      Something went wrong. Try reloading.
    </div>
  </body></html>`);
  assert.equal(detectAccountUnavailable(doc2), "profile_restricted");

  const { document: doc3 } = parseHTML(`<!doctype html><html><body>
    <div data-testid="primaryColumn">This account doesn’t exist. Try searching for another.</div>
  </body></html>`);
  assert.equal(detectAccountUnavailable(doc3), "profile_missing");
});

test("isAccountUnavailableError", () => {
  assert.equal(isAccountUnavailableError("profile_suspended"), true);
  assert.equal(isAccountUnavailableError("follow_btn_missing"), false);
});
