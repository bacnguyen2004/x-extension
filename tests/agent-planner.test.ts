import assert from "node:assert/strict";
import test from "node:test";
import {
  alreadyTracked,
  planNextAction,
  replyGaveUp,
  tweetUnreachable,
} from "../src/agent/planner.ts";
import { fillPromptTemplate, cleanAiOutput } from "../src/agent/prompts.ts";
import { createDefaultAgentSettings, createEmptyDailyStats } from "../src/domain/agent-settings.ts";
import {
  createEmptyQueue,
  makeJob,
  upsertJob,
  markJob,
  pruneDisabledActionJobs,
  pruneJobsForRecordedReplies,
} from "../src/domain/agent-queue.ts";
import { emptyActions, type Campaign } from "../src/domain/types.ts";

function camp(partial: Partial<Campaign> & { tweet_id: string }): Campaign {
  return {
    author_handle: "author1",
    tweet_url: `https://x.com/author1/status/${partial.tweet_id}`,
    tweet_url_source: "dom",
    text: "hello",
    actions: {
      ...emptyActions(),
      reply: { status: "not_recorded", displayedPoints: 10 },
      retweet: { status: "not_recorded", displayedPoints: 5 },
    },
    follows_author: false,
    locked_points: 0,
    author_tier: null,
    author_division: null,
    pinned: false,
    boosted: false,
    bonus_label: null,
    last_observed_at: 1,
    source: "api",
    stale: false,
    ...partial,
  };
}

test("prompt fill + clean", () => {
  const t = fillPromptTemplate("Hi {{author}} :: {{text}}", {
    author: "bob",
    text: "yo",
    tweet_url: "",
    tweet_id: "1",
  });
  assert.equal(t.includes("bob"), true);
  assert.equal(cleanAiOutput('```\nhello\n```'), "hello");
});

for (const source of ["pogo", "manual"] as const) for (const queued of [false, true]) test(`${source} skips own posts, including ${queued ? "queued drafts" : "new campaigns"}`, () => {
  const settings = createDefaultAgentSettings();
  settings.ownHandle = "@MySelf";
  settings.skipOwnPosts = false; // Source account exclusion is always applied.
  settings.modules.homeScroll = false;
  settings.modules.pogoTasks = source === "pogo";
  settings.modules.linkList = source === "manual";
  settings.actions = { like: true, reply: true, follow: false, quote: false, retweet: false };
  const own = camp({ tweet_id: "123456789", author_handle: null, tweet_url: "https://x.com/myself/status/123456789" });
  const result = planNextAction({ settings, stats: createEmptyDailyStats(), queue: { jobs: queued ? [makeJob({ kind: "post_reply", source, status: "pending", tweetId: own.tweet_id, tweetUrl: own.tweet_url, authorHandle: null, tweetText: own.text, draftText: "Do not send" })] : [] }, campaigns: source === "pogo" ? [own] : [], linkCampaigns: source === "manual" ? [own] : [], executeActions: true, ownHandle: null, hasApiKey: true });
  assert.equal(result.type, "idle");
});

test("isAiSkip detects SKIP and never treats normal replies as skip", async () => {
  const { isAiSkip } = await import("../src/agent/prompts.ts");
  assert.equal(isAiSkip("SKIP"), true);
  assert.equal(isAiSkip("skip"), true);
  assert.equal(isAiSkip("SKIP."), true);
  assert.equal(isAiSkip('"SKIP"'), true);
  assert.equal(isAiSkip("I would skip that claim about fees."), false);
  assert.equal(isAiSkip("The timing of the unlock matters more than the headline APY."), false);
});

test("planner prefers ready draft post when execute on", () => {
  let queue = createEmptyQueue();
  queue = upsertJob(
    queue,
    makeJob({
      kind: "draft_reply",
      status: "done",
      tweetId: "111",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/111",
      tweetText: "t",
      draftText: "nice post",
      source: "pogo",
    }),
  );
  const planned = planNextAction({
    settings: {
      ...createDefaultAgentSettings(),
      activeHoursStart: "00:00",
      activeHoursEnd: "00:00",
    },
    stats: createEmptyDailyStats(),
    queue,
    campaigns: [camp({ tweet_id: "111" })],
    executeActions: true,
    ownHandle: null,
  });
  assert.equal(planned.type, "job");
  if (planned.type === "job") assert.equal(planned.job.kind, "post_reply");
});

