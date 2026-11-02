import assert from "node:assert/strict";
import test from "node:test";
import {
  bountyTelegramAlerts,
  canClaimBounty,
  extractBountyArray,
  normalizePogoBounty,
  skipReasonForAutoJoin,
  skipReasonForClaim,
  skipReasonLabel,
} from "../src/domain/pogo-bounty.ts";
import { claimPogoBounty, fetchPogoBounties } from "../src/api/bounties-client.ts";
import {
  claimPogoBountyById,
  getPogoBountyPublicState,
  maybeAutoJoinPogoBounties,
  pollPogoBounties,
  resetPogoBountyStore,
  setPogoBountyAutoJoin,
  syncPogoBounties,
  ensurePogoBountyAlarm,
} from "../src/background/pogo-bounty-store.ts";
import { setApiSessionToken } from "../src/background/api-session.ts";

const rome = {
  id: 68,
  title: "Rome Protocol Ambassadors - Series 1",
  description: "Rome lets one Solidity contract serve both EVM and Solana wallets.",
  reward_points: 0,
  claim_fee: 750,
  required_wallet_type: "arbitrum",
  max_slots: 35,
  slots_left: 0,
  required_tag: "@RomeProtocol",
  expires_at: "2026-11-16T10:00:00+00:00",
  my_claim_status: null,
  requirements: { min_placement: 300, min_followers: 10000 },
  eligible: false,
  ineligible_reasons: ["placement"],
  invited: false,
  series: {
    step_count: 4,
    current_step: 2,
    join_open: true,
    run_state: "not_joined",
    potential_crypto_amount: 225.0,
    crypto_token: "USDC",
    pay_rule: "on_finish",
  },
};

const openBounty = {
  id: 99,
  title: "Open bounty",
  claim_fee: 0,
  max_slots: 10,
  slots_left: 4,
  eligible: true,
  ineligible_reasons: [],
  my_claim_status: null,
  required_wallet_type: null,
};

function mockChrome(t: { after: (fn: () => void) => void }, disk: Record<string, unknown> = {}) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: disk[key] }),
          set: async (patch: object) => Object.assign(disk, patch),
        },
        session: {
          get: async (key: string) => ({ [key]: disk[key] }),
          set: async (patch: object) => Object.assign(disk, patch),
          remove: async (key: string) => { delete disk[key]; },
        },
      },
      runtime: {
        sendMessage: async () => undefined,
        sendNativeMessage: async (_host: string, message: Record<string, unknown>) => { (disk.__native as Record<string, unknown>[]).push(message); return { ok: true }; },
      },
    },
  });
  t.after(() => (old ? Object.defineProperty(globalThis, "chrome", old) : Reflect.deleteProperty(globalThis, "chrome")));
  disk.__native = [];
  return disk;
}

