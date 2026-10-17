import { describe, expect, test } from "bun:test";
import {
  attributeInbound,
  canTransition,
  codesIn,
  counterpartyTurn,
  decide,
  joinDeal,
  lastCallSweep,
  offerSlots,
  openDeal,
  ownerTurn,
  POLICIES,
  parseOfferCents,
  pickOfferedSlot,
  readCounterparty,
  readOwnerDecision,
  shield,
  withinLimit,
} from "@elves/engine";
import { type DealMode, MemoryStore } from "@elves/shared";

// Thursday 2026-10-15, 10:00 in Boston.
const NOW = new Date("2026-10-15T14:00:00Z");
const clock = { now: NOW };

describe("negotiation never crosses the owner's line, in every mode", () => {
  const cases: [DealMode, number, number][] = [
    ["sell_item", 12000, 8000],
    ["sublet_out", 140000, 115000],
    ["buy_item", 8000, 10000],
    ["find_sublet", 110000, 130000],
  ];
  for (const [mode, ask, limit] of cases) {
    test(mode, () => {
      const p = POLICIES[mode];
      // Sweep offers from far past the line to far inside it, over several rounds.
      for (
        let offer = Math.round(limit * 0.3);
        offer <= Math.round(ask * 1.6);
        offer += Math.round(ask / 37)
      ) {
        for (let rounds = 0; rounds <= 4; rounds++) {
          for (const final of [false, true]) {
            const d = decide(
              p,
              { ask, limit },
              { rounds, lastOffer: offer, lastCounter: null, ownerApproved: null },
              offer,
              { final },
            );
            if (d.kind === "accept" || d.kind === "counter")
              expect(withinLimit(p, d.cents, limit)).toBe(true);
            if (d.kind === "counter") expect(p.dir * d.cents).toBeGreaterThan(p.dir * offer);
          }
        }
      }
    });
  }

  test("sell: counter halfway, then meet a close offer; a stubborn lowball goes to the owner", () => {
    const p = POLICIES.sell_item;
    const t = { ask: 12000, limit: 8000 };
    const fresh = { rounds: 0, lastOffer: null, lastCounter: null, ownerApproved: null };
    expect(decide(p, t, fresh, 10000)).toEqual({ kind: "counter", cents: 11000 });
    expect(decide(p, t, { ...fresh, rounds: 1, lastOffer: 10000, lastCounter: 11000 }, 10500)).toEqual({
      kind: "accept",
      cents: 10500,
    });
    expect(decide(p, t, fresh, 6000)).toEqual({ kind: "counter", cents: 9000 });
    expect(decide(p, t, { ...fresh, rounds: 1, lastOffer: 6000, lastCounter: 9000 }, 6000)).toEqual({
      kind: "ask_owner",
      offer: 6000,
      hold: 9000,
    });
    expect(decide(p, t, fresh, 12000)).toEqual({ kind: "accept", cents: 12000 });
    expect(decide(p, t, fresh, null)).toEqual({ kind: "hold", cents: 12000 });
  });

  test("buy: we raise toward the ceiling and stop there", () => {
    const p = POLICIES.buy_item;
    const t = { ask: 8000, limit: 10000 };
    const d = decide(p, t, { rounds: 0, lastOffer: null, lastCounter: null, ownerApproved: null }, 14000);
    expect(d).toEqual({ kind: "counter", cents: 10000 });
    expect(
      decide(p, t, { rounds: 0, lastOffer: null, lastCounter: null, ownerApproved: null }, 7500),
    ).toEqual({
      kind: "accept",
      cents: 7500,
    });
  });

  test("an owner approval moves the line for that party only", () => {
    const p = POLICIES.sell_item;
    const d = decide(
      p,
      { ask: 12000, limit: 8000 },
      { rounds: 2, lastOffer: 6000, lastCounter: 8000, ownerApproved: 6000 },
      6000,
    );
    expect(d).toEqual({ kind: "accept", cents: 6000 });
  });
});

