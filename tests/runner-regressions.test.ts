import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { attachXPort } from "../src/background/x-bridge.ts";
import { startUnfollowRunner, stopUnfollowRunner, runUnfollowTick } from "../src/background/unfollow-runner.ts";
import { createInitialUnfollowRuntime } from "../src/background/unfollow-store.ts";
import { createDefaultUnfollowSettings } from "../src/domain/unfollow-settings.ts";
import { runFollowTick, stopFollowRunner, startFollowRunner } from "../src/background/follow-runner.ts";
import { createDefaultFollowSettings } from "../src/domain/follow-settings.ts";
import { createInitialFollowRuntime } from "../src/background/follow-store.ts";
import { smmPlaceOrder } from "../src/background/smm-runner.ts";
import { createDefaultSmmSettings } from "../src/domain/smm-settings.ts";

function setup(t: TestContext, disk: Record<string, unknown>, handle = "me") {
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const commands: string[] = [];
  const listeners = new Set<(m: any) => void>(), disconnects = new Set<() => void>();
  const emit = (message: object) => { for (const fn of [...listeners]) fn(message); };
  const chromeMock = { runtime: { id: "audit", sendMessage: async () => {} },
    alarms: { clear: async () => {}, create: async () => {} },
    storage: { local: { get: async (key: string) => ({ [key]: structuredClone(disk[key]) }), set: async (patch: object) => Object.assign(disk, structuredClone(patch)) } } };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: chromeMock });
  t.after(() => old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome"));
  const port = { sender: { id: "audit", url: "https://x.com/me", tab: { id: 94 }, frameId: 0 },
    onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn: any) => disconnects.add(fn), removeListener: (fn: any) => disconnects.delete(fn) },
    postMessage(m: any) { commands.push(m.type); if (m.type === "x_ping") emit({ type: "x_hello", handle, href: "https://x.com/me" });
      if (m.type === "x_follow_profile_meta") emit({ type: "x_follow_profile_meta_result", requestId: m.requestId, ok: false, error: "profile_suspended" }); }, disconnect() {} };
  attachXPort(port as any, "audit");
  t.after(() => { for (const fn of [...disconnects]) fn(); });
  return { chromeMock, commands, port, emit };
}

for (const sourceMode of ["own_following", "list"] as const) {
  for (const followsYou of [false, true, null]) {
    test(`Unfollow ${sourceMode} handles relationship ${followsYou} without any profile request`, async t => {
      const settings = createDefaultUnfollowSettings();
      settings.ownHandle = "me"; settings.sourceMode = sourceMode;
      settings.protect.sorsaMin = null; settings.protect.protectMissingSorsa = false;
      const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": settings,
        "xContentCreator.unfollowRuntime.v1": { ...createInitialUnfollowRuntime(), running: true,
          sourceMode, queue: sourceMode === "list" ? ["alice"] : [] } };
      const { port, emit, commands } = setup(t, disk);
      emit({ type: "x_hello", handle: "me", href: "https://x.com/me/following" });
      port.postMessage = m => {
        commands.push(m.type);
        if (m.type === "x_follow_scan_cells") emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: true,
          candidates: [{ handle: "alice", verified: false, alreadyFollowing: true, followsYou }] });
        if (m.type === "x_unfollow_cell") emit({ type: "x_unfollow_cell_result", requestId: m.requestId, ok: true, detail: "unfollow_confirmed" });
      };
      await runUnfollowTick();
      const rt = disk["xContentCreator.unfollowRuntime.v1"] as any;
      assert.equal(rt.unfollowedToday, followsYou === false ? 1 : 0);
      assert.equal(rt.protectedCount, followsYou === true ? 1 : 0);
      assert.equal(rt.skipped, followsYou === null ? 1 : 0);
      assert.ok(!commands.some(c => ["x_follow_profile_meta", "x_unfollow", "x_navigate"].includes(c)));
      await stopUnfollowRunner();
    });
  }
}