async function flushTelegram(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test("Rome series bounty is not joinable: rank too low and no slots", () => {
  const bounty = normalizePogoBounty(rome)!;
  assert.equal(bounty.id, 68);
  assert.equal(bounty.series?.joinOpen, true);
  assert.equal(bounty.series?.runState, "not_joined");
  assert.equal(bounty.slotsLeft, 0);
  assert.equal(bounty.claimFee, 750);
  assert.equal(bounty.cryptoAmount, 225);
  assert.equal(bounty.cryptoToken, "USDC");
  assert.equal(canClaimBounty(bounty), false);
  assert.equal(skipReasonForClaim(bounty), "placement");
  assert.equal(skipReasonLabel("placement"), "Rank chưa đủ");
  assert.equal(skipReasonForClaim({ ...bounty, eligible: true, ineligibleReasons: [] }), "no_slots");
});

test("regular bounty is joinable when eligible and slots remain", () => {
  const bounty = normalizePogoBounty(openBounty)!;
  assert.equal(canClaimBounty(bounty), true);
  assert.equal(skipReasonForClaim(bounty), null);
  assert.equal(skipReasonForAutoJoin(bounty, { balance: 10, debtOwed: 0, walletType: null }), null);
  assert.equal(
    skipReasonForAutoJoin(normalizePogoBounty({ ...openBounty, claim_fee: 100 })!, { balance: 40, debtOwed: 0, walletType: null }),
    "not_enough_hops",
  );
  assert.equal(
    skipReasonForAutoJoin(normalizePogoBounty({ ...openBounty, claim_fee: 100 })!, { balance: 200, debtOwed: 5, walletType: null }),
    "in_debt",
  );
  assert.equal(
    skipReasonForAutoJoin(normalizePogoBounty({ ...openBounty, required_wallet_type: "arbitrum" })!, { balance: 10, debtOwed: 0, walletType: null }),
    "wallet_required",
  );
});

test("extractBountyArray reads { bounties } envelope", () => {
  assert.equal(extractBountyArray({ bounties: [rome] }).length, 1);
  assert.equal(extractBountyArray([rome]).length, 1);
  assert.equal(extractBountyArray({ campaigns: [] }).length, 0);
});

test("fetchPogoBounties and claimPogoBounty hit the Mini App endpoints", async (t) => {
  const calls: { url: string; method: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method || "GET") });
    if (url.endsWith("/api/bounties")) return Response.json({ bounties: [rome, openBounty] });
    if (url.endsWith("/api/bounties/99/claim")) return Response.json({ claim: { status: "claimed" }, progress: {} });
    return new Response("", { status: 404 });
  });
  const list = await fetchPogoBounties("token");
  assert.equal(list.ok, true);
  if (!list.ok) return;
  assert.equal(list.bounties.length, 2);
  assert.equal(list.bounties[0].id, 68);
  const claim = await claimPogoBounty("token", 99);
  assert.equal(claim.ok, true);
  if (claim.ok) assert.equal(claim.status, "claimed");
  assert.deepEqual(calls, [
    { url: "https://pogo.social/api/bounties", method: "GET" },
    { url: "https://pogo.social/api/bounties/99/claim", method: "POST" },
  ]);
});

test("auto-join claims only eligible open bounties and skips Rome", async (t) => {
  const disk = mockChrome(t);
  resetPogoBountyStore();
  await setApiSessionToken("token");
  const claimed: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/bounties") && (!init?.method || init.method === "GET")) {
      return Response.json({ bounties: [rome, openBounty] });
    }
    if (url.endsWith("/api/me")) return Response.json({ balance: 900, debt_owed: 0, wallet: { wallet_type: "arbitrum" } });
    if (url.includes("/claim")) {
      claimed.push(Number(url.split("/bounties/")[1].split("/claim")[0]));
      return Response.json({ claim: { status: "claimed" } });
    }
    return new Response("", { status: 404 });
  });

  await setPogoBountyAutoJoin(true);
  const state = await syncPogoBounties({ autoJoin: true });
  assert.deepEqual(claimed, [99]);
  assert.equal(state.joinableCount, 0);
  assert.equal(state.claimedCount, 1);
  assert.equal(state.items.find((b) => b.id === 68)?.skipReason, "placement");
  assert.equal(state.items.find((b) => b.id === 99)?.claimed, true);
  assert.equal((disk["xContentCreator.pogoBounties.v1"] as { autoJoin?: boolean }).autoJoin, true);
});

test("manual claim refuses ineligible bounty and joins an open one", async (t) => {
  mockChrome(t);
  resetPogoBountyStore();
  await setApiSessionToken("token");
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/bounties") && (!init?.method || init.method === "GET")) {
      return Response.json({ bounties: [rome, openBounty] });
    }
    if (url.endsWith("/api/bounties/99/claim")) return Response.json({ claim: { status: "claimed" } });
    return new Response("", { status: 404 });
  });
  await syncPogoBounties({ autoJoin: false });
  const refused = await claimPogoBountyById(68);
  assert.equal(refused.error, "Rank chưa đủ");
  const joined = await claimPogoBountyById(99);
  assert.equal(joined.error, null);
  assert.equal(joined.items.find((b) => b.id === 99)?.claimed, true);
  const view = await getPogoBountyPublicState();
  assert.equal(view.claimedCount, 1);
});

