import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { rememberNotificationPosition, restoreNotificationPosition } from "../src/x/notification-position.ts";
import { beginAction, stopActions, ActionStoppedError } from "../src/x/action-control.ts";

test("notification return restores Following position only for the matching account and source", t => {
  const { document } = parseHTML('<main><a role="tab" aria-selected="true">Following</a></main>');
  const disk = new Map<string, string>();
  const location = { pathname: '/home' };
  const window = { scrollY: 1400, scrollBy({ top }: { top: number }) { this.scrollY += top; } };
  const globals = { document, location, window, sessionStorage: { setItem: (k: string, v: string) => disk.set(k, v), getItem: (k: string) => disk.get(k), removeItem: (k: string) => disk.delete(k) } };
  for (const [key, value] of Object.entries(globals)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => before ? Object.defineProperty(globalThis, key, before) : Reflect.deleteProperty(globalThis, key));
  }
  beginAction(); t.after(stopActions);
  rememberNotificationPosition('owner');
  location.pathname = '/notifications/mentions'; window.scrollY = 80;
  rememberNotificationPosition('owner');
  location.pathname = '/home';
  restoreNotificationPosition('other', 'following'); assert.equal(window.scrollY, 80);
  restoreNotificationPosition('owner', 'home'); assert.equal(window.scrollY, 80);
  restoreNotificationPosition('owner', 'following'); assert.equal(window.scrollY, 1400);
  assert.equal(disk.size, 0);
  stopActions();
  assert.throws(() => restoreNotificationPosition('owner', 'following'), ActionStoppedError);
});
