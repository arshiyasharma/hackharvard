/**
 * The Deal Engine's rules as pure functions over a Deal and one event. No I/O, no clock of its own, so every
 * rule has fixtures. The design doc's policy: counters stay inside the floor-to-list band, the floor is the last
 * counter, a buyer who pushes below it gets "let me ask the owner", three pickup slots are offered and the first
 * confirmation books, a no-show is rescheduled once, and hand-off needs both parties.
 */
import type { Deal, DealEvent, PolicyContext, Reply, Slot, Transition } from "./types.ts";

export function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/** A price the buyer typed: "$80", "80 bucks", "would you take 70", "70?", a bare number. Cents or null. */
export function parsePriceCents(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const money =
    t.match(/\$\s?(\d{1,5}(?:\.\d{1,2})?)/) ?? t.match(/\b(\d{1,5}(?:\.\d{1,2})?)\s?(?:dollars|bucks|usd)\b/);
  if (money?.[1]) return Math.round(Number(money[1]) * 100);
  const phrased = t.match(
    /\b(?:take|do|pay|offer|give|go|for|at|lowest|floor|minimum|best|how about|what about|maybe)\b[^0-9$]{0,24}?(\d{1,5})(?!\s*(?:am|pm|:|st|nd|rd|th|\/))\b/,
  );
  if (phrased?.[1]) return Math.round(Number(phrased[1]) * 100);
  const bare = t.match(/^(\d{1,5})\s*\??$/);
  if (bare?.[1]) return Number(bare[1]) * 100;
  // A short text with a two-to-five digit number that is not a time, date or ordinal ("still 90", "90 is my max").
  if (t.split(/\s+/).length <= 6) {
    const loose = t.match(
      /(?:^|[^\d:$.])(\d{2,5})(?![\d:]|\s*(?:am|pm|st|nd|rd|th|people|items?|of|minutes?|mins?|hours?|days?)\b)\b/,
    );
    if (loose?.[1] && !/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s*$/.test(t.slice(0, t.indexOf(loose[1]))))
      return Number(loose[1]) * 100;
  }
  return null;
}

const YES =
  /\b(yes|yeah|yep|yup|sure|ok|okay|deal|sold|done|works|fine|perfect|great|i'?ll take it|take it|let'?s do it|sounds good)\b/i;
const NO =
  /\b(no|nah|nope|pass|too (much|high|expensive)|can'?t do|not interested|never ?mind|forget it|i'?m out|walk)\b/i;
const AVAILABLE = /\b(available|still (have|got|there|up)|interested|do you (still )?have|about the)\b/i;
const PICKED_UP =
  /\b(got it|picked (it |them )?up|have it|paid|sent (the )?(money|payment)|venmo'?d|zelle'?d|all set|in my car|loaded)\b/i;