test("maybeAutoJoinPogoBounties does not fetch when auto-join is off", async (t) => {
  mockChrome(t);
  resetPogoBountyStore();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response("", { status: 500 });
  });
  await maybeAutoJoinPogoBounties();
  assert.equal(calls, 0);
});

test("telegram alerts skip ineligible baseline, then report new/joined/blocked", () => {
  const romeB = normalizePogoBounty(rome)!;
  const open = normalizePogoBounty(openBounty)!;
  const empty = { balance: 900, debtOwed: 0, walletType: "arbitrum" as const };
  assert.deepEqual(
    bountyTelegramAlerts([], [romeB, open], { primed: false, autoJoin: false, account: empty }).map((a) => [a.kind, a.id]),
    [["new", 99]],
  );
  const joined = { ...open, myClaimStatus: "claimed", slotsLeft: 3, lastJoin: { at: 1, ok: true } };
  assert.deepEqual(
    bountyTelegramAlerts([], [romeB, joined], { primed: false, autoJoin: true, account: empty }).map((a) => [a.kind, a.id]),
    [["joined", 99]],
  );
  assert.equal(
    bountyTelegramAlerts([romeB, joined], [romeB, joined], { primed: true, autoJoin: true, account: empty }).length,
    0,
  );
  const extra = normalizePogoBounty({ ...rome, id: 101, title: "New gated" })!;
  const blocked = bountyTelegramAlerts([romeB, joined], [romeB, joined, extra], { primed: true, autoJoin: true, account: empty });
  assert.deepEqual(blocked.map((a) => [a.kind, a.id, a.reason]), [["blocked", 101, "placement"]]);
});

test("auto-join notifies Telegram for the joined bounty and skips Rome", async (t) => {
  const disk = mockChrome(t);
  resetPogoBountyStore();
  await setApiSessionToken("token");
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/bounties") && (!init?.method || init.method === "GET")) {
      return Response.json({ bounties: [rome, openBounty] });
    }
    if (url.endsWith("/api/me")) return Response.json({ balance: 900, debt_owed: 0, wallet: { wallet_type: "arbitrum" } });
    if (url.includes("/claim")) return Response.json({ claim: { status: "claimed" } });
    return new Response("", { status: 404 });
  });
  await setPogoBountyAutoJoin(true);
  await flushTelegram();
  const native = disk.__native as Record<string, unknown>[];
  const bountyMsgs = native.filter((m) => m.event === "pogo_bounty");
  assert.deepEqual(bountyMsgs.map(m => m.bounty).map(b => [(b as {kind: string}).kind, (b as {id: number}).id]), [["new", 99], ["joined", 99]]);
});

