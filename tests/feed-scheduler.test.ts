import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAgentSettings } from "../src/domain/agent-settings.ts";
import {
  EMPTY_SCROLL_THRESHOLD,
  beginNavigateToSource,
  browseScheduleOf,
  confirmSourceReady,
  createFeedRotationState,
  enabledFeedRotationSurfaces,
  ensureFeedRotation,
  firstFeedRotationSource,
  markSourceExhausted,
  nextFeedRotationSource,
  noteEligibleScan,
  noteNavigationFailure,
  notePostUnit,
  noteScrollUnit,
  pauseScanClock,
  resumeScanClock,
  sanitizeBrowseSchedule,
  switchToNextSource,
  tickScanClock,
} from "../src/domain/feed-rotation.ts";
import { pickBrowseSurface } from "../src/x/browse-nav.ts";

function settingsWith(...surfaces: Array<"home" | "following" | "lists">) {
  const s = createDefaultAgentSettings();
  s.modules.homeScroll = surfaces.includes("home");
  s.modules.followingFeed = surfaces.includes("following");
  s.modules.lists = surfaces.includes("lists");
  s.listUrlOrName = surfaces.includes("lists") ? "https://x.com/i/lists/1234567890" : "";
  s.browseSchedule = {
    homeSec: 600,
    followingSec: 600,
    listsSec: 300,
    earlySwitchOnEmpty: true,
    keepSourceOnResume: true,
  };
  return s;
}

test("sanitizeBrowseSchedule defaults and clamps", () => {
  const d = sanitizeBrowseSchedule(undefined);
  assert.equal(d.homeSec, 600);
  assert.equal(d.followingSec, 600);
  assert.equal(d.listsSec, 300);
  assert.equal(d.earlySwitchOnEmpty, true);
  assert.equal(d.keepSourceOnResume, true);
  assert.equal(sanitizeBrowseSchedule({ homeSec: 5 }).homeSec, 60);
  assert.equal(sanitizeBrowseSchedule({ homeSec: 99999 }).homeSec, 7200);
});

test("1. For You → Following → Lists → For You đúng thứ tự", () => {
  const settings = settingsWith("home", "following", "lists");
  let rot = createFeedRotationState();
  const first = firstFeedRotationSource(settings)!;
  assert.equal(first.surface, "home");
  rot = beginNavigateToSource(rot, first.surface, first.index);
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 1_000);
  assert.equal(rot.currentSource, "home");

  rot = switchToNextSource(rot, settings, { reason: "time_elapsed", now: 2_000 });
  assert.equal(rot.targetSource, "following");
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 2_000);
  assert.equal(rot.currentSource, "following");

  rot = switchToNextSource(rot, settings, { reason: "time_elapsed", now: 3_000 });
  assert.equal(rot.targetSource, "lists");
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 3_000);

  rot = switchToNextSource(rot, settings, { reason: "time_elapsed", now: 4_000 });
  assert.equal(rot.targetSource, "home");
});

test("2. Nguồn bị tắt được bỏ qua", () => {
  const settings = settingsWith("home", "lists");
  assert.deepEqual(enabledFeedRotationSurfaces(settings), ["home", "lists"]);
  let rot = beginNavigateToSource(createFeedRotationState(), "home", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 1000);
  rot = switchToNextSource(rot, settings, { reason: "time_elapsed", now: 2000 });
  assert.equal(rot.targetSource, "lists");
});

test("3. Chỉ bật một nguồn không gây chuyển tab vô nghĩa", () => {
  const settings = settingsWith("following");
  let rot = beginNavigateToSource(createFeedRotationState(), "following", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 1000);
  const before = rot.remainingScanTimeMs;
  rot = switchToNextSource(rot, settings, { reason: "time_elapsed", now: 2000 });
  assert.equal(rot.currentSource, "following");
  assert.equal(rot.targetSource, "following");
  assert.equal(rot.phase, "scanning");
  assert.equal(rot.remainingScanTimeMs, before > 0 ? rot.remainingScanTimeMs : browseScheduleOf(settings).followingSec * 1000);
  assert.ok(rot.clockRunning);
});

test("4. Hết thời gian nhưng đang xử lý bài thì chờ (pendingSwitch)", () => {
  const settings = settingsWith("home", "following");
  let rot = beginNavigateToSource(createFeedRotationState(), "home", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 1000);
  rot = pauseScanClock({ ...rot, remainingScanTimeMs: 100, clockStartedAt: 1000 }, 1100);
  // Trong lúc xử lý bài đồng hồ dừng; hết giờ → pending.
  rot = { ...rot, remainingScanTimeMs: 0, pendingSwitch: true, phase: "switch_pending" };
  assert.equal(rot.pendingSwitch, true);
  // Chưa switchToNextSource vì caller đợi xử lý xong.
  assert.equal(rot.currentSource, "home");
  rot = switchToNextSource(rot, settings, { reason: "time_elapsed", now: 5000 });
  assert.equal(rot.targetSource, "following");
});