for (const mode of ["follow", "unfollow"] as const) {
  test(`${mode} stops on an account switch during scan without sending an action`, async t => {
    const settings = mode === "follow"
      ? { ...createDefaultFollowSettings(), sourceMode: "kol_followers", kolHandle: "kol" }
      : { ...createDefaultUnfollowSettings(), ownHandle: "me" };
    const initial = mode === "follow" ? createInitialFollowRuntime() : createInitialUnfollowRuntime();
    const runtimeKey = `xContentCreator.${mode}Runtime.v1`;
    const disk: Record<string, unknown> = { [`xContentCreator.${mode}.v1`]: settings,
      [runtimeKey]: { ...initial, running: true, account: "me", sourceMode: mode === "follow" ? "kol_followers" : "own_following" } };
    const { port, emit, commands } = setup(t, disk);
    emit({ type: "x_hello", handle: "me", href: mode === "follow" ? "https://x.com/kol/followers" : "https://x.com/me/following" });
    const originalPost = port.postMessage;
    port.postMessage = m => {
      originalPost(m);
      if (m.type === "x_follow_scan_cells") {
        emit({ type: "x_hello", handle: "other", href: "https://x.com/home" });
        emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: true,
          candidates: [{ handle: "alice", alreadyFollowing: mode === "unfollow", verified: false, followsYou: false }] });
      }
    };
    await (mode === "follow" ? runFollowTick() : runUnfollowTick());
    const rt = disk[runtimeKey] as any;
    assert.equal(rt.running, false);
    assert.match(rt.detail, /Tài khoản X đã thay đổi/);
    assert.ok(!commands.some(c => ["x_follow", "x_follow_cell", "x_unfollow", "x_unfollow_cell"].includes(c)));
  });

  test(`${mode} handles missing follower counts according to its navigation policy`, async t => {
    const fl = createDefaultFollowSettings();
    fl.sourceMode = "kol_followers"; fl.kolHandle = "kol"; fl.filters.sorsaMin = null; fl.filters.followersMin = 100;
    const uf = createDefaultUnfollowSettings();
    uf.ownHandle = "me"; uf.protect.sorsaMin = null; uf.protect.protectMissingSorsa = false; uf.targets.followersMax = 500;
    const runtimeKey = `xContentCreator.${mode}Runtime.v1`;
    const disk: Record<string, unknown> = { [`xContentCreator.${mode}.v1`]: mode === "follow" ? fl : uf,
      [runtimeKey]: { ...(mode === "follow" ? createInitialFollowRuntime() : createInitialUnfollowRuntime()),
        running: true, sourceMode: mode === "follow" ? "kol_followers" : "own_following" } };
    const { port, emit, commands } = setup(t, disk);
    emit({ type: "x_hello", handle: "me", href: mode === "follow" ? "https://x.com/kol/followers" : "https://x.com/me/following" });
    port.postMessage = m => {
      commands.push(m.type);
      if (m.type === "x_follow_scan_cells") emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: true,
        candidates: [{ handle: "alice", alreadyFollowing: mode === "unfollow", verified: false, followsYou: false, followers: null }] });
      if (m.type === "x_follow_profile_meta") emit({ type: "x_follow_profile_meta_result", requestId: m.requestId, ok: true,
        meta: { onProfile: true, verified: false, followers: 200, alreadyFollowing: mode === "unfollow", hasFollowButton: mode === "follow", followsYou: false } });
      if (m.type === "x_follow" || m.type === "x_unfollow") emit({ type: `${m.type}_result`, requestId: m.requestId, ok: true,
        detail: mode === "follow" ? "follow_confirmed" : "unfollow_confirmed" });
    };
    await (mode === "follow" ? runFollowTick() : runUnfollowTick());
    const rt = disk[runtimeKey] as any;
    assert.equal(commands.includes("x_follow_profile_meta"), mode === "follow");
    assert.equal(rt[mode === "follow" ? "followedToday" : "unfollowedToday"], mode === "follow" ? 1 : 0);
    if (mode === "unfollow") {
      assert.equal(rt.skipped, 1);
      assert.equal(rt.logs[0].reason, "followers_unknown");
      assert.ok(!commands.includes("x_unfollow"));
    }
    await (mode === "follow" ? stopFollowRunner() : stopUnfollowRunner());
  });
}

