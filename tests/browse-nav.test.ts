import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAgentSettings, sanitizeAgentSettings, sanitizeListUrlOrName } from "../src/domain/agent-settings.ts";
import {
  browseNavError,
  enabledBrowseSurfaces,
  ensureBrowseSurface,
  findTimelineTab,
  pickBrowseSurface,
} from "../src/x/browse-nav.ts";
import { pathIsList, pathIsMentions, pathIsNotificationsAll, pathMatchesBrowseSurface } from "../src/x/identity.ts";
import { buildMentionJobs, planNextAction } from "../src/agent/planner.ts";
import { createEmptyDailyStats } from "../src/domain/agent-settings.ts";
import { createEmptyQueue } from "../src/domain/agent-queue.ts";

test("sanitizeListUrlOrName accepts i/lists id and user slug", () => {
  assert.equal(sanitizeListUrlOrName("https://x.com/i/lists/1234567890"), "https://x.com/i/lists/1234567890");
  assert.equal(sanitizeListUrlOrName("/alice/lists/builders"), "https://x.com/alice/lists/builders");
  assert.equal(sanitizeListUrlOrName("not-a-list"), "");
  assert.equal(sanitizeListUrlOrName("https://example.com/i/lists/1"), "");
});

test("sanitizeAgentSettings adds followingFeed + notifications defaults", () => {
  const s = sanitizeAgentSettings({ modules: { homeScroll: true, lists: true } });
  assert.equal(s.modules.followingFeed, false);
  assert.equal(s.modules.notifications, false);
  assert.equal(s.modules.lists, true);
  assert.ok(s.browseSchedule?.homeSec);
  assert.equal(s.browseSchedule?.homeSec, 600);
  assert.equal(s.browseSchedule?.listsSec, 300);
});

test("path helpers for lists and notifications All/Mentions", () => {
  assert.equal(pathIsList("/i/lists/1234567890"), true);
  assert.equal(pathIsList("/alice/lists/cool"), true);
  assert.equal(pathIsList("/alice/following"), false);
  assert.equal(pathIsMentions("/notifications/mentions"), true);
  assert.equal(pathIsNotificationsAll("/notifications"), true);
  assert.equal(pathIsNotificationsAll("/notifications/mentions"), false);
  assert.equal(pathMatchesBrowseSurface("/notifications", "mentions"), true);
  assert.equal(pathMatchesBrowseSurface("/notifications/mentions", "mentions"), true);
  assert.equal(pathMatchesBrowseSurface("/notifications/verified", "mentions"), false);
  assert.equal(pathMatchesBrowseSurface("/home", "following"), true);
  assert.equal(pathMatchesBrowseSurface("/alice/following", "following"), false);
});

test("pickBrowseSurface respects sticky and fixed order (no random weights)", () => {
  assert.equal(
    pickBrowseSurface({ enabled: ["home", "following"], sticky: "following", rng: () => 0 }),
    "following",
  );
  assert.equal(
    pickBrowseSurface({
      enabled: ["home", "mentions"],
      weights: { home: 100, following: 0, lists: 0, mentions: 0 },
      rng: () => 0.5,
    }),
    "mentions",
  );
  assert.equal(
    pickBrowseSurface({
      enabled: ["following", "lists", "home"],
      weights: { home: 0, following: 0, lists: 100, mentions: 0 },
    }),
    "home",
  );
});

test("enabledBrowseSurfaces skips lists without URL", () => {
  const s = createDefaultAgentSettings();
  s.modules.lists = true;
  s.listUrlOrName = "";
  assert.ok(!enabledBrowseSurfaces(s).includes("lists"));
  s.listUrlOrName = "https://x.com/i/lists/9999999999";
  assert.ok(enabledBrowseSurfaces(s).includes("lists"));
});