test("5. Quay lại feed không reset thời gian", () => {
  const settings = settingsWith("home");
  let rot = beginNavigateToSource(createFeedRotationState(), "home", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 10_000);
  rot = tickScanClock(rot, 10_000 + 120_000); // quét 2 phút
  assert.equal(rot.remainingScanTimeMs, 480_000);
  rot = pauseScanClock(rot, 10_000 + 120_000); // mở bài
  const remaining = rot.remainingScanTimeMs;
  // Xử lý bài 2 phút wall-clock — không trừ.
  rot = resumeScanClock(rot, 10_000 + 240_000);
  assert.equal(rot.remainingScanTimeMs, remaining);
  assert.equal(rot.clockRunning, true);
});

test("6. Ba lượt cuộn không có nội dung mới thì chuyển sớm", () => {
  const settings = settingsWith("home", "following");
  let rot = beginNavigateToSource(createFeedRotationState(), "home", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 1000);
  for (let i = 1; i <= EMPTY_SCROLL_THRESHOLD; i++) {
    rot = noteScrollUnit(rot, {
      foundNew: false,
      earlySwitchOnEmpty: true,
      unitId: `scroll-${i}`,
    });
  }
  assert.equal(rot.pendingSwitch, true);
  assert.equal(rot.emptyScrolls, EMPTY_SCROLL_THRESHOLD);
  rot = switchToNextSource(rot, settings, { reason: "empty_content", now: 2000 });
  assert.equal(rot.targetSource, "following");
  assert.ok(rot.exhaustedThisRound.includes("home"));
});

test("7. Loading hoặc network error không bị nhận nhầm là hết bài", () => {
  let rot = beginNavigateToSource(createFeedRotationState(), "home", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settingsWith("home")), 1000);
  rot = noteScrollUnit(rot, {
    foundNew: false,
    feedUnreliable: true,
    earlySwitchOnEmpty: true,
    unitId: "load-1",
  });
  assert.equal(rot.emptyScrolls, 0);
  assert.equal(rot.pendingSwitch, false);
});

test("8. Pause/Resume giữ thời gian còn lại", () => {
  let rot = beginNavigateToSource(createFeedRotationState(), "home", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settingsWith("home")), 1000);
  rot = tickScanClock(rot, 61_000); // ~1 phút
  const left = rot.remainingScanTimeMs;
  rot = pauseScanClock(rot, 61_000);
  assert.equal(rot.clockRunning, false);
  rot = resumeScanClock(rot, 360_000); // pause lâu
  assert.equal(rot.remainingScanTimeMs, left);
  assert.equal(rot.currentSource, "home");
});

test("9. Navigation thất bại không làm Agent chuyển nguồn liên tục", () => {
  let rot = beginNavigateToSource(createFeedRotationState(), "lists", 0);
  rot = noteNavigationFailure(rot, "navigating_lists");
  assert.equal(rot.phase, "navigating");
  assert.equal(rot.navAttempts, 1);
  rot = noteNavigationFailure(rot, "navigating_lists");
  assert.equal(rot.phase, "error");
  assert.equal(rot.targetSource, "lists");
  // Không nhảy sang nguồn khác.
  assert.notEqual(rot.phase, "scanning");
});

test("10. Tất cả nguồn hết bài → waiting_round, không vòng lặp tab", () => {
  const settings = settingsWith("home", "following");
  let rot = beginNavigateToSource(createFeedRotationState(), "home", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settings), 1000);
  rot = markSourceExhausted(rot, "home");
  rot = markSourceExhausted(rot, "following");
  const next = nextFeedRotationSource(rot, settings);
  assert.equal(next.waitForNextRound, true);
  assert.equal(next.surface, null);
  rot = switchToNextSource(rot, settings, { reason: "empty_content", now: 2000 });
  assert.equal(rot.phase, "waiting_round");
});

test("pickBrowseSurface không còn random theo weight", () => {
  const picks = new Set<string>();
  for (let i = 0; i < 20; i++) {
    picks.add(pickBrowseSurface({
      enabled: ["home", "following", "lists"],
      weights: { home: 0, following: 0, lists: 100 },
      rng: () => Math.random(),
    })!);
  }
  assert.deepEqual([...picks], ["home"]);
  assert.equal(
    pickBrowseSurface({ enabled: ["home", "following"], sticky: "following" }),
    "following",
  );
});

test("ensureFeedRotation khởi tạo For You đầu tiên", () => {
  const settings = settingsWith("home", "following", "lists");
  const rot = ensureFeedRotation(undefined, settings, { now: 1 });
  assert.equal(rot.targetSource, "home");
  assert.equal(rot.phase, "navigating");
});

test("noteEligibleScan resets emptyScrolls; post unit cũng reset", () => {
  let rot = beginNavigateToSource(createFeedRotationState(), "home", 0);
  rot = confirmSourceReady(rot, browseScheduleOf(settingsWith("home")), 1);
  rot = noteScrollUnit(rot, { foundNew: false, earlySwitchOnEmpty: true, unitId: "a" });
  rot = noteScrollUnit(rot, { foundNew: false, earlySwitchOnEmpty: true, unitId: "b" });
  assert.equal(rot.emptyScrolls, 2);
  rot = noteEligibleScan(rot, 3);
  assert.equal(rot.emptyScrolls, 0);
  rot = noteScrollUnit(rot, { foundNew: false, earlySwitchOnEmpty: true, unitId: "c" });
  rot = notePostUnit(rot, "post-1");
  assert.equal(rot.emptyScrolls, 0);
});