test("Follow scan errors do not consume the end-of-list counter", async t => {
  const settings = createDefaultFollowSettings();
  settings.sourceMode = "kol_followers"; settings.kolHandle = "kol";
  const disk: Record<string, unknown> = { "xContentCreator.follow.v1": settings,
    "xContentCreator.followRuntime.v1": { ...createInitialFollowRuntime(), running: true,
      sourceMode: "kol_followers", emptyScrolls: 7 } };
  const { port, emit, commands } = setup(t, disk);
  emit({ type: "x_hello", handle: "me", href: "https://x.com/kol/followers" });
  const originalPost = port.postMessage;
  port.postMessage = m => {
    originalPost(m);
    if (m.type === "x_follow_scan_cells") emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: false, error: "busy" });
  };
  await runFollowTick();
  const rt = disk["xContentCreator.followRuntime.v1"] as any;
  assert.equal(rt.emptyScrolls, 7);
  assert.equal(rt.running, true);
  assert.ok(!commands.includes("x_follow_scroll_list"));
  await stopFollowRunner();
});

test("Follow uses edited filters before acting and immediately waits at the cap", async t => {
  const settings = createDefaultFollowSettings();
  settings.sourceMode = "kol_followers"; settings.kolHandle = "kol";
  settings.filters.sorsaMin = null; settings.pace.maxPer30Min = 1;
  const disk: Record<string, unknown> = { "xContentCreator.follow.v1": settings,
    "xContentCreator.followRuntime.v1": { ...createInitialFollowRuntime(), running: true, sourceMode: "kol_followers" } };
  const { port, emit, commands } = setup(t, disk);
  emit({ type: "x_hello", handle: "me", href: "https://x.com/kol/followers" });
  const originalPost = port.postMessage;
  let block = true;
  port.postMessage = m => {
    originalPost(m);
    if (m.type === "x_follow_scan_cells") {
      settings.filters.blacklist = block ? ["alice"] : [];
      emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: true,
        candidates: [{ handle: "alice", verified: false, alreadyFollowing: false }] });
    }
    if (m.type === "x_follow_cell") emit({ type: "x_follow_cell_result", requestId: m.requestId, ok: true, detail: "follow_confirmed" });
  };
  await runFollowTick();
  assert.ok(!commands.includes("x_follow_cell"));
  let rt = disk["xContentCreator.followRuntime.v1"] as any;
  assert.equal(rt.logs[0].reason, "blacklist");
  rt.seen = []; rt.nextAt = null; block = false; settings.filters.blacklist = [];
  await runFollowTick();
  rt = disk["xContentCreator.followRuntime.v1"] as any;
  assert.equal(commands.filter(c => c === "x_follow_cell").length, 1);
  assert.equal(rt.followedToday, 1);
  assert.match(rt.detail, /Đạt giới hạn 1\/30 phút/);
  assert.ok(rt.nextAt > Date.now() + 1700000);
  const before = commands.length;
  await runFollowTick();
  assert.equal(commands.length, before);
  await stopFollowRunner();
});

test("Stop while Follow startup loads settings does not navigate or overwrite the stopped state", async t => {
  const disk: Record<string, unknown> = {};
  const { chromeMock, commands } = setup(t, disk);
  const originalGet = chromeMock.storage.local.get;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  chromeMock.storage.local.get = async key => {
    if (key === "xContentCreator.follow.v1" && first) { first = false; entered(); await gate; }
    return originalGet(key);
  };
  const starting = startFollowRunner();
  await pending;
  await stopFollowRunner();
  const before = commands.length;
  release();
  assert.deepEqual(await starting, { ok: false, error: "stopped" });
  assert.equal(commands.length, before);
  assert.equal((disk["xContentCreator.followRuntime.v1"] as any).detail, "Đã dừng");
});

