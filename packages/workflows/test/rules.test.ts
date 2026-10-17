import { describe, expect, test } from "bun:test";
import {
  applyEvent,
  type BuyerIntent,
  buyerIntent,
  type Deal,
  lastCallPrice,
  parsePriceCents,
  parseSlotPick,
  proposeSlots,
  rulesFromFacts,
  type Slot,
} from "@elves/workflows";

const NOW = new Date("2026-10-15T14:00:00Z"); // Thu 10:00 EDT
const SLOTS: Slot[] = [
  { start: "2026-10-15T16:00:00.000Z", end: "2026-10-15T17:00:00.000Z", label: "Thu Oct 15, 12pm–1pm" },
  { start: "2026-10-15T21:30:00.000Z", end: "2026-10-15T23:00:00.000Z", label: "Thu Oct 15, 5:30pm–7pm" },
  { start: "2026-10-17T14:00:00.000Z", end: "2026-10-17T16:00:00.000Z", label: "Sat Oct 17, 10am–12pm" },
];
const ctx = { now: NOW, slots: () => SLOTS };

function deal(over: Partial<Deal> = {}): Deal {
  return {
    id: "dl_1",
    moveId: "mv_1",
    itemId: "it_1",
    itemName: "couch",
    runId: "dl_1",
    buyerHandle: "+14022176358",
    buyerSpaceId: "spc_buyer",
    buyerAgentId: "usr_agent",
    status: "listed",
    stage: "negotiating",
    listCents: 12000,
    floorCents: 8000,
    lastOfferCents: null,
    counterCents: null,
    counters: 0,
    agreedCents: null,
    offeredSlots: [],
    slotAt: null,
    reschedules: 0,
    nudges: 0,
    buyerConfirmed: false,
    ownerConfirmed: false,
    reliability: 0.7,
    lastBuyerAt: null,
    lastCallOptOut: false,
    lastCallStage: "none",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}
const say = (d: Deal, text: string) =>
  applyEvent(d, { kind: "buyer_text", text, at: NOW.toISOString() }, ctx);
const buyerText = (t: ReturnType<typeof applyEvent>) =>
  t.replies
    .filter((r) => r.to === "buyer")
    .map((r) => r.text)
    .join(" | ");
const ownerText = (t: ReturnType<typeof applyEvent>) =>
  t.replies
    .filter((r) => r.to === "owner")
    .map((r) => r.text)
    .join(" | ");

describe("parsing", () => {
  test.each([
    ["$80", 8000],
    ["80 bucks", 8000],
    ["would you take 70?", 7000],
    ["how about 65", 6500],
    ["90", 9000],
    ["is it still available", null],
    ["I can come at 2pm", null],
    ["option 2", null],
  ])("parsePriceCents(%p) = %p", (text, cents) => {
    expect(parsePriceCents(text)).toBe(cents);
  });
  test.each([
    ["is the couch still available?", "available"],
    ["$80", "offer"],
    ["ok deal", "yes"],
    ["nah too much", "no"],
    ["got it, thanks!", "picked_up"],
    ["something came up, can't make it", "cancel"],
    ["what color is it", "other"],
  ] as [string, BuyerIntent][])("buyerIntent(%p) = %p", (text, intent) => {
    expect(buyerIntent(text).intent).toBe(intent);
  });
  test.each([
    ["2", 1],
    ["the second one", 1],
    ["saturday works", 2],
    ["thursday at 5:30pm", 1],
    ["thu 12pm", 0],
    ["any of those work", 0],
    ["maybe next week", null],
  ])("parseSlotPick(%p) = %p", (text, idx) => {
    expect(parseSlotPick(text, SLOTS)).toBe(idx);
  });
});

describe("negotiation band (list $120, floor $80, midpoint $100)", () => {
  test("availability question states the price and invites an offer", () => {
    const t = say(deal(), "hey is the couch still available?");
    expect(t.deal.status).toBe("negotiating");
    expect(buyerText(t)).toBe(
      "Yes, the couch is still available at $120. Want it? You can also make an offer.",
    );
  });
  test("at or above list accepts at list; at or above midpoint accepts the offer", () => {
    expect(say(deal(), "$130").deal.agreedCents).toBe(12000);
    const t = say(deal(), "would you take 100");
    expect(t.deal.agreedCents).toBe(10000);
    expect(t.deal.stage).toBe("scheduling");
    expect(buyerText(t)).toContain("Deal, $100 for the couch. Pickup slots: 1) Thu Oct 15, 12pm–1pm");
    expect(ownerText(t)).toContain("agreed to $100");
    expect(t.money).toBe("hold");
    expect(t.events.map((e) => e.type)).toContain("deal.agreed");
  });
  test("inside the band: counter at the midpoint, then split, then accept", () => {
    const t1 = say(deal(), "90?");
    expect(t1.deal.counterCents).toBe(10000);
    expect(buyerText(t1)).toBe("I can do $100 for the couch. Want it at that?");
    const t2 = say(t1.deal, "still 90");
    expect(t2.deal.counterCents).toBe(9500);
    const t3 = say(t2.deal, "90 is my max");
    expect(t3.deal.agreedCents).toBe(9000);
  });
  test("a yes takes the standing counter, or list when none", () => {
    expect(say(say(deal(), "90?").deal, "ok").deal.agreedCents).toBe(10000);
    expect(say(deal(), "yes I'll take it").deal.agreedCents).toBe(12000);
  });
  test("below the floor: the floor is the last counter, then the owner is asked", () => {
    const t1 = say(deal(), "$50");
    expect(buyerText(t1)).toBe("The lowest I can go on the couch is $80. Want it at that?");
    const t2 = say(t1.deal, "60?");
    expect(t2.deal.status).toBe("awaiting_owner");
    expect(buyerText(t2)).toContain("check with the owner on $60");
    expect(ownerText(t2)).toBe(
      "Buyer +14022176358 is offering $60 for the couch; your floor is $80. Take it? Reply yes or no.",
    );
    const yes = applyEvent(t2.deal, { kind: "owner_decision", approved: true }, ctx);
    expect(yes.deal.agreedCents).toBe(6000);
    expect(buyerText(yes)).toContain("Good news, the owner will take $60. Deal, $60 for the couch.");
    const no = applyEvent(t2.deal, { kind: "owner_decision", approved: false }, ctx);
    expect(no.deal.status).toBe("negotiating");
    expect(no.deal.counterCents).toBe(8000);
    expect(buyerText(no)).toContain("holding at $80");
    expect(say(no.deal, "fine, 80").deal.agreedCents).toBe(8000);
  });
  test("a decline relists", () => {
    const t = say(deal({ status: "negotiating" }), "nah, pass");
    expect(t.deal.status).toBe("relisted");
    expect(t.events[0]?.type).toBe("deal.relisted");
  });
  test("free items skip the haggling", () => {
    const t = say(deal({ listCents: 0, floorCents: 0 }), "is the couch available");
    expect(buyerText(t)).toContain("free; first to pick up gets it");
    expect(say(deal({ listCents: 0, floorCents: 0 }), "yes!").deal.agreedCents).toBe(0);
  });
});

describe("scheduling and hand-off", () => {
  const agreed = say(deal(), "100").deal;
  test("first confirmation books; junk re-offers; a walk-away relists with a refund", () => {
    const booked = say(agreed, "2");
    expect(booked.deal.status).toBe("scheduled");
    expect(booked.deal.slotAt).toBe(SLOTS[1]!.start);
    expect(buyerText(booked)).toContain("Booked: Thu Oct 15, 5:30pm–7pm");
    expect(ownerText(booked)).toContain("Confirmed 🎉");
    const junk = say(agreed, "cool");
    expect(junk.deal.status).toBe("negotiating");
    expect(buyerText(junk)).toContain("Which slot works?");
    const walk = say(agreed, "sorry, something came up");
    expect(walk.deal.status).toBe("relisted");
    expect(walk.money).toBe("refund");
  });
  test("hand-off needs both signals; the second releases escrow and marks the item sold", () => {
    const booked = say(agreed, "2").deal;
    const buyerFirst = say(booked, "got it, thanks");
    expect(buyerFirst.deal.status).toBe("handed_off");
    expect(buyerFirst.deal.buyerConfirmed).toBe(true);
    expect(ownerText(buyerFirst)).toContain('Reply "handed off" to release $100');
    const done = applyEvent(buyerFirst.deal, { kind: "owner_handoff" }, ctx);
    expect(done.deal.status).toBe("paid");
    expect(done.itemPatch).toEqual({ outcome: "sold" });
    expect(done.money).toBe("release");
    const ownerFirst = applyEvent(booked, { kind: "owner_handoff" }, ctx);
    expect(ownerFirst.deal.status).toBe("handed_off");
    expect(buyerText(ownerFirst)).toContain('Reply "got it" to confirm and release $100');
    expect(say(ownerFirst.deal, "yep got it").deal.status).toBe("paid");
  });
  test("a no-show reschedules once, then relists", () => {
    const booked = say(agreed, "2").deal;
    const first = applyEvent(booked, { kind: "owner_noshow" }, ctx);
    expect(first.deal.stage).toBe("scheduling");
    expect(first.deal.reschedules).toBe(1);
    expect(first.deal.reliability).toBeCloseTo(0.4);
    expect(buyerText(first)).toContain("New slots");
    const rebooked = say(first.deal, "1").deal;
    const second = applyEvent(rebooked, { kind: "owner_noshow" }, ctx);
    expect(second.deal.status).toBe("relisted");
    expect(ownerText(second)).toContain("no-showed twice");
  });
  test("withdraw and opt-out apply in any stage; price changes only while negotiating", () => {
    const booked = say(agreed, "2").deal;
    const w = applyEvent(booked, { kind: "owner_withdraw" }, ctx);
    expect(w.deal.status).toBe("withdrawn");
    expect(w.money).toBe("refund");
    expect(applyEvent(booked, { kind: "owner_optout" }, ctx).deal.lastCallOptOut).toBe(true);
    const unchanged = applyEvent(
      booked,
      { kind: "price_change", listCents: 7200, floorCents: 7200, why: "dropped" },
      ctx,
    );
    expect(unchanged.deal.listCents).toBe(12000);
    const talking = say(deal(), "is it available").deal;
    const dropped = applyEvent(
      talking,
      { kind: "price_change", listCents: 7200, floorCents: 7200, why: "dropped" },
      ctx,
    );
    expect(dropped.deal.listCents).toBe(7200);
    expect(buyerText(dropped)).toBe("Price drop: the couch is now $72. Want it?");
  });
});

describe("Last Call and slots", () => {
  test("60% of list at T−48h, floor clamped; free at T−24h", () => {
    expect(lastCallPrice("drop", 12000, 8000)).toEqual({ listCents: 7200, floorCents: 7200 });
    expect(lastCallPrice("drop", 900, 500)).toEqual({ listCents: 500, floorCents: 500 });
    expect(lastCallPrice("drop", 12000, null)).toEqual({ listCents: 7200, floorCents: null });
    expect(lastCallPrice("free", 12000, 8000)).toEqual({ listCents: 0, floorCents: 0 });
  });
  test("slots: three windows from two hours out, in Boston time, ending by move-out", () => {
    const slots = proposeSlots({ now: NOW, moveOutAt: "2026-10-20" });
    expect(slots.map((s) => s.label)).toEqual([
      "Thu Oct 15, 12pm–1pm",
      "Thu Oct 15, 5:30pm–7pm",
      "Fri Oct 16, 12pm–1pm",
    ]);
    expect(
      proposeSlots({ now: NOW, moveOutAt: "2026-10-20", rules: { noEvenings: true, noWeekdays: true } }).map(
        (s) => s.label,
      ),
    ).toEqual(["Sat Oct 17, 10am–12pm", "Sat Oct 17, 2pm–4pm", "Sun Oct 18, 10am–12pm"]);
    expect(proposeSlots({ now: NOW, moveOutAt: "2026-10-15" }).length).toBe(2);
  });
  test("rules from remembered facts", () => {
    expect(
      rulesFromFacts(["Owner: I'd rather not do mornings", "Roommate Sam covers weekends"]),
    ).toMatchObject({ noMornings: true, noWeekends: false });
    expect(rulesFromFacts(["Owner can't do weekends"]).noWeekends).toBe(true);
  });
});