test("failed reply_too_old / submit_disabled does not requeue same tweet", () => {
  let queue = createEmptyQueue();
  queue = upsertJob(
    queue,
    makeJob({
      kind: "post_reply",
      status: "failed",
      tweetId: "old1",
      authorHandle: null,
      tweetUrl: null,
      tweetText: null,
      error: "reply_too_old",
      source: "pogo",
    }),
  );
  assert.equal(replyGaveUp(queue, "old1"), true);
  assert.equal(alreadyTracked(queue, "post_reply", "old1"), true);
});

test("like navigate_timeout does not requeue same tweet", () => {
  let queue = createEmptyQueue();
  queue = upsertJob(
    queue,
    makeJob({
      kind: "like",
      status: "failed",
      tweetId: "nav1",
      tweetText: null,
      authorHandle: "miztarholarewa",
      tweetUrl: "https://x.com/miztarholarewa/status/nav1",
      error: "navigate_timeout",
      source: "pogo",
    }),
  );
  assert.equal(tweetUnreachable(queue, "nav1"), true);
  assert.equal(alreadyTracked(queue, "like", "nav1"), true);
  assert.equal(alreadyTracked(queue, "follow", "nav1"), true);

  const planned = planNextAction({
    settings: {
      ...createDefaultAgentSettings(),
      activeHoursStart: "00:00",
      activeHoursEnd: "00:00",
      actions: {
        like: true,
        retweet: true,
        follow: true,
        reply: true,
        quote: false,
      },
    },
    stats: createEmptyDailyStats(),
    queue,
    campaigns: [
      camp({
        tweet_id: "nav1",
        author_handle: "miztarholarewa",
        tweet_url: "https://x.com/miztarholarewa/status/nav1",
      }),
      camp({
        tweet_id: "nav2",
        author_handle: "other",
        tweet_url: "https://x.com/other/status/nav2",
      }),
    ],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  // Không kẹt lại nav1 — sang campaign khác hoặc idle/bundle khác.
  if (planned.type === "bundle") {
    assert.notEqual(planned.tweetId, "nav1");
  } else if (planned.type === "job") {
    assert.notEqual(planned.job.tweetId, "nav1");
  }
});

test("skipped post_reply (reply_restricted) does not loop — moves to next campaign", () => {
  let queue = createEmptyQueue();
  queue = upsertJob(
    queue,
    makeJob({
      kind: "draft_reply",
      status: "done",
      tweetId: "111",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/111",
      tweetText: "t",
      draftText: "nice post",
      source: "pogo",
    }),
  );
  queue = upsertJob(
    queue,
    makeJob({
      kind: "post_reply",
      status: "skipped",
      tweetId: "111",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/111",
      tweetText: "t",
      draftText: "nice post",
      error: "reply_restricted",
      source: "pogo",
    }),
  );
  queue = upsertJob(
    queue,
    makeJob({
      kind: "like",
      status: "done",
      tweetId: "111",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/111",
      tweetText: null,
      source: "pogo",
    }),
  );
  const planned = planNextAction({
    settings: {
      ...createDefaultAgentSettings(),
      activeHoursStart: "00:00",
      activeHoursEnd: "00:00",
      actions: {
        like: true,
        retweet: true,
        follow: false,
        reply: true,
        quote: false,
      },
    },
    stats: createEmptyDailyStats(),
    queue,
    campaigns: [
      camp({
        tweet_id: "111",
        follows_author: true,
        actions: {
          ...emptyActions(),
          reply: { status: "not_recorded", displayedPoints: 10 },
          retweet: { status: "recorded", displayedPoints: 0 },
        },
      }),
      camp({
        tweet_id: "222",
        follows_author: true,
        actions: {
          ...emptyActions(),
          reply: { status: "recorded", displayedPoints: 0 },
          retweet: { status: "recorded", displayedPoints: 0 },
        },
      }),
    ],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  // Không tạo lại post_reply cho 111; 222 đã reply done → không Like lẻ.
  if (planned.type === "job") {
    assert.notEqual(planned.job.tweetId, "111");
    assert.notEqual(planned.job.kind, "like");
  } else if (planned.type === "bundle") {
    assert.notEqual(planned.tweetId, "111");
    assert.equal(planned.jobs.some((j) => j.kind === "like" && j.tweetId === "222"), false);
  } else {
    assert.ok(
      planned.reason.includes("pogo_queue_empty") ||
        planned.reason.includes("nothing_to_do") ||
        planned.reason.includes("missing_api_key"),
      planned.reason,
    );
  }
});

test("Like only accompanies Reply — no like-only campaign jobs", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    actions: {
      like: true,
      retweet: false,
      follow: false,
      reply: true,
      quote: false,
    },
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [
      camp({
        tweet_id: "900",
        follows_author: true,
        actions: {
          ...emptyActions(),
          reply: { status: "recorded", displayedPoints: 10 },
          retweet: { status: "recorded", displayedPoints: 0 },
        },
      }),
    ],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  if (planned.type === "job") assert.notEqual(planned.job.kind, "like");
  if (planned.type === "bundle") {
    assert.equal(planned.jobs.some((j) => j.kind === "like"), false);
  }
});

test("planner drafts reply from open pogo task", () => {
  const planned = planNextAction({
    settings: {
      ...createDefaultAgentSettings(),
      activeHoursStart: "00:00",
      activeHoursEnd: "00:00",
    },
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [
      camp({
        tweet_id: "222",
        follows_author: true,
        actions: {
          ...emptyActions(),
          reply: { status: "not_recorded", displayedPoints: 10 },
          retweet: { status: "recorded", displayedPoints: 0 },
          quote: { status: "recorded", displayedPoints: 0 },
        },
      }),
    ],
    executeActions: false,
    ownHandle: null,
  });
  assert.equal(planned.type, "job");
  if (planned.type === "job") assert.equal(planned.job.kind, "draft_reply");
});

test("follow pending navigating resumes same job — no duplicate", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    activeHoursStart: "00:00",
    activeHoursEnd: "00:00",
    priority: "pogo_only" as const,
  };
  const pending = makeJob({
    kind: "follow",
    status: "pending",
    tweetId: "999",
    authorHandle: "bob",
    tweetUrl: "https://x.com/bob/status/999",
    tweetText: "t",
    source: "pogo",
    error: "navigating_profile",
  });
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: { jobs: [pending] },
    campaigns: [camp({ tweet_id: "999", author_handle: "bob", follows_author: false })],
    executeActions: true,
    ownHandle: null,
    hasApiKey: false,
  });
  // Có thể là job đơn hoặc bundle (follow + like/rt còn lại) — follow resume phải đứng đầu.
  if (planned.type === "job") {
    assert.equal(planned.job.id, pending.id);
    assert.equal(planned.job.kind, "follow");
  } else if (planned.type === "bundle") {
    assert.equal(planned.jobs[0]?.id, pending.id);
    assert.equal(planned.jobs[0]?.kind, "follow");
  } else {
    assert.fail("expected job or bundle");
  }
});