test("Unfollow does not count an account that is already not followed", async t => {
  const settings = createDefaultUnfollowSettings();
  settings.ownHandle = "me"; settings.protect.sorsaMin = null; settings.protect.protectMissingSorsa = false;
  settings.pace.maxPer30Min = 1;
  const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": settings,
    "xContentCreator.unfollowRuntime.v1": { ...createInitialUnfollowRuntime(), running: true } };
  const { port, emit, commands } = setup(t, disk);
  emit({ type: "x_hello", handle: "me", href: "https://x.com/me/following" });
  const originalPost = port.postMessage;
  port.postMessage = m => {
    originalPost(m);
    if (m.type === "x_follow_scan_cells") emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: true,
      candidates: ["alice", "bob"].map(handle => ({ handle, verified: false, alreadyFollowing: true, followsYou: false })) });
    if (m.type === "x_unfollow_cell") emit({ type: "x_unfollow_cell_result", requestId: m.requestId, ok: true,
      detail: m.authorHandle === "alice" ? "already_not_following" : "unfollow_confirmed" });
  };
  await runUnfollowTick();
  const rt = disk["xContentCreator.unfollowRuntime.v1"] as any;
  assert.equal(rt.unfollowedToday, 1);
  assert.equal(rt.skipped, 1);
  assert.equal(rt.processed, 2);
  assert.equal(commands.filter(c => c === "x_unfollow_cell").length, 2);
  await stopUnfollowRunner();
});

for (const detail of ["unfollow_confirmed", "already_not_following"]) {
  test(`Unfollow list restricts cell actions to selected handles and accounts ${detail}`, async t => {
    const settings = createDefaultUnfollowSettings();
    settings.ownHandle = "me"; settings.sourceMode = "list";
    settings.protect.sorsaMin = null; settings.protect.protectMissingSorsa = false;
    const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": settings,
      "xContentCreator.unfollowRuntime.v1": { ...createInitialUnfollowRuntime(), running: true, sourceMode: "list", queue: ["alice"] } };
    const { port, emit, commands } = setup(t, disk);
    emit({ type: "x_hello", handle: "me", href: "https://x.com/me/following" });
    const actions: string[] = [];
    port.postMessage = m => {
      commands.push(m.type);
      if (m.type === "x_follow_scan_cells") emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: true,
        candidates: ["outside", "alice"].map(handle => ({ handle, verified: false, alreadyFollowing: true, followsYou: false })) });
      if (m.type === "x_unfollow_cell") {
        actions.push(m.authorHandle);
        emit({ type: "x_unfollow_cell_result", requestId: m.requestId, ok: true, detail });
      }
    };
    await runUnfollowTick();
    const rt = disk["xContentCreator.unfollowRuntime.v1"] as any;
    assert.deepEqual(actions, ["alice"]);
    assert.ok(!commands.includes("x_follow_profile_meta"));
    assert.ok(!commands.includes("x_unfollow"));
    assert.equal(rt.unfollowedToday, detail === "unfollow_confirmed" ? 1 : 0);
    assert.equal(rt.skipped, detail === "unfollow_confirmed" ? 0 : 1);
    rt.nextAt = null;
    await runUnfollowTick();
    assert.equal((disk["xContentCreator.unfollowRuntime.v1"] as any).running, false);
    assert.deepEqual(actions, ["alice"]);
    await stopUnfollowRunner();
  });
}

test("Stop during Unfollow startup prevents resuming or scheduling work", async t => {
  const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": { ...createDefaultUnfollowSettings(), sourceMode: "list", usernameList: "alice" } };
  const { chromeMock } = setup(t, disk);
  const originalGet = chromeMock.storage.local.get;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  chromeMock.storage.local.get = async key => { if (key === "xContentCreator.unfollow.v1" && first) { first = false; entered(); await gate; } return originalGet(key); };
  const starting = startUnfollowRunner();
  await waiting;
  await stopUnfollowRunner();
  assert.equal((disk["xContentCreator.unfollowRuntime.v1"] as any).running, false);
  release();
  assert.deepEqual(await starting, { ok: false, error: "stopped" });
  assert.equal((disk["xContentCreator.unfollowRuntime.v1"] as any).running, false);
  assert.equal((disk["xContentCreator.unfollowRuntime.v1"] as any).detail, "Đã dừng");
  await stopUnfollowRunner();
});

