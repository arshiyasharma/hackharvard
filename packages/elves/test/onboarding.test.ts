import { describe, expect, test } from "bun:test";
import {
  allElves,
  briefFromWire,
  briefToWire,
  dispatchBrief,
  dispatchesFor,
  type ElfContext,
  EMPTY_CONVERSATION,
  handleOnboarding,
  isBriefConfirmation,
  route,
} from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import type { InboundMessage } from "@elves/photon";
import type { Batch } from "@elves/pipeline";
import {
  type Brief,
  briefLines,
  createLogger,
  emptyBrief,
  MemoryStore,
  type OnboardingState,
  onboardingActive,
  onboardingKey,
  parseOnboardingState,
} from "@elves/shared";

const now = new Date("2026-10-17T12:00:00Z");
let seq = 0;
function batchOf(text: string): Batch {
  const m: InboundMessage = {
    id: `m${++seq}`,
    spaceId: "s1",
    spaceKind: "direct",
    platform: "script",
    senderId: "u1",
    senderHandle: "+15550001111",
    agentId: "a1",
    agentHandle: "+1628",
    text,
    attachments: [],
    reaction: null,
    parentMessageId: null,
    receivedAt: now.toISOString(),
  };
  return { spaceId: "s1", messages: [m], traceId: "t", carried: 0 };
}

/** Maya's confirmed brief: a student leaving Allston with a couch to sell and no place yet. */
function mayaBrief(): Brief {
  const b = emptyBrief();
  b.move.moveOutDate = "2026-08-31";
  b.move.moveOutFlexibility = "lease ends that day";
  b.move.fromAddress = "Allston";
  b.move.toAddress = "not found yet";
  b.move.distance = "same_city";
  b.people.roommates = ["Sam"];
  b.people.helpers = "Sam has a car, free weekends";
  b.people.availability = "never mornings";
  b.stuff.items = [
    { name: "grey couch", category: "couch", intent: "sell", notes: "paid $400, hoping $150" },
    { name: "desk", category: "desk_table", intent: "donate", notes: null },
    { name: "bed", category: "mattress", intent: "keep", notes: null },
    { name: "mini fridge", category: "small", intent: "undecided", notes: null },
  ];
  b.home.leaseSituation = "ending";
  b.home.leaseNotes = "landlord is sketchy about deposits";
  b.home.needsPlace = true;
  b.home.housing = {
    kind: "room",
    areas: ["Somerville", "Cambridge"],
    budgetMonthlyUsd: 1100,
    from: "2026-09-01",
    until: null,
    mustHaves: [],
  };
  b.money.paymentPrefs = ["Venmo"];
  b.money.budgetUsd = 300;
  b.money.priority = "cheapest";
  b.moveDay.transport = "undecided";
  b.moveDay.access = "3rd floor walkup, no elevator";
  b.worries = ["couch won't sell in time"];
  return b;
}

async function ctxFor(
  store: MemoryStore,
  text: string,
  extra: Partial<ElfContext> = {},
): Promise<ElfContext> {
  const move = await store.createMove({
    ownerHandle: "+15550001111",
    ownerSpaceId: "s1",
    platform: "script",
  });
  const participant = await store.upsertParticipant({
    moveId: move.id,
    handle: "+15550001111",
    role: "owner",
    spaceId: "s1",
    platform: "script",
    agentUserId: "a1",
  });
  return {
    store,
    llm: new FakeLLM(),
    move,
    participant,
    batch: batchOf(text),
    traceId: "t",
    log: createLogger("test", "error"),
    signal: new AbortController().signal,
    publicUrl: "https://elves.example",
    firstContact: true,
    now: () => now,
    fetchAttachment: async () => null,
    conversation: EMPTY_CONVERSATION,
    listings: new FakeListings(),
    ...extra,
  };
}

describe("isBriefConfirmation", () => {
  test.each(["yes", "Yes!", "yep", "looks good", "👍", "lock it in", "all good."])("%p is a yes", (t) => {
    expect(isBriefConfirmation(t)).toBe(true);
  });
  test.each([
    "yes but move the date to nov 2",
    "no",
    "the couch is going to Sam actually",
    "yes and also the lamp",
  ])("%p is a correction", (t) => {
    expect(isBriefConfirmation(t)).toBe(false);
  });
});

describe("onboarding state", () => {
  test("round-trips through the cursor and knows when the call is over", () => {
    const state: OnboardingState = {
      status: "confirming",
      brief: mayaBrief(),
      askTurns: 2,
      prompt: "sweep",
      startedAt: now.toISOString(),
      confirmedAt: null,
    };
    const back = parseOnboardingState(JSON.stringify(state));
    expect(back).toEqual(state);
    expect(onboardingActive(back)).toBe(true);
    expect(onboardingActive({ ...state, status: "confirmed" })).toBe(false);
    expect(onboardingActive(null)).toBe(false);
    expect(parseOnboardingState("not json")).toBeNull();
    expect(parseOnboardingState(undefined)).toBeNull();
  });

  test("briefLines renders what is known and skips what is not", () => {
    const lines = briefLines(mayaBrief()).join("\n");
    expect(lines).toContain("Move-out: 2026-08-31 (lease ends that day)");
    expect(lines).toContain("grey couch (sell; paid $400, hoping $150)");
    expect(lines).toContain("Needs a place: room in Somerville / Cambridge under $1100/mo 2026-09-01 → ?");
    expect(lines).toContain("Worries: couch won't sell in time");
    expect(lines).not.toContain("Move-in:");
    expect(briefLines(emptyBrief())).toEqual(["- (nothing captured yet)"]);
  });
});