test("ensureBrowseSurface clicks Following tab on Home", () => {
  const clicks: string[] = [];
  const followingTab = {
    getAttribute(name: string) {
      if (name === "aria-label") return "Following";
      if (name === "aria-selected") return "false";
      return null;
    },
    textContent: "Following",
  };
  const doc = {
    querySelector: () => null,
    querySelectorAll: (sel: string) => {
      if (sel.includes("role=\"tab\"") || sel.includes("[role=\"tab\"]")) return [followingTab];
      return [];
    },
  } as unknown as Document;

  // Patch findTimelineTab path: primaryColumn null → doc itself via querySelectorAll on doc
  const kind = ensureBrowseSurface({
    surface: "following",
    pathname: "/home",
    doc,
    click: (el) => {
      clicks.push((el as { textContent?: string }).textContent || "el");
    },
  });
  assert.equal(kind, "tab");
  assert.equal(clicks.length, 1);
});

test("ensureBrowseSurface Notifications All falls back to assign", () => {
  let assigned = "";
  const kind = ensureBrowseSurface({
    surface: "mentions",
    pathname: "/home",
    doc: { querySelector: () => null, querySelectorAll: () => [] } as unknown as Document,
    origin: "https://x.com",
    findLink: () => null,
    assign: (url) => {
      assigned = url;
    },
  });
  assert.equal(kind, "reload");
  assert.equal(assigned, "https://x.com/notifications");
  assert.equal(browseNavError("mentions", "reload"), "navigating_mentions");
});

test("ensureBrowseSurface clicks All when on Mentions path", () => {
  const clicks: string[] = [];
  const allTab = {
    getAttribute(name: string) {
      if (name === "aria-label") return "All";
      if (name === "aria-selected") return "false";
      return null;
    },
    textContent: "All",
  };
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [allTab],
  } as unknown as Document;
  const kind = ensureBrowseSurface({
    surface: "mentions",
    pathname: "/notifications/mentions",
    doc,
    click: (el) => {
      clicks.push((el as { textContent?: string }).textContent || "el");
    },
  });
  assert.equal(kind, "tab");
  assert.equal(clicks[0], "All");
});

test("findTimelineTab matches Vietnamese Following label", () => {
  const tab = {
    getAttribute(name: string) {
      if (name === "aria-label") return "Đang theo dõi";
      if (name === "aria-selected") return "true";
      return null;
    },
    textContent: "Đang theo dõi",
  };
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [tab],
  } as unknown as Document;
  const found = findTimelineTab(doc, /^(following|đang theo dõi)$/i);
  assert.ok(found);
  assert.equal(found!.selected, true);
});

test("buildMentionJobs creates a direct-mention draft only, without auto-post or like", () => {
  const settings = createDefaultAgentSettings();
  settings.actions = { like: true, reply: true, follow: true, retweet: true, quote: false };
  const jobs = buildMentionJobs({
    candidate: {
      tweetId: "12345678901",
      authorHandle: "bob",
      tweetUrl: "https://x.com/bob/status/12345678901",
      text: "Hey thanks for the tip today",
      alreadyLiked: false,
      promoted: false,
      directedToOwn: true,
    },
    settings,
    queue: createEmptyQueue(),
    executeActions: true,
    hasApiKey: true,
    ownHandle: "owner",
  });
  assert.ok(jobs.some((j) => j.kind === "draft_reply"));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].expectedAccount, "owner");
  assert.ok(jobs.every((j) => j.browseSurface === "mentions"));
  assert.ok(!jobs.some((j) => j.kind === "follow"));
});

test("planNextAction can browse Following without homeScroll", () => {
  const settings = createDefaultAgentSettings();
  settings.modules = {
    ...settings.modules,
    pogoTasks: false,
    homeScroll: false,
    followingFeed: true,
    lists: false,
    notifications: false,
  };
  settings.priority = "browse_only";
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [],
    executeActions: true,
    ownHandle: "me",
    hasApiKey: true,
    browseRolls: { engage: false, like: false, reply: false, retweet: false, follow: false },
    browseSurface: "following",
  });
  assert.equal(planned.type, "job");
  if (planned.type === "job") {
    assert.equal(planned.job.kind, "scroll_home");
    assert.equal(planned.job.browseSurface, "following");
  }
});
