import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { detectFollowsYou, readFollowProfileMeta, scanFollowUserCells } from "../src/content/x-follow-scan.ts";

test("missing relationship badge is unknown, including unloaded user cells", () => {
  const { document } = parseHTML('<html><body><div data-testid="UserCell">@alice</div></body></html>');
  const cell = document.querySelector('div')!;
  assert.equal(detectFollowsYou(cell), null);
  cell.textContent = "@alice Follows you";
  assert.equal(detectFollowsYou(cell), true);
  cell.textContent = "@alice Đang theo dõi bạn";
  assert.equal(detectFollowsYou(cell), true);
  assert.equal(detectFollowsYou(null), null);
});

test("Following list distinguishes followers and non-followers directly while incomplete rows stay unknown", context => {
  const { document } = parseHTML(`<html><body><main role="main">
    <div data-testid="UserCell"><a href="/alice">@alice</a><span data-testid="userFollowIndicator">Follows you</span><button data-testid="1-unfollow">Following</button></div>
    <div data-testid="UserCell"><a href="/bob">@bob</a><button data-testid="2-unfollow">Following</button></div>
    <div data-testid="UserCell" aria-busy="true"><a href="/carol">@carol</a><button data-testid="3-unfollow">Following</button></div>
    <div data-testid="UserCell"><a href="/dave">@dave</a></div>
  </main></body></html>`);
  const locationMock = { pathname: "/me/following" };
  for (const [key, value] of Object.entries({ document, location: locationMock })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  assert.deepEqual(scanFollowUserCells().map(c => [c.handle, c.followsYou]),
    [["alice", true], ["bob", false], ["carol", null], ["dave", null]]);
  locationMock.pathname = "/me/followers";
  assert.equal(scanFollowUserCells().find(c => c.handle === "bob")!.followsYou, null);
});

test("numbers in a bio are not treated as actual follower counts", context => {
  const { document } = parseHTML('<html><body><main role="main"><div data-testid="UserName">Alice @alice</div><div>My goal: 1M Followers</div><div data-testid="UserCell"><a href="/bob">@bob</a><span>1M Followers</span></div></main></body></html>');
  for (const [key, value] of Object.entries({ document, location: { pathname: "/alice" } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  assert.equal(readFollowProfileMeta("alice").followers, null);
  assert.equal(scanFollowUserCells()[0].followers, null);
});

test("profile does not infer a negative relationship or use tweet text", context => {
  const { document } = parseHTML('<html><body><main role="main"><div data-testid="UserName">Alice @alice</div><article>Follows you</article></main></body></html>');
  for (const [key, value] of Object.entries({ document, location: { pathname: "/alice" } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  assert.equal(readFollowProfileMeta("alice").followsYou, null);
  document.querySelector('[data-testid="UserName"]')!.innerHTML += '<span data-testid="userFollowIndicator">Follows you</span>';
  assert.equal(readFollowProfileMeta("alice").followsYou, true);
});

test("a fully loaded matching profile without a relationship badge is not following back", context => {
  const { document } = parseHTML('<html lang="en"><body><main role="main"><div data-testid="UserName">Alice @alice</div><a href="/alice/followers">200 Followers</a><button data-testid="123-unfollow">Following</button><article>Follows you</article></main></body></html>');
  for (const [key, value] of Object.entries({ document, location: { pathname: "/alice" } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  assert.equal(readFollowProfileMeta("alice").followsYou, false);
  const name = document.querySelector('[data-testid="UserName"]')!;
  name.setAttribute("aria-busy", "true");
  assert.equal(readFollowProfileMeta("alice").followsYou, null);
  name.removeAttribute("aria-busy");
  name.textContent = "Bob @bob";
  assert.equal(readFollowProfileMeta("alice").followsYou, null);
  name.textContent = "Alice @alice";
  document.querySelector('a')!.remove();
  assert.equal(readFollowProfileMeta("alice").followsYou, null);
});

test("semantic follow-back badges work independently of the displayed language", () => {
  const { document } = parseHTML('<html><body><span data-testid="userFollowIndicator">Te sigue</span></body></html>');
  assert.equal(detectFollowsYou(document.querySelector('span')), true);
});

test("following lists and suggestion controls cannot confirm a profile relationship", context => {
  const { document } = parseHTML('<html><body><main role="main"><div data-testid="UserName">Alice @alice</div><a href="/alice/followers">200 Followers</a><div data-testid="UserCell"><button data-testid="123-unfollow">Following</button></div></main></body></html>');
  const locationMock = { pathname: "/alice/following" };
  for (const [key, value] of Object.entries({ document, location: locationMock })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  assert.equal(readFollowProfileMeta("alice").onProfile, false);
  assert.equal(readFollowProfileMeta("alice").followsYou, null);
  locationMock.pathname = "/alice";
  assert.equal(readFollowProfileMeta("alice").followsYou, null);
  assert.equal(readFollowProfileMeta("alice").alreadyFollowing, false);
});