test("pollPogoBounties fetches the list when a token exists and skips without one", async (t) => {
  mockChrome(t);
  resetPogoBountyStore();
  await setApiSessionToken(null);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    calls += 1;
    if (String(input).endsWith("/api/bounties")) return Response.json({ bounties: [openBounty] });
    return new Response("", { status: 404 });
  });
  await pollPogoBounties();
  assert.equal(calls, 0);
  await setApiSessionToken("token");
  await pollPogoBounties();
  assert.equal(calls, 1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function notices(disk: Record<string, unknown>) {
  return (disk.__native as Array<{event: string; bounty?: {kind: string; id: number; reason?: string}}> )
    .filter(message => message.event === "pogo_bounty").map(message => message.bounty!);
}

test("discovery starts bot delivery before claiming; an unresponsive bot cannot block free FCFS joins", async t => {
  const disk = mockChrome(t);
  resetPogoBountyStore(); await setApiSessionToken("fcfs-token");
  const bot = deferred<{ok: boolean}>();
  const order: string[] = [];
  t.mock.method(chrome.runtime, "sendNativeMessage", async (_host: string, message: unknown) => {
    const m = message as {bounty: {kind: string}};
    order.push(m.bounty.kind); return bot.promise;
  });
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/bounties")) return Response.json({bounties: [openBounty]});
    assert.ok(!url.endsWith("/api/me"), "a free bounty must not wait for economy lookup");
    order.push("claim"); return Response.json({claim: {status: "claimed"}});
  });
  try {
    const state = await setPogoBountyAutoJoin(true);
    assert.equal(state.claimedCount, 1);
    assert.deepEqual(order, ["new", "claim", "joined"]);
  } finally { bot.resolve({ok: true}); await flushTelegram(); }
  assert.ok(disk["xContentCreator.bountyNotifications.v1"]);
});

test("each join failure is announced before the next slow claim finishes", async t => {
  const disk = mockChrome(t);
  resetPogoBountyStore(); await setApiSessionToken("failure-token");
  const slow = deferred<Response>(), started = deferred<void>();
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/bounties")) return Response.json({bounties: [openBounty, {...openBounty,id: 100}]});
    if (url.endsWith("/99/claim")) return Response.json({code: "no_slots"}, {status: 409});
    started.resolve(); return slow.promise;
  });
  const run = setPogoBountyAutoJoin(true);
  await started.promise;
  assert.ok(notices(disk).some(n => n.id === 99 && n.kind === "failed" && n.reason === "no_slots"));
  slow.resolve(Response.json({claim: {status: "claimed"}})); await run; await flushTelegram();
});

test("disabling auto-join during fetch stops claims and is not overwritten by the old scan", async t => {
  mockChrome(t); resetPogoBountyStore(); await setApiSessionToken("disable-token");
  const list = deferred<Response>(), started = deferred<void>(); let claims = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).endsWith("/api/bounties")) { started.resolve(); return list.promise; }
    claims++; return Response.json({claim: {status: "claimed"}});
  });
  const run = setPogoBountyAutoJoin(true); await started.promise;
  await setPogoBountyAutoJoin(false); list.resolve(Response.json({bounties: [openBounty]}));
  const state = await run;
  assert.equal(state.autoJoin, false); assert.equal(claims, 0); await flushTelegram();
});

test("two concurrent manual claims retain both successes and same-bounty calls share one POST", async t => {
  mockChrome(t); resetPogoBountyStore(); await setApiSessionToken("parallel-token");
  const gate = deferred<Response>(); let claims = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).endsWith("/api/bounties")) return Response.json({bounties: [openBounty, {...openBounty,id: 100}]});
    claims++; return (await gate.promise).clone();
  });
  await syncPogoBounties({autoJoin: false});
  const runs = [claimPogoBountyById(99), claimPogoBountyById(100), claimPogoBountyById(99)];
  await flushTelegram(); gate.resolve(Response.json({claim: {status: "claimed"}}));
  await Promise.all(runs); assert.equal(claims, 2);
  assert.equal((await getPogoBountyPublicState()).claimedCount, 2); await flushTelegram();
});

test("switching Pogo sessions cannot inherit another account's claim receipts", async t => {
  mockChrome(t); resetPogoBountyStore(); await setApiSessionToken("account-A");
  t.mock.method(globalThis, "fetch", async (input: unknown) => Response.json(String(input).endsWith("/claim")
    ? {claim: {status: "claimed"}} : {bounties: [openBounty]}));
  await syncPogoBounties({autoJoin: false}); await claimPogoBountyById(99);
  await setApiSessionToken("account-B");
  const state = await syncPogoBounties({autoJoin: false});
  assert.equal(state.claimedCount, 0); assert.equal(state.joinableCount, 1); await flushTelegram();
});