test("one pogo task without Reply does RT+Follow but not Like", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    activeHoursStart: "00:00",
    activeHoursEnd: "00:00",
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [
      camp({
        tweet_id: "333",
        follows_author: false,
        actions: {
          ...emptyActions(),
          retweet: { status: "not_recorded", displayedPoints: 5 },
          reply: { status: "recorded", displayedPoints: 0 },
          quote: { status: "recorded", displayedPoints: 0 },
        },
      }),
    ],
    executeActions: true,
    ownHandle: null,
    hasApiKey: false,
  });
  assert.equal(planned.type, "bundle");
  if (planned.type !== "bundle") return;
  const kinds = planned.jobs.map((j) => j.kind);
  // Like không phải task điểm — không đi kèm khi Reply đã xong.
  assert.deepEqual(kinds, ["retweet", "follow"]);
  assert.equal(planned.tweetId, "333");
});

test("Behavior quote off → bundle has no quote jobs", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    
    actions: {
      like: true,
      retweet: false,
      follow: false,
      reply: true,
      quote: false,
    },
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [
      camp({
        tweet_id: "555",
        follows_author: true,
        actions: {
          ...emptyActions(),
          reply: { status: "not_recorded", displayedPoints: 10 },
          retweet: { status: "recorded", displayedPoints: 0 },
          quote: { status: "not_recorded", displayedPoints: 5 },
        },
      }),
    ],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "bundle");
  if (planned.type !== "bundle") return;
  const kinds = planned.jobs.map((j) => j.kind);
  assert.ok(kinds.includes("draft_reply"));
  assert.ok(kinds.includes("post_reply"));
  assert.ok(kinds.includes("like")); // kèm Reply
  assert.equal(kinds.includes("retweet"), false);
  assert.equal(kinds.includes("follow"), false);
  assert.equal(kinds.includes("draft_quote"), false);
  assert.equal(kinds.includes("post_quote"), false);
});