const CANCEL =
  /\b(can'?t make it|something came up|not (going to|gonna) make it|not coming|have to cancel|cancel|rain ?check)\b/i;
const ANY_SLOT = /\b(any|whatever|whichever|either|all) (of (them|those) )?(works?|is fine|time)\b|\bany time\b/i;

export type BuyerIntent = "offer" | "yes" | "no" | "available" | "picked_up" | "cancel" | "other";

/** What the buyer meant, from cheap patterns; a price wins over words. */
export function buyerIntent(text: string): { intent: BuyerIntent; cents: number | null } {
  const cents = parsePriceCents(text);
  if (cents != null) return { intent: "offer", cents };
  if (CANCEL.test(text)) return { intent: "cancel", cents: null };
  if (PICKED_UP.test(text)) return { intent: "picked_up", cents: null };
  if (NO.test(text) && !YES.test(text)) return { intent: "no", cents: null };
  if (YES.test(text)) return { intent: "yes", cents: null };
  if (AVAILABLE.test(text)) return { intent: "available", cents: null };
  return { intent: "other", cents: null };
}

/** "1", "the second one", "saturday", "2pm", "any" → index into the offered slots, or null. */
export function parseSlotPick(text: string, slots: Slot[]): number | null {
  const t = text.trim().toLowerCase();
  if (!slots.length) return null;
  if (ANY_SLOT.test(t)) return 0;
  const ordinal = t.match(/(?:^|\b)(?:option\s*|slot\s*|#)?([123])(?:\b|$)/) ?? t.match(/\b(first|second|third|last)\b/);
  if (ordinal?.[1]) {
    const map: Record<string, number> = { "1": 0, "2": 1, "3": 2, first: 0, second: 1, third: 2, last: slots.length - 1 };
    const i = map[ordinal[1]];
    if (i != null && i < slots.length) return i;
  }
  const byDay = slots
    .map((s, i) => ({ i, day: s.label.split(" ")[0]?.toLowerCase() ?? "" }))
    .filter((x) => x.day && new RegExp(`\\b${x.day.slice(0, 3)}`, "i").test(t));
  if (byDay.length === 1) return byDay[0]!.i;
  const hour = t.match(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/);
  if (hour?.[1]) {
    let h = Number(hour[1]) % 12;
    if (hour[2] === "pm") h += 12;
    const pool = byDay.length > 1 ? byDay.map((d) => d.i) : slots.map((_, i) => i);
    const hits = pool.filter((i) => localHour(slots[i]!) === h);
    if (hits.length === 1) return hits[0]!;
  }
  if (byDay.length > 1) return byDay[0]!.i;
  return null;
}

function localHour(slot: Slot): number {
  const m = slot.label.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return -1;
  let h = Number(m[1]) % 12;
  if (m[3]?.toLowerCase() === "pm") h += 12;
  return h;
}

export const midpoint = (floor: number, list: number) => floor + Math.round((list - floor) / 2);

const reply = (to: Reply["to"], text: string): Reply => ({ to, text });
const touched = (deal: Deal, now: Date): Deal => ({ ...deal, updatedAt: now.toISOString() });
const slotList = (slots: Slot[]) => slots.map((s, i) => `${i + 1}) ${s.label}`).join("  ");
const who = (deal: Deal) => (deal.buyerHandle ? `Buyer ${deal.buyerHandle}` : "The buyer");
const priceWord = (cents: number) => (cents === 0 ? "free" : fmtUsd(cents));

/** Move the deal to scheduling after a price is agreed. */
function agree(deal: Deal, cents: number, ctx: PolicyContext, lead = ""): Transition {
  const slots = ctx.slots();
  const d: Deal = touched(
    { ...deal, status: "negotiating", stage: "scheduling", agreedCents: cents, offeredSlots: slots, nudges: 0 },
    ctx.now,
  );
  return {
    deal: d,
    replies: [
      reply(
        "buyer",
        `${lead}Deal, ${priceWord(cents)} for the ${deal.itemName}. ${
          slots.length ? `Pickup slots: ${slotList(slots)}. Which works? Reply 1, 2 or 3.` : "When can you pick it up? Give me a day and a time."
        }`,
      ),
      reply(
        "owner",
        `${who(deal)} agreed to ${priceWord(cents)} for the ${deal.itemName}; picking a pickup slot now.${cents > 0 ? " The hold is in escrow." : ""}`,
      ),
    ],
    events: [{ type: "deal.agreed", payload: { agreedCents: cents, buyer: deal.buyerHandle } }],
    money: cents > 0 ? "hold" : undefined,
  };
}

function relist(deal: Deal, ctx: PolicyContext, why: string, replies: Reply[]): Transition {
  const d = touched({ ...deal, status: "relisted", stage: "done", slotAt: null }, ctx.now);
  return {
    deal: d,
    replies,
    events: [{ type: "deal.relisted", payload: { why, buyer: deal.buyerHandle } }],
    money: deal.agreedCents && deal.agreedCents > 0 ? "refund" : undefined,
  };
}

function negotiating(deal: Deal, text: string, ctx: PolicyContext): Transition {
  const { intent, cents } = buyerIntent(text);
  const list = deal.listCents;
  const floor = deal.floorCents ?? deal.listCents;
  const base: Deal = touched(
    { ...deal, status: deal.status === "listed" ? "negotiating" : deal.status, lastBuyerAt: ctx.now.toISOString() },
    ctx.now,
  );
  const name = deal.itemName;

  if (intent === "no" || intent === "cancel") {
    return relist(base, ctx, "buyer_declined", [
      reply("buyer", `No worries. Text me if you change your mind; the ${name} is ${priceWord(list)}.`),
    ]);
  }
  if (intent === "yes") return agree(base, deal.counterCents ?? list, ctx);
  if (intent === "offer" && cents != null) {
    const d = { ...base, lastOfferCents: cents };
    if (list === 0 || cents >= list) return agree(d, Math.min(cents, list), ctx);
    const mid = midpoint(floor, list);
    if (cents >= mid) return agree(d, cents, ctx);
    if (d.counterCents != null && cents >= d.counterCents) return agree(d, cents, ctx);
    if (cents >= floor) {
      if (d.counters >= 2) return agree(d, cents, ctx);
      const counter =
        d.counters === 0
          ? Math.max(mid, floor)
          : Math.max(floor, Math.round((cents + (d.counterCents ?? mid)) / 2 / 100) * 100);
      const next = { ...d, counters: d.counters + 1, counterCents: counter };
      return {
        deal: next,
        replies: [reply("buyer", `I can do ${fmtUsd(counter)} for the ${name}. Want it at that?`)],
        events: [{ type: "deal.countered", payload: { offerCents: cents, counterCents: counter } }],
      };
    }
    // Below the floor: the floor is the last counter; a second push goes to the owner.
    if (d.counterCents !== floor) {
      const next = { ...d, counters: d.counters + 1, counterCents: floor };
      return {
        deal: next,
        replies: [reply("buyer", `The lowest I can go on the ${name} is ${fmtUsd(floor)}. Want it at that?`)],
        events: [{ type: "deal.countered", payload: { offerCents: cents, counterCents: floor, atFloor: true } }],
      };
    }
    const next: Deal = { ...d, status: "awaiting_owner" };
    return {
      deal: next,
      replies: [
        reply("buyer", `Let me check with the owner on ${fmtUsd(cents)}. I'll text you back shortly.`),
        reply(
          "owner",
          `${who(deal)} is offering ${fmtUsd(cents)} for the ${name}; your floor is ${fmtUsd(floor)}. Take it? Reply yes or no.`,
        ),
      ],
      events: [{ type: "deal.owner_asked", payload: { offerCents: cents, floorCents: floor } }],
    };
  }
  const lead = deal.status === "listed" ? `Yes, the ${name} is still available` : `The ${name} is`;
  return {
    deal: base,
    replies: [
      reply(
        "buyer",
        list === 0 ? `${lead} free; first to pick up gets it. Want it?` : `${lead} at ${fmtUsd(list)}. Want it? You can also make an offer.`,
      ),
    ],
    events: [],
  };
}

function awaitingOwner(deal: Deal, ev: DealEvent, ctx: PolicyContext): Transition {
  const floor = deal.floorCents ?? deal.listCents;
  if (ev.kind === "owner_decision") {
    const offer = deal.lastOfferCents ?? floor;
    if (ev.approved) return agree({ ...deal, status: "negotiating" }, offer, ctx, `Good news, the owner will take ${fmtUsd(offer)}. `);
    const d: Deal = touched({ ...deal, status: "negotiating", counterCents: floor }, ctx.now);
    return {
      deal: d,
      replies: [
        reply("buyer", `The owner is holding at ${fmtUsd(floor)} for the ${deal.itemName}. Want it at that, or should I let it go?`),
        reply("owner", `Told ${who(deal).toLowerCase()} you're holding at ${fmtUsd(floor)}.`),
      ],
      events: [{ type: "deal.owner_declined", payload: { offerCents: deal.lastOfferCents } }],
    };
  }
  if (ev.kind === "buyer_text") {
    const { intent, cents } = buyerIntent(ev.text);
    if (intent === "no" || intent === "cancel")
      return relist(deal, ctx, "buyer_declined", [reply("buyer", `No problem. The ${deal.itemName} stays listed if you change your mind.`)]);
    if (intent === "offer" && cents != null && cents >= floor)
      return agree({ ...deal, status: "negotiating", lastOfferCents: cents }, Math.min(cents, deal.listCents), ctx);
    return { deal, replies: [reply("buyer", "Still waiting on the owner; I'll text you the moment I hear back.")], events: [] };
  }
  return { deal, replies: [], events: [] };
}

function scheduling(deal: Deal, text: string, ctx: PolicyContext): Transition {
  const { intent } = buyerIntent(text);
  if (intent === "cancel" || intent === "no") {
    return relist(deal, ctx, "buyer_walked", [
      reply("buyer", `Understood, I'll release the ${deal.itemName}. Thanks for letting me know.`),
      reply("owner", `${who(deal)} backed out of the ${deal.itemName}; it's listed again${deal.listCents ? ` at ${fmtUsd(deal.listCents)}` : ""}.`),
    ]);
  }
  const pick = parseSlotPick(text, deal.offeredSlots);
  if (pick == null) {
    const nudges = deal.nudges + 1;
    const slots = nudges >= 2 ? ctx.slots() : deal.offeredSlots;
    const d = touched({ ...deal, nudges, offeredSlots: slots }, ctx.now);
    return {
      deal: d,
      replies: [
        reply("buyer", slots.length ? `Which slot works? ${slotList(slots)}. Reply 1, 2 or 3.` : "When works for pickup? Give me a day and a time."),
      ],
      events: [],
    };
  }
  const slot = deal.offeredSlots[pick]!;
  const d: Deal = touched(
    { ...deal, status: "scheduled", stage: "handoff", slotAt: slot.start, buyerConfirmed: false, ownerConfirmed: false },
    ctx.now,
  );
  return {
    deal: d,
    replies: [
      reply("buyer", `Booked: ${slot.label} for the ${deal.itemName}. I'll text the address the morning of. When you have it, text me "got it".`),
      reply("owner", `${who(deal)}: ${deal.itemName}, ${slot.label}, ${priceWord(deal.agreedCents ?? 0)}. Confirmed 🎉 Reply "handed off" once they have it.`),
    ],
    events: [{ type: "deal.scheduled", payload: { slotAt: slot.start, agreedCents: deal.agreedCents } }],
  };
}

function handoff(deal: Deal, ev: DealEvent, ctx: PolicyContext): Transition {
  const price = deal.agreedCents ?? 0;
  const complete = (d: Deal): Transition => {
    const done: Deal = touched(
      { ...d, status: "paid", stage: "done", buyerConfirmed: true, ownerConfirmed: true, reliability: Math.min(1, d.reliability + 0.1) },
      ctx.now,
    );
    return {
      deal: done,
      replies: [
        reply("buyer", `Thanks, enjoy the ${deal.itemName}!`),
        reply(
          "owner",
          price > 0
            ? `${deal.itemName} handed off to ${who(deal).toLowerCase()}. ${fmtUsd(price)} released from escrow to your Moving Fund.`
            : `${deal.itemName} handed off to ${who(deal).toLowerCase()}. One less thing for the curb.`,
        ),
      ],
      events: [{ type: "deal.handed_off", payload: { agreedCents: price } }],
      itemPatch: { outcome: price > 0 ? "sold" : "given" },
      money: price > 0 ? "release" : undefined,
    };
  };
  if (ev.kind === "owner_handoff") {
    if (deal.buyerConfirmed) return complete(deal);
    return {
      deal: touched({ ...deal, status: "handed_off", ownerConfirmed: true }, ctx.now),
      replies: [
        reply("buyer", `The owner marked the ${deal.itemName} handed off. Reply "got it" to confirm${price > 0 ? ` and release ${fmtUsd(price)}` : ""}.`),
        reply("owner", `Noted. I've asked ${who(deal).toLowerCase()} to confirm; ${price > 0 ? "escrow releases on their word." : "then it's done."}`),
      ],
      events: [{ type: "deal.owner_confirmed", payload: {} }],
    };
  }
  if (ev.kind === "owner_noshow") {
    if (deal.reschedules === 0) {
      const slots = ctx.slots();
      const d: Deal = touched(
        { ...deal, status: "negotiating", stage: "scheduling", reschedules: 1, slotAt: null, offeredSlots: slots, nudges: 0, reliability: Math.max(0, deal.reliability - 0.3) },
        ctx.now,
      );
      return {
        deal: d,
        replies: [
          reply("buyer", `Looks like we missed each other for the ${deal.itemName}. New slots: ${slotList(slots)}. Which works?`),
          reply("owner", `Rescheduling with ${who(deal).toLowerCase()} once; if they miss again the ${deal.itemName} goes back up.`),
        ],
        events: [{ type: "deal.noshow", payload: { reschedules: 1 } }],
      };
    }
    return relist({ ...deal, reliability: Math.max(0, deal.reliability - 0.3) }, ctx, "noshow_twice", [
      reply("buyer", `Sorry, the ${deal.itemName} is going to the next person.`),
      reply("owner", `${who(deal)} no-showed twice; the ${deal.itemName} is listed again${deal.listCents ? ` at ${fmtUsd(deal.listCents)}` : ""}.`),
    ]);
  }
  if (ev.kind === "buyer_text") {
    const { intent } = buyerIntent(ev.text);
    if (intent === "picked_up" || intent === "yes") {
      if (deal.ownerConfirmed) return complete(deal);
      return {
        deal: touched({ ...deal, status: "handed_off", buyerConfirmed: true }, ctx.now),
        replies: [
          reply("buyer", `Great. ${price > 0 ? "Your payment releases once the owner confirms." : "Enjoy it!"}`),
          reply("owner", `${who(deal)} says they have the ${deal.itemName}. Reply "handed off" to ${price > 0 ? `release ${fmtUsd(price)}` : "close it out"}.`),
        ],
        events: [{ type: "deal.buyer_confirmed", payload: {} }],
      };
    }
    if (intent === "cancel" || intent === "no") {
      return relist(deal, ctx, "buyer_cancelled", [
        reply("buyer", `Okay, I've released the ${deal.itemName}.`),
        reply("owner", `${who(deal)} cancelled the ${deal.itemName} pickup; it's listed again.`),
      ]);
    }
    const slot = deal.offeredSlots.find((s) => s.start === deal.slotAt);
    return {
      deal,
      replies: [reply("buyer", `You're booked for ${slot?.label ?? "the agreed time"}. Text "got it" once you have the ${deal.itemName}.`)],
      events: [],
    };
  }
  return { deal, replies: [], events: [] };
}

/** One event against one deal. Owner withdraw, opt-out and price changes apply in any stage. */
export function applyEvent(deal: Deal, ev: DealEvent, ctx: PolicyContext): Transition {
  if (ev.kind === "owner_withdraw") {
    const d: Deal = touched({ ...deal, status: "withdrawn", stage: "done" }, ctx.now);
    return {
      deal: d,
      replies: deal.buyerSpaceId ? [reply("buyer", `Sorry, the ${deal.itemName} is no longer available.`)] : [],
      events: [{ type: "deal.withdrawn", payload: {} }],
      money: deal.agreedCents && deal.agreedCents > 0 && deal.status === "scheduled" ? "refund" : undefined,
    };
  }
  if (ev.kind === "owner_optout") {
    return { deal: touched({ ...deal, lastCallOptOut: true }, ctx.now), replies: [], events: [{ type: "lastcall.opt_out", payload: {} }] };
  }
  if (ev.kind === "price_change") {
    if (deal.stage !== "negotiating") return { deal, replies: [], events: [] };
    const d: Deal = touched(
      { ...deal, status: deal.status === "awaiting_owner" ? "negotiating" : deal.status, listCents: ev.listCents, floorCents: ev.floorCents, counterCents: null, counters: 0, lastCallStage: ev.why },
      ctx.now,
    );
    const tell = deal.status === "negotiating" || deal.status === "awaiting_owner" || deal.status === "waiting";
    return {
      deal: d,
      replies: tell
        ? [reply("buyer", ev.listCents === 0 ? `The ${deal.itemName} is now free; first to pick up gets it. Want it?` : `Price drop: the ${deal.itemName} is now ${fmtUsd(ev.listCents)}. Want it?`)]
        : [],
      events: [],
    };
  }
  if (ev.kind === "promote") {
    const d: Deal = touched({ ...deal, status: "listed", stage: "negotiating" }, ctx.now);
    return {
      deal: d,
      replies: [reply("buyer", `Good news, the ${deal.itemName} is available again${deal.listCents === 0 ? ", free" : ` at ${fmtUsd(deal.listCents)}`}. Want it?`)],
      events: [{ type: "deal.promoted", payload: {} }],
    };
  }
  if (deal.status === "awaiting_owner") return awaitingOwner(deal, ev, ctx);
  if (deal.stage === "negotiating") {
    if (ev.kind === "buyer_text") return negotiating(deal, ev.text, ctx);
    return { deal, replies: [], events: [] };
  }
  if (deal.stage === "scheduling") {
    if (ev.kind === "buyer_text") return scheduling(deal, ev.text, ctx);
    if (ev.kind === "owner_noshow")
      return { deal, replies: [reply("owner", `No pickup is booked yet with ${who(deal).toLowerCase()}; they're still picking a slot.`)], events: [] };
    return { deal, replies: [], events: [] };
  }
  if (deal.stage === "handoff") return handoff(deal, ev, ctx);
  return { deal, replies: [], events: [] };
}

/** Last Call pricing per the design doc: 60% of list at T−48h, free at T−24h. */
export function lastCallPrice(stage: "drop" | "free", listCents: number | null, floorCents: number | null): { listCents: number; floorCents: number | null } {
  if (stage === "free") return { listCents: 0, floorCents: 0 };
  const list = Math.max(100, Math.round(((listCents ?? 0) * 0.6) / 100) * 100);
  return { listCents: list, floorCents: floorCents == null ? null : Math.min(floorCents, list) };
}

/** Hours before move-out at which each Last Call stage fires. */
export const LAST_CALL_HOURS: Record<"drop" | "free" | "close", number> = { drop: 48, free: 24, close: 0 };