describe("brief on the wire", () => {
  test("round-trips: unknowns become empty strings and -1, then nulls again", () => {
    const b = mayaBrief();
    const w = briefToWire(b);
    expect(w.move.moveInDate).toBe("");
    expect(w.money.budgetUsd).toBe(300);
    expect(w.home.needsPlace).toBe("yes");
    expect(briefFromWire(w)).toEqual(b);
    const e = emptyBrief();
    expect(briefFromWire(briefToWire(e))).toEqual(e);
  });
  test("'unknown' written by the model reads as null", () => {
    const w = briefToWire(emptyBrief());
    w.move.reason = "unknown";
    w.moveDay.access = " N/A ";
    const b = briefFromWire(w);
    expect(b.move.reason).toBeNull();
    expect(b.moveDay.access).toBeNull();
  });
});

describe("dispatchesFor", () => {
  test("reads who starts on what off the brief", () => {
    const d = dispatchesFor(mayaBrief());
    expect(d.map((x) => x.elf)).toEqual(["stuff", "home", "money"]);
    expect(d[0]!.task).toBe("sell grey couch; donate desk; decide on mini fridge");
    expect(d[1]!.task).toBe("find a room in Somerville or Cambridge under $1100/mo");
    expect(d[2]!.task).toBe("escrow on each sale; keep the move under $300");
  });
  test("an empty brief dispatches nobody", () => {
    expect(dispatchesFor(emptyBrief())).toEqual([]);
  });
  test("subletting out and a storage gap both reach Home; movers reach nobody", () => {
    const b = emptyBrief();
    b.home.leaseSituation = "subletting_out";
    b.home.gap = "two weeks, need storage";
    b.moveDay.transport = "movers";
    const d = dispatchesFor(b);
    expect(d.map((x) => x.elf)).toEqual(["home"]);
    expect(d[0]?.task).toBe("sublet the current place; find storage for the gap");
  });
});

describe("dispatchBrief", () => {
  test("writes the move, the items and the board, and tells the owner who is on what", async () => {
    const store = new MemoryStore();
    const ctx = await ctxFor(store, "yes");
    const state: OnboardingState = {
      status: "confirming",
      brief: mayaBrief(),
      askTurns: 2,
      prompt: "sweep",
      startedAt: now.toISOString(),
      confirmedAt: null,
    };
    const res = await dispatchBrief(ctx, state, "m1");
    expect(res.movePatch).toMatchObject({
      moveOutAt: "2026-08-31",
      fromAddress: "Allston",
      boardLinkSent: true,
    });
    expect(res.movePatch?.toAddress).toBeUndefined();
    const items = await store.listItems(ctx.move.id);
    expect(items.map((i) => i.name).sort()).toEqual(["desk", "grey couch", "mini fridge"]);
    const board = await store.getBoard(ctx.move.id);
    expect(board.find((b) => b.elf === "stuff")).toMatchObject({
      status: "working",
      currentTask: "sell grey couch; donate desk; decide on mini fridge",
    });
    expect(board.find((b) => b.elf === "home")?.status).toBe("working");
    expect(board.find((b) => b.elf === "money")?.status).toBe("waiting");
    expect(res.events?.map((e) => e.type)).toContain("brief.confirmed");
    expect(res.events?.filter((e) => e.type === "elf.dispatched").length).toBe(3);
    expect(res.replies[0]!.text).toContain("Stuff Elf: sell grey couch; donate desk; decide on mini fridge.");
    expect(res.replies[0]!.text).toEndWith("Text STATUS anytime to see where everything stands, or DASHBOARD to see your money.");
    expect(res.replies[0]!.text).toContain(
      "Home Elf: find a room in Somerville or Cambridge under $1100/mo.",
    );
    expect(res.replies[1]!.text).toContain("/b/");
    const saved = parseOnboardingState(await store.getCursor(onboardingKey(ctx.move.id)));
    expect(saved?.status).toBe("confirmed");
    expect(saved?.confirmedAt).toBe(now.toISOString());
  });
});

describe("onboarding and the fake model", () => {
  test("the deterministic Crew Lead path is untouched without a real model", async () => {
    const store = new MemoryStore();
    const ctx = await ctxFor(store, "hi im moving out nov 1");
    expect(await handleOnboarding(ctx)).toBeNull();
    expect(await store.getCursor(onboardingKey(ctx.move.id))).toBeUndefined();
  });
});

describe("router during onboarding", () => {
  test("every owner text stays with the Crew Lead until the brief is confirmed", async () => {
    const store = new MemoryStore();
    const deps = { store, llm: new FakeLLM(), elves: allElves };
    const state: OnboardingState = {
      status: "gathering",
      brief: emptyBrief(),
      askTurns: 1,
      prompt: "sweep",
      startedAt: now.toISOString(),
      confirmedAt: null,
    };
    await store.setCursor(onboardingKey("mv1"), JSON.stringify(state));
    const opts = { firstContact: false, moveId: "mv1", role: "owner" as const };
    expect(await route(batchOf("I want to sell my couch"), deps, opts)).toMatchObject({
      elf: "crew_lead",
      via: "onboarding",
    });
    expect(await route(batchOf("looking for a room in allston under 1200"), deps, opts)).toMatchObject({
      elf: "crew_lead",
      via: "onboarding",
    });
    // a buyer is never onboarded
    expect((await route(batchOf("is the couch available"), deps, { ...opts, role: "buyer" })).via).not.toBe(
      "onboarding",
    );
    await store.setCursor(onboardingKey("mv1"), JSON.stringify({ ...state, status: "confirmed" }));
    expect(await route(batchOf("I want to sell my couch"), deps, opts)).toMatchObject({ elf: "stuff" });
  });
});