test("pruneJobsForRecordedReplies drops draft+post+like for done reply tweets", () => {
  let queue = createEmptyQueue();
  for (const kind of ["like", "draft_reply", "post_reply"] as const) {
    queue = upsertJob(
      queue,
      makeJob({
        kind,
        status: "pending",
        tweetId: "sorsa1",
        authorHandle: "Sorsa_io",
        tweetUrl: "https://x.com/Sorsa_io/status/sorsa1",
        tweetText: "x",
        source: "pogo",
      }),
    );
  }
  const { queue: next, skipped } = pruneJobsForRecordedReplies(queue, ["sorsa1"]);
  assert.equal(skipped, 3);
  assert.equal(next.jobs.filter((j) => j.status === "pending").length, 0);
});

test("pruneDisabledActionJobs drops FL/RT when Behavior off and orphan likes", () => {
  let queue = createEmptyQueue();
  queue = upsertJob(
    queue,
    makeJob({
      kind: "follow",
      status: "pending",
      tweetId: "1",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/1",
      tweetText: null,
      source: "pogo",
    }),
  );
  queue = upsertJob(
    queue,
    makeJob({
      kind: "retweet",
      status: "pending",
      tweetId: "1",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/1",
      tweetText: null,
      source: "pogo",
    }),
  );
  queue = upsertJob(
    queue,
    makeJob({
      kind: "like",
      status: "pending",
      tweetId: "1",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/1",
      tweetText: null,
      source: "pogo",
    }),
  );
  const { queue: next, skipped } = pruneDisabledActionJobs(queue, {
    like: true,
    retweet: false,
    follow: false,
    reply: true,
    quote: false,
  });
  assert.equal(skipped, 3);
  assert.equal(next.jobs.filter((j) => j.status === "pending").length, 0);
  assert.ok(next.jobs.every((j) => j.status === "skipped"));
});

test("bundle includes draft+post reply when API key and auto post", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    activeHoursStart: "00:00",
    activeHoursEnd: "00:00",
    
    executeActions: true,
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [
      camp({
        tweet_id: "444",
        follows_author: true,
        actions: {
          ...emptyActions(),
          reply: { status: "not_recorded", displayedPoints: 10 },
          retweet: { status: "not_recorded", displayedPoints: 5 },
          quote: { status: "recorded", displayedPoints: 0 },
        },
      }),
    ],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "bundle");
  if (planned.type !== "bundle") return;
  const kinds = planned.jobs.map((j) => j.kind);
  assert.ok(kinds.includes("like"));
  assert.ok(kinds.includes("retweet"));
  assert.ok(kinds.includes("draft_reply"));
  assert.ok(kinds.includes("post_reply"));
  assert.equal(kinds.indexOf("draft_reply") < kinds.indexOf("post_reply"), true);
});