test("an in-flight list for an old session cannot claim or overwrite the new session", async t => {
  mockChrome(t); resetPogoBountyStore(); await setApiSessionToken("old-account");
  const list = deferred<Response>(), started = deferred<void>(); let claims = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).endsWith("/api/bounties")) {started.resolve(); return list.promise;}
    claims++; return Response.json({claim:{status:"claimed"}});
  });
  const run = setPogoBountyAutoJoin(true); await started.promise; await setApiSessionToken("new-account");
  list.resolve(Response.json({bounties:[openBounty]})); await run;
  assert.equal(claims, 0); assert.equal((await getPogoBountyPublicState()).items.length, 0);
});

test("ambiguous claim reports uncertainty, survives reload and reconciles without another POST", async t => {
  const disk = mockChrome(t); resetPogoBountyStore(); await setApiSessionToken("uncertain-account");
  let claims = 0, confirmed = false;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).endsWith("/api/bounties")) return Response.json({bounties:[{...openBounty,my_claim_status: confirmed ? "claimed" : null}]});
    claims++; throw new Error("private network details");
  });
  await setPogoBountyAutoJoin(true); await flushTelegram();
  assert.ok(notices(disk).some(n => n.kind === "uncertain" && n.reason === "network_error"));
  resetPogoBountyStore(); await syncPogoBounties(); assert.equal(claims, 1);
  confirmed = true; const state = await syncPogoBounties(); await flushTelegram();
  assert.equal(state.claimedCount, 1); assert.equal(claims, 1);
  assert.ok(notices(disk).some(n => n.kind === "joined"));
});

test("failed bounty polling notifies the bot so the user can check Pogo manually", async t => {
  const disk = mockChrome(t); resetPogoBountyStore(); await setApiSessionToken("poll-error-token");
  t.mock.method(globalThis, "fetch", async () => Response.json({}, {status: 401}));
  await syncPogoBounties(); await flushTelegram();
  assert.ok((disk.__native as Array<{event:string}>).some(n => n.event === "pogo_bounty_error"));
});

test("malformed API responses never erase bounty history or report a successful claim", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({unexpected: true}));
  const list = await fetchPogoBounties("fake-token");
  assert.equal(list.ok, false);
  const claim = await claimPogoBounty("fake-token", 99);
  assert.equal(claim.ok, false);
  if (!claim.ok) assert.equal(claim.code, "claim_response_uncertain");
});

test("token renewal for the same JWT subject preserves successful receipts", async t => {
  mockChrome(t); resetPogoBountyStore();
  const token = (exp: number) => `header.${Buffer.from(JSON.stringify({sub: "same-user", exp})).toString("base64url")}.signature`;
  await setApiSessionToken(token(1));
  t.mock.method(globalThis, "fetch", async (input: unknown) => Response.json(String(input).endsWith("/claim")
    ? {claim: {status: "claimed"}} : {bounties: [openBounty]}));
  await syncPogoBounties({autoJoin: false}); await claimPogoBountyById(99);
  await setApiSessionToken(token(2)); resetPogoBountyStore();
  const state = await syncPogoBounties({autoJoin: false});
  assert.equal(state.claimedCount, 1); await flushTelegram();
});

test("Bounty alarm upgrades the old one-minute poll without postponing an existing 30-second alarm", async t => {
  mockChrome(t);
  let periodInMinutes = 1, creates = 0;
  Object.defineProperty(chrome, "alarms", { configurable: true, value: {
    get: async () => ({periodInMinutes}),
    create: async (_name: string, opts: {periodInMinutes: number}) => {periodInMinutes = opts.periodInMinutes; creates++;},
  }});
  await ensurePogoBountyAlarm(); await ensurePogoBountyAlarm();
  assert.equal(periodInMinutes, 0.5); assert.equal(creates, 1);
});