describe("state machine", () => {
  test("legal and illegal transitions", () => {
    expect(canTransition("listed", "negotiating")).toBe(true);
    expect(canTransition("scheduled", "handed_off")).toBe(true);
    expect(canTransition("handed_off", "paid")).toBe(true);
    expect(canTransition("listed", "paid")).toBe(false);
    expect(canTransition("paid", "listed")).toBe(false);
    expect(canTransition("donated", "negotiating")).toBe(false);
  });
});

describe("reading texts", () => {
  test("offers", () => {
    expect(parseOfferCents("would you take 60?")).toBe(6000);
    expect(parseOfferCents("can you do $55")).toBe(5500);
    expect(parseOfferCents("70 bucks")).toBe(7000);
    expect(parseOfferCents("85")).toBe(8500);
    expect(parseOfferCents("I can pick up at 6pm")).toBeNull();
    expect(parseOfferCents("is it still available")).toBeNull();
    expect(parseOfferCents("$1,150 a month?")).toBe(115000);
  });
  test("intents in context", () => {
    const none = { offeredSlots: [], scheduled: false, hasStandingPrice: true };
    expect(readCounterparty("never mind, found one", none).kind).toBe("walk");
    expect(readCounterparty("deal, I'll take it", none).kind).toBe("accept");
    expect(readCounterparty("is it still available?", none).kind).toBe("ask");
    expect(readCounterparty("60 is my final offer", none)).toEqual({
      kind: "offer",
      cents: 6000,
      final: true,
    });
    expect(readCounterparty("picked it up, thanks!", { ...none, scheduled: true }).kind).toBe("handoff");
    expect(readCounterparty("can't make it, something came up", { ...none, scheduled: true }).kind).toBe(
      "reschedule",
    );
  });
  test("slot picks", () => {
    const slots = offerSlots({ now: NOW });
    expect(slots.length).toBe(3);
    expect(slots[0]!.label).toBe("Thu 6pm");
    expect(pickOfferedSlot("2", slots)).toEqual(slots[1]!);
    expect(pickOfferedSlot("the first one works", slots)).toEqual(slots[0]!);
    expect(pickOfferedSlot(slots[2]!.label.toLowerCase(), slots)).toEqual(slots[2]!);
  });
  test("owner decisions", () => {
    expect(readOwnerDecision("yes take it")).toEqual({ kind: "yes" });
    expect(readOwnerDecision("no, too low")).toEqual({ kind: "no" });
    expect(readOwnerDecision("tell them 70")).toEqual({ kind: "price", cents: 7000 });
    expect(readOwnerDecision("what time is it")).toBeNull();
  });
  test("Scam Shield", () => {
    expect(shield("can I zelle you?")).toEqual([{ flag: "pay_outside_escrow", severe: false }]);
    expect(shield("send me the code I just sent to verify you").some((h) => h.severe)).toBe(true);
    expect(shield("I'm overseas, my mover will pick it up").some((h) => h.flag === "remote_buyer")).toBe(
      true,
    );
    expect(shield("is it still available?")).toEqual([]);
  });
});

describe("calendar", () => {
  test("three slots on different days, none before the lead time or past move-out, none already booked", () => {
    const first = offerSlots({ now: NOW });
    expect(first.map((s) => s.label)).toEqual(["Thu 6pm", "Fri 6pm", "Sat 10am"]);
    const next = offerSlots({ now: NOW, booked: [first[0]!] });
    expect(next[0]!.label).toBe("Thu 7pm");
    const tight = offerSlots({ now: NOW, until: new Date("2026-10-16T04:00:00Z") });
    expect(tight.map((s) => s.label)).toEqual(["Thu 6pm", "Thu 7pm"]);
  });
});