for (const kind of ["draft_reply", "draft_quote"] as const) {
  test(`${kind}: posts automatically, respects execution and browse-only settings; resumes pending post`, () => {
    const actionKey = kind === "draft_reply" ? "reply" : "quote";
    const settings = {
      ...createDefaultAgentSettings(),
      priority: "pogo_only" as const,
      actions: {
        ...createDefaultAgentSettings().actions,
        reply: true,
        quote: true,
      },
    };
    const draft = makeJob({
      kind,
      status: "done",
      tweetId: "111",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/111",
      tweetText: "text",
      draftText: "draft",
      source: "pogo",
    });
    const input = {
      settings,
      stats: createEmptyDailyStats(),
      queue: { jobs: [draft] },
      campaigns: [],
      executeActions: true,
      ownHandle: null,
    };
    const postKind = kind === "draft_reply" ? "post_reply" : "post_quote";
    const planned = planNextAction(input);
    assert.equal(planned.type, "job");
    if (planned.type !== "job") return;
    assert.equal(planned.job.kind, postKind);
    assert.equal(planNextAction({ ...input, executeActions: false }).type, "idle");
    const browse = planNextAction({ ...input, settings: { ...settings, priority: "browse_only" } });
    assert.ok(browse.type !== "job" || !["post_reply", "post_quote"].includes(browse.job.kind));

    const queue = upsertJob(input.queue, { ...planned.job, status: "pending", error: "navigating_tweet" });
    const retry = planNextAction({ ...input, queue });
    assert.equal(retry.type, "job");
    if (retry.type !== "job") return;
    assert.equal(retry.job.id, planned.job.id);
    assert.equal(planNextAction({ ...input, queue, executeActions: false }).type, "idle");
    assert.equal(
      planNextAction({
        ...input,
        queue,
        settings: { ...settings, actions: { ...settings.actions, [actionKey]: false } },
      }).type,
      "idle",
    );
    assert.equal(planNextAction({ ...input, queue: markJob(queue, retry.job.id, { status: "done" }) }).type, "idle");
  });
}

test("planner prefers link list over pogo when linkList module is on", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    modules: {
      ...createDefaultAgentSettings().modules,
      linkList: true,
      pogoTasks: true,
      homeScroll: false,
    },
    executeActions: true,
    
  };
  const linkCamp = camp({
    tweet_id: "9001",
    author_handle: "linkuser",
    tweet_url: "https://x.com/linkuser/status/9001",
    follows_author: false,
  });
  const pogoCamp = camp({
    tweet_id: "1001",
    author_handle: "pogouser",
    tweet_url: "https://x.com/pogouser/status/1001",
  });
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [pogoCamp],
    linkCampaigns: [linkCamp],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.ok(planned.type === "job" || planned.type === "bundle");
  if (planned.type === "job") {
    assert.equal(planned.job.tweetId, "9001");
    assert.equal(planned.job.source, "manual");
  } else if (planned.type === "bundle") {
    assert.equal(planned.tweetId, "9001");
    assert.ok(planned.jobs.every((j) => j.source === "manual"));
  }
});

test("home browse engages candidate with forced rolls", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    modules: {
      ...createDefaultAgentSettings().modules,
      pogoTasks: false,
      linkList: false,
      homeScroll: true,
    },
    actions: {
      like: true,
      retweet: false,
      follow: false,
      reply: false,
      quote: false,
    },
    humanize: {
      ...createDefaultAgentSettings().humanize,
      likePct: 100,
      readMsMin: 1000,
      readMsMax: 2000,
    },
    executeActions: true,
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [],
    browseCandidates: [
      {
        tweetId: "777001",
        authorHandle: "homeuser",
        tweetUrl: "https://x.com/homeuser/status/777001",
        text: "hello timeline",
        alreadyLiked: false,
        promoted: false,
      },
    ],
    browseRolls: { engage: true, like: true, reply: false, retweet: false, follow: false },
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "job");
  if (planned.type !== "job") return;
  assert.equal(planned.job.kind, "like");
  assert.equal(planned.job.source, "browse");
  assert.equal(planned.job.tweetId, "777001");
});