test("Unfollow retries a busy scan without advancing the list or opening profiles", async t => {
  const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": { ...createDefaultUnfollowSettings(), sourceMode: "list", ownHandle: "me" },
    "xContentCreator.unfollowRuntime.v1": { ...createInitialUnfollowRuntime(), running: true, sourceMode: "list", queue: ["alice"] } };
  const { port, emit, commands } = setup(t, disk);
  emit({ type: "x_hello", handle: "me", href: "https://x.com/me/following" });
  port.postMessage = m => {
    commands.push(m.type);
    if (m.type === "x_follow_scan_cells") emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: false, error: "busy" });
  };
  await runUnfollowTick();
  const rt = disk["xContentCreator.unfollowRuntime.v1"] as any;
  assert.deepEqual(rt.queue, ["alice"]);
  assert.deepEqual(rt.seen, []);
  assert.equal(rt.emptyScrolls, 0);
  assert.ok(!commands.includes("x_follow_profile_meta"));
  assert.ok(!commands.includes("x_follow_scroll_list"));
  await stopUnfollowRunner();
});

test("Stop during an Unfollow scan cancels X and cannot restore running state or schedule a retry", async t => {
  const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": { ...createDefaultUnfollowSettings(), ownHandle: "me" },
    "xContentCreator.unfollowRuntime.v1": { ...createInitialUnfollowRuntime(), running: true } };
  const { chromeMock, commands, port, emit } = setup(t, disk);
  emit({ type: "x_hello", handle: "me", href: "https://x.com/me/following" });
  let scanStarted!: () => void;
  const pending = new Promise<void>(resolve => { scanStarted = resolve; });
  let requestId: string | undefined;
  const postMessage = port.postMessage;
  port.postMessage = m => { postMessage(m); if (m.type === "x_follow_scan_cells") { requestId = m.requestId; scanStarted(); } };
  let alarms = 0;
  chromeMock.alarms.create = async () => { alarms++; };
  const ticking = runUnfollowTick();
  await pending;
  await stopUnfollowRunner();
  assert.ok(commands.includes("x_stop"));
  emit({ type: "x_follow_scan_result", requestId, ok: false, error: "stopped" });
  await ticking;
  assert.equal((disk["xContentCreator.unfollowRuntime.v1"] as any).running, false);
  assert.equal((disk["xContentCreator.unfollowRuntime.v1"] as any).detail, "Đã dừng");
  assert.equal(alarms, 0);
});

test("manual SMM orders derive the post ID and reuse the recorded order", async t => {
  const disk: Record<string, unknown> = { "xContentCreator.smm.v1": { ...createDefaultSmmSettings(), apiKey: "fake-test-key", viewServiceId: "1" } };
  setup(t, disk);
  let adds = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json({ order: ++adds }));
  const opts = { link: "https://x.com/alice/status/2112057695247180169", metric: "views" as const };
  const first = await smmPlaceOrder(opts);
  assert.equal(first.ok, true);
  const second = await smmPlaceOrder(opts);
  assert.equal(second.order, first.order);
  assert.equal(adds, 1);
  // Explicit IDs supplied by clients cannot bypass the URL's identity.
  assert.equal((await smmPlaceOrder({ ...opts, postId: "wrong_id" })).order, first.order);
  assert.equal(adds, 1);
  assert.equal((await smmPlaceOrder({ ...opts, metric: "likes", service: "2" })).ok, true);
  assert.equal(adds, 2, "different metrics remain independently orderable");
});