async function seed(mode: DealMode = "sell_item") {
  const store = new MemoryStore();
  const move = await store.createMove({
    ownerHandle: "+1555",
    ownerSpaceId: "spc_owner",
    platform: "imessage",
  });
  await store.upsertParticipant({
    moveId: move.id,
    handle: "+1555",
    role: "owner",
    spaceId: "spc_owner",
    platform: "imessage",
    agentUserId: "usr_pool",
  });
  const item = await store.upsertItem({
    moveId: move.id,
    name: "couch",
    category: "couch",
    floorPriceCents: 8000,
    listPriceCents: 12000,
  });
  const deal = await openDeal(store, {
    moveId: move.id,
    mode,
    subjectId: item.id,
    title: "couch",
    askCents: 12000,
    limitCents: 8000,
  });
  return { store, move, item, deal };
}

async function buyer(store: MemoryStore, dealId: string, n: string) {
  const deal = (await store.getDeal(dealId))!;
  return (
    await joinDeal(store, deal, {
      spaceId: `spc_${n}`,
      handle: n,
      platform: "imessage",
      agentUserId: "usr_pool",
    })
  ).party;
}

describe("a sale end to end against the store", () => {
  test("attribution by code and by item word; ambiguity returns null", async () => {
    const { store, deal } = await seed();
    expect(codesIn(`hey is ${deal.code} still there`)).toEqual([deal.code]);
    expect(
      (
        await attributeInbound(
          store,
          { text: `about ${deal.code.toLowerCase()}`, agentId: "x" },
          { allowMatch: false },
        )
      )?.via,
    ).toBe("code");
    expect(
      (
        await attributeInbound(
          store,
          { text: "is the couch available?", agentId: "usr_pool" },
          { allowMatch: true },
        )
      )?.deal.id,
    ).toBe(deal.id);
    expect(
      await attributeInbound(
        store,
        { text: "is the couch available?", agentId: "usr_other" },
        { allowMatch: true },
      ),
    ).toBeNull();
    expect(
      await attributeInbound(store, { text: "hello", agentId: "usr_pool" }, { allowMatch: true }),
    ).toBeNull();
  });

  test("greet → lowball → counter → stubborn → owner says no → accept → slot → handoff", async () => {
    const { store, move, deal, item } = await seed();
    let party = await buyer(store, deal.id, "b1");
    const say = async (text: string) => {
      const r = await counterpartyTurn({ store, move, party, text, clock });
      party = r.party!;
      return r;
    };

    let r = await say("is the couch still available?");
    expect(r.deal.state).toBe("negotiating");
    expect(r.messages.map((m) => [m.to, m.kind])).toEqual([["counterparty", "greet"]]);
    expect(r.messages.map((m) => m.text).join("\n")).not.toContain("80");

    r = await say("would you take 60?");
    expect(r.messages[0]).toMatchObject({ kind: "counter", text: "I can do $90." });

    r = await say("60 is my final offer");
    expect(r.messages.map((m) => [m.to, m.kind])).toEqual([
      ["counterparty", "checking"],
      ["owner", "ask"],
    ]);
    expect(party.status).toBe("awaiting_owner");
    // Counterparty-facing texts never carry the floor.
    for (const m of r.messages.filter((m) => m.to === "counterparty"))
      expect(JSON.stringify(m)).not.toContain("$80");
    await store.upsertDealParty({ ...party, ownerAskMessageId: "out_ask" });

    const o = await ownerTurn({ store, move, text: "no", parentMessageIds: ["out_ask"], clock });
    expect(o?.messages.map((m) => [m.to, m.kind])).toEqual([
      ["counterparty", "owner_no"],
      ["owner", "owner_no"],
    ]);
    expect(o?.messages[0]?.text).toContain("$90");
    party = o!.party!;

    r = await say("ok fine, deal");
    expect(party.status).toBe("agreed");
    expect(party.agreedCents).toBe(9000);
    expect(party.offeredSlots.length).toBe(3);

    r = await say("2");
    expect(r.deal.state).toBe("scheduled");
    expect(r.deal.slot?.label).toBe("Fri 6pm");
    expect(r.deal.winnerPartyId).toBe(party.id);

    // A second buyer is waitlisted while the first holds the booking.
    let b2 = await buyer(store, deal.id, "b2");
    const w = await counterpartyTurn({ store, move, party: b2, text: "couch still there?", clock });
    expect(w.messages[0]!.kind).toBe("waitlisted");
    b2 = w.party!;

    r = await say("picked it up, thanks!");
    expect(r.deal.state).toBe("handed_off");
    expect(r.deal.outcome).toBe("sold");
    expect(r.events.map((e) => e.type)).toContain("escrow.requested");
    expect(r.messages.find((m) => m.partyId === b2.id)?.kind).toBe("gone");
    expect((await store.listItems(move.id)).find((i) => i.id === item.id)?.outcome).toBe("sold");
  });

  test("the owner can say yes to an offer under the floor", async () => {
    const { store, move, deal } = await seed();
    let party = await buyer(store, deal.id, "b1");
    party = (await counterpartyTurn({ store, move, party, text: "$50", clock })).party!;
    party = (await counterpartyTurn({ store, move, party, text: "$50 firm", clock })).party!;
    expect(party.status).toBe("awaiting_owner");
    const o = await ownerTurn({ store, move, text: "yes", parentMessageIds: [], clock });
    expect(o?.party?.status).toBe("agreed");
    expect(o?.party?.agreedCents).toBe(5000);
    expect(o?.messages.find((m) => m.to === "counterparty")?.text).toStartWith("Good news");
  });

  test("a walk-away from a booking puts the deal back and tells the waitlist", async () => {
    const { store, move, deal } = await seed();
    let a = await buyer(store, deal.id, "a");
    a = (await counterpartyTurn({ store, move, party: a, text: "I'll take it", clock })).party!;
    a = (await counterpartyTurn({ store, move, party: a, text: "1", clock })).party!;
    let b = await buyer(store, deal.id, "b");
    b = (await counterpartyTurn({ store, move, party: b, text: "available?", clock })).party!;
    expect(b.status).toBe("waitlisted");
    const r = await counterpartyTurn({ store, move, party: a, text: "never mind, sorry", clock });
    expect(r.deal.state).toBe("negotiating");
    expect(r.deal.winnerPartyId).toBeNull();
    expect(r.messages.find((m) => m.partyId === b.id)?.kind).toBe("available_again");
  });

  test("Scam Shield: escrow-only warning, and a severe hit blocks the party", async () => {
    const { store, move, deal } = await seed();
    let party = await buyer(store, deal.id, "s");
    let r = await counterpartyTurn({ store, move, party, text: "can I venmo you?", clock });
    expect(r.messages.map((m) => m.kind)).toEqual(["escrow_only", "scam"]);
    party = r.party!;
    r = await counterpartyTurn({
      store,
      move,
      party,
      text: "I'm overseas, my mover will pick it up, I'll send a cashier's check",
      clock,
    });
    expect(r.party?.status).toBe("blocked");
    r = await counterpartyTurn({ store, move, party: r.party!, text: "hello?", clock });
    expect(r.messages).toEqual([]);
  });

  test("Last Call relists unsold items free 48h before move-out, once", async () => {
    const { store, move, deal } = await seed();
    await store.updateMove(move.id, { moveOutAt: "2026-10-17" });
    let party = await buyer(store, deal.id, "b");
    party = (await counterpartyTurn({ store, move, party, text: "would you take 40", clock })).party!;
    const early = await lastCallSweep(store, { now: new Date("2026-10-14T12:00:00Z") });
    expect(early.messages).toEqual([]);
    const sweep = await lastCallSweep(store, clock);
    expect(sweep.messages.map((m) => [m.to, m.kind])).toEqual([
      ["owner", "last_call"],
      ["counterparty", "last_call"],
    ]);
    const relisted = (await store.getDeal(deal.id))!;
    expect(relisted.state).toBe("relisted");
    expect(relisted.askCents).toBe(0);
    expect((await lastCallSweep(store, clock)).messages).toEqual([]);
    // Free: any yes is a deal at $0.
    const r = await counterpartyTurn({
      store,
      move,
      party: (await store.listDealParties(deal.id))[0]!,
      text: "yes please",
      clock,
    });
    expect(r.party?.status).toBe("agreed");
    expect(r.party?.agreedCents).toBe(0);
  });
});