test("a legacy failed open-post roll no longer suppresses enabled actions", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    modules: {
      ...createDefaultAgentSettings().modules,
      pogoTasks: false,
      linkList: false,
      homeScroll: true,
    },
    executeActions: true,
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [],
    browseCandidates: [
      {
        tweetId: "777002",
        authorHandle: "homeuser",
        tweetUrl: "https://x.com/homeuser/status/777002",
        text: "hello",
        alreadyLiked: false,
        promoted: false,
      },
    ],
    browseRolls: { engage: false, like: true, reply: false, retweet: false, follow: false },
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "job");
  if (planned.type !== "job") return;
  assert.equal(planned.job.kind, "like");
  assert.equal(planned.job.likeOnFeed, true);
});

test("home browse reply bundle when reply enabled", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    modules: {
      ...createDefaultAgentSettings().modules,
      pogoTasks: false,
      linkList: false,
      homeScroll: true,
    },
    actions: {
      like: true,
      retweet: false,
      follow: false,
      reply: true,
      quote: false,
    },
    
    executeActions: true,
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [],
    browseCandidates: [
      {
        tweetId: "777003",
        authorHandle: "homeuser",
        tweetUrl: "https://x.com/homeuser/status/777003",
        text: "long enough tweet text for reply",
        alreadyLiked: false,
        promoted: false,
      },
    ],
    browseRolls: { engage: true, like: true, reply: true, retweet: false, follow: false },
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "bundle");
  if (planned.type !== "bundle") return;
  const kinds = planned.jobs.map((j) => j.kind);
  assert.ok(kinds.includes("draft_reply"));
  assert.ok(kinds.includes("post_reply"));
  assert.ok(kinds.includes("like"));
  assert.ok(planned.jobs.every((j) => j.source === "browse"));
});

test("prune keeps standalone browse likes", () => {
  let queue = createEmptyQueue();
  queue = upsertJob(
    queue,
    makeJob({
      kind: "like",
      tweetId: "1",
      authorHandle: "a",
      tweetUrl: "https://x.com/a/status/1",
      tweetText: "t",
      source: "browse",
    }),
  );
  const { queue: next, skipped } = pruneDisabledActionJobs(queue, {
    like: true,
    retweet: false,
    follow: false,
    reply: false,
    quote: false,
  });
  assert.equal(skipped, 0);
  assert.equal(next.jobs[0]?.status, "pending");
});

test("link list jobs respect disabled reply action", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    modules: {
      ...createDefaultAgentSettings().modules,
      linkList: true,
      pogoTasks: false,
      homeScroll: false,
    },
    actions: {
      like: false,
      retweet: true,
      follow: false,
      reply: false,
      quote: false,
    },
    executeActions: true,
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [],
    linkCampaigns: [
      camp({
        tweet_id: "9002",
        author_handle: "linkuser",
        tweet_url: "https://x.com/linkuser/status/9002",
      }),
    ],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "idle", "RT is restricted to Pogo; a link-list RT must not be scheduled");
});

test("Home chooses an actionable visible post instead of scrolling past it", (t) => {
  t.mock.method(Math, "random", () => 0);
  const settings = createDefaultAgentSettings();
  settings.modules.pogoTasks = false;
  settings.actions = { like: true, reply: false, retweet: false, follow: false, quote: false };
  const candidate = (tweetId: string) => ({ tweetId, authorHandle: "alice", tweetUrl: `https://x.com/alice/status/${tweetId}`, text: "A normal post on Home", alreadyLiked: false, promoted: false });
  const queue = { jobs: [makeJob({ ...candidate("2112057695247180169"), tweetText: "A normal post", kind: "like", status: "done", source: "browse" })] };
  const planned = planNextAction({ settings, queue, stats: createEmptyDailyStats(), campaigns: [],
    browseCandidates: [candidate("2112057695247180169"), candidate("2112057695247180170")],
    browseRolls: { engage: true, like: true, reply: false, retweet: false, follow: false },
    executeActions: true, ownHandle: null, hasApiKey: false });
  assert.equal(planned.type, "job");
  if (planned.type !== "job") return;
  assert.equal(planned.job.kind, "like");
  assert.equal(planned.job.tweetId, "2112057695247180170");
});