test("Unfollow sends no scan, navigation or action after reaching the 30 minute cap", async t => {
  const settings = createDefaultUnfollowSettings();
  settings.pace.maxPer30Min = 1;
  const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": settings,
    "xContentCreator.unfollowRuntime.v1": { ...createInitialUnfollowRuntime(), running: true,
      unfollowTimestamps: [Date.now() - 1000] } };
  const { commands } = setup(t, disk);
  const before = commands.length;
  await runUnfollowTick();
  assert.deepEqual(commands.slice(before), []);
  const rt = disk["xContentCreator.unfollowRuntime.v1"] as any;
  assert.match(rt.detail, /30 phút/);
  assert.ok(rt.nextAt > Date.now() + 1700000);
  await stopUnfollowRunner();
});

test("lowering the 30 minute cap during a scan prevents the pending Unfollow", async t => {
  const settings = createDefaultUnfollowSettings();
  settings.ownHandle = "me";
  settings.pace.maxPer30Min = 2;
  settings.protect.sorsaMin = null;
  settings.protect.protectMissingSorsa = false;
  const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": settings,
    "xContentCreator.unfollowRuntime.v1": { ...createInitialUnfollowRuntime(), running: true,
      unfollowTimestamps: [Date.now() - 1000] } };
  const { commands, port, emit } = setup(t, disk);
  emit({ type: "x_hello", handle: "me", href: "https://x.com/me/following" });
  const originalPost = port.postMessage;
  port.postMessage = m => {
    originalPost(m);
    if (m.type === "x_follow_scan_cells") {
      settings.pace.maxPer30Min = 1;
      emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: true,
        candidates: [{ handle: "alice", alreadyFollowing: true, verified: false, followsYou: false }] });
    }
  };
  await runUnfollowTick();
  assert.ok(commands.includes("x_follow_scan_cells"));
  assert.ok(!commands.includes("x_unfollow_cell"));
  assert.ok(!commands.includes("x_unfollow"));
  const rt = disk["xContentCreator.unfollowRuntime.v1"] as any;
  assert.deepEqual(rt.seen, []);
  assert.match(rt.detail, /Đạt giới hạn 1\/30 phút/);
  await stopUnfollowRunner();
});

test("the last allowed Unfollow immediately enters the 30 minute wait and blocks the next tick", async t => {
  const settings = createDefaultUnfollowSettings();
  settings.ownHandle = "me";
  settings.pace.maxPer30Min = 1;
  settings.protect.sorsaMin = null;
  settings.protect.protectMissingSorsa = false;
  const disk: Record<string, unknown> = { "xContentCreator.unfollow.v1": settings,
    "xContentCreator.unfollowRuntime.v1": { ...createInitialUnfollowRuntime(), running: true } };
  const { commands, port, emit } = setup(t, disk);
  emit({ type: "x_hello", handle: "me", href: "https://x.com/me/following" });
  const originalPost = port.postMessage;
  port.postMessage = m => {
    originalPost(m);
    if (m.type === "x_follow_scan_cells") {
      emit({ type: "x_follow_scan_result", requestId: m.requestId, ok: true,
        candidates: ["alice", "bob"].map(handle => ({ handle, alreadyFollowing: true, verified: false, followsYou: false })) });
    }
    if (m.type === "x_unfollow_cell") {
      emit({ type: "x_unfollow_cell_result", requestId: m.requestId, ok: true, detail: "unfollow_confirmed" });
    }
  };
  await runUnfollowTick();
  const rt = disk["xContentCreator.unfollowRuntime.v1"] as any;
  assert.equal(rt.unfollowedToday, 1);
  assert.equal(rt.unfollowTimestamps.length, 1);
  assert.match(rt.detail, /Đạt giới hạn 1\/30 phút/);
  assert.ok(rt.nextAt > Date.now() + 1700000);
  assert.equal(commands.filter(c => c === "x_unfollow_cell").length, 1);
  assert.ok(!commands.includes("x_follow_profile_meta"), "known list relationships do not open profiles");
  const before = commands.length;
  await runUnfollowTick();
  assert.equal(commands.length, before);
  // Kể cả khởi động lại nhịp chờ, bộ đếm đã lưu vẫn chặn thao tác.
  rt.nextAt = null;
  await runUnfollowTick();
  assert.equal(commands.length, before);
  await stopUnfollowRunner();
});