test("nextBrowseFollowListHandle skips seen and own handle", async () => {
  const { nextBrowseFollowListHandle } = await import("../src/agent/planner.ts");
  const queue = {
    jobs: [
      makeJob({
        kind: "follow",
        status: "skipped",
        source: "browse",
        tweetId: null,
        authorHandle: "alice",
        tweetUrl: null,
        tweetText: null,
        error: "sorsa_low",
      }),
    ],
  };
  assert.equal(
    nextBrowseFollowListHandle(["alice", "bob", "me"], queue, "me"),
    "bob",
  );
  assert.equal(nextBrowseFollowListHandle(["alice"], queue, null), null);
});

test("home browse prefers Follow-tab list over feed author when modules.following", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    modules: {
      ...createDefaultAgentSettings().modules,
      pogoTasks: false,
      linkList: false,
      homeScroll: true,
      following: true,
    },
    actions: {
      like: true,
      retweet: false,
      follow: true,
      reply: false,
      quote: false,
    },
    executeActions: true,
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [],
    browseCandidates: [
      {
        tweetId: "888001",
        authorHandle: "feedauthor",
        tweetUrl: "https://x.com/feedauthor/status/888001",
        text: "hello feed",
        alreadyLiked: false,
        promoted: false,
      },
    ],
    browseRolls: { engage: true, like: true, reply: false, retweet: false, follow: true },
    followListHandles: ["listuser1", "listuser2"],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "job");
  if (planned.type !== "job") return;
  assert.equal(planned.job.kind, "follow");
  assert.equal(planned.job.authorHandle, "listuser1");
  assert.equal(planned.job.tweetId, null);
  assert.match(planned.job.reason || "", /list/i);
});

test("home browse falls back to feed author follow when list exhausted", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    modules: {
      ...createDefaultAgentSettings().modules,
      pogoTasks: false,
      linkList: false,
      homeScroll: true,
      following: true,
    },
    actions: {
      like: false,
      retweet: false,
      follow: true,
      reply: false,
      quote: false,
    },
    executeActions: true,
  };
  const queue = {
    jobs: [
      makeJob({
        kind: "follow",
        status: "done",
        source: "browse",
        tweetId: null,
        authorHandle: "listuser1",
        tweetUrl: null,
        tweetText: null,
      }),
    ],
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue,
    campaigns: [],
    browseCandidates: [
      {
        tweetId: "888002",
        authorHandle: "feedauthor",
        tweetUrl: "https://x.com/feedauthor/status/888002",
        text: "hello feed",
        alreadyLiked: false,
        promoted: false,
        alreadyFollowing: false,
      },
    ],
    browseRolls: { engage: true, like: false, reply: false, retweet: false, follow: true },
    followListHandles: ["listuser1"],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "job");
  if (planned.type !== "job") return;
  assert.equal(planned.job.kind, "follow");
  assert.equal(planned.job.authorHandle, "feedauthor");
  assert.equal(planned.job.tweetId, "888002");
});

test("home browse without modules.following keeps feed-author follow only", () => {
  const settings = {
    ...createDefaultAgentSettings(),
    modules: {
      ...createDefaultAgentSettings().modules,
      pogoTasks: false,
      linkList: false,
      homeScroll: true,
      following: false,
    },
    actions: {
      like: false,
      retweet: false,
      follow: true,
      reply: false,
      quote: false,
    },
    executeActions: true,
  };
  const planned = planNextAction({
    settings,
    stats: createEmptyDailyStats(),
    queue: createEmptyQueue(),
    campaigns: [],
    browseCandidates: [
      {
        tweetId: "888003",
        authorHandle: "feedauthor",
        tweetUrl: "https://x.com/feedauthor/status/888003",
        text: "hello feed",
        alreadyLiked: false,
        promoted: false,
        alreadyFollowing: false,
      },
    ],
    browseRolls: { engage: true, like: false, reply: false, retweet: false, follow: true },
    followListHandles: ["listuser1"],
    executeActions: true,
    ownHandle: null,
    hasApiKey: true,
  });
  assert.equal(planned.type, "job");
  if (planned.type !== "job") return;
  assert.equal(planned.job.kind, "follow");
  assert.equal(planned.job.authorHandle, "feedauthor");
});
