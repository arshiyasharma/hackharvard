import type { Deal, DealMode, DealParty, DealState, Move, Participant, Slot, Store } from "@elves/shared";
import { DEFAULT_TZ, isFree, moveOutInstant, offerSlots, type Window } from "./calendar.ts";
import { readCounterparty, readOwnerDecision } from "./intent.ts";
import { assertTransition, canTransition, isOpen } from "./machine.ts";
import { decide, type PartyPosition, type Terms } from "./negotiate.ts";
import { type ModePolicy, policyFor } from "./policy.ts";
import { shield } from "./shield.ts";

/** Letter-digit-letter-digit, no look-alikes (no I/O/0/1/B/8/S/5): "K7Q2". */
const LETTERS = "ACDEFHJKMNPRTWXY";
const DIGITS = "234679";
const CODE_RE = /\b([A-Z][0-9][A-Z][0-9])\b/g;

export function newDealCode(rand: () => number = Math.random): string {
  const pick = (s: string) => s[Math.floor(rand() * s.length)]!;
  return `${pick(LETTERS)}${pick(DIGITS)}${pick(LETTERS)}${pick(DIGITS)}`;
}

export function codesIn(text: string): string[] {
  return [...text.toUpperCase().matchAll(CODE_RE)].map((m) => m[1]!);
}

const fmt = (cents: number) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
export function price(cents: number | null, unit: "each" | "month" = "each"): string {
  if (cents == null) return "make an offer";
  if (cents === 0) return "free";
  return unit === "month" ? `${fmt(cents)}/mo` : fmt(cents);
}

/** A text the engine wants sent. The Elf may redraft `text` in its own voice from `facts`. */
export interface EngineMessage {
  to: "counterparty" | "owner";
  /** For counterparty messages: which party (and so which space). */
  partyId?: string;
  dealId: string;
  kind: string;
  text: string;
  /** What the drafter may say. Counterparty facts never carry the owner's limit. */
  facts: Record<string, unknown>;
  /** An owner question about this party's offer; the sent message id is recorded so a threaded answer finds it. */
  askFor?: string;
}

export interface EngineEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface TurnResult {
  deal: Deal;
  party: DealParty | null;
  messages: EngineMessage[];
  events: EngineEvent[];
}

export interface EngineClock {
  now: Date;
  tz?: string;
  windows?: Window[];
}

// ---------------------------------------------------------------------------------------------------------------
// Opening deals and attributing inbound counterparties

export async function openDeal(
  store: Store,
  input: {
    moveId: string;
    mode: DealMode;
    subjectId: string | null;
    title: string;
    askCents: number | null;
    limitCents: number | null;
  },
): Promise<Deal> {
  const p = policyFor(input.mode);
  const existing =
    input.subjectId != null
      ? (await store.listDeals(input.moveId)).find(
          (d) => d.mode === input.mode && d.subjectId === input.subjectId && isOpen(d.state),
        )
      : undefined;
  if (existing)
    return store.upsertDeal({
      ...existing,
      title: input.title,
      askCents: input.askCents,
      limitCents: input.limitCents,
    });
  for (let i = 0; i < 12; i++) {
    const code = newDealCode();
    if (await store.getDealByCode(code)) continue;
    return store.upsertDeal({ ...input, code, unit: p.unit, state: "listed" });
  }
  throw new Error("could not mint a unique deal code");
}

export interface Attribution {
  deal: Deal;
  move: Move;
  via: "code" | "match";
}

const STOP = new Set(
  "the and for with from this that your have just still want like does available".split(" "),
);
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/**
 * Which open deal a stranger's first text is about. A quoted ref code always wins; otherwise, when allowed, a
 * single open deal on the same pool number whose title shares a word with the text ("is the couch available?").
 * Ambiguity returns null: a wrong guess would put a stranger in someone else's deal.
 */
export async function attributeInbound(
  store: Store,
  msg: { text: string | null; agentId: string },
  opts: { allowMatch: boolean },
): Promise<Attribution | null> {
  const text = msg.text ?? "";
  for (const code of codesIn(text)) {
    const deal = await store.getDealByCode(code);
    if (!deal || !isOpen(deal.state)) continue;
    const move = await store.getMove(deal.moveId);
    if (move) return { deal, move, via: "code" };
  }
  if (!opts.allowMatch || !text.trim()) return null;
  const said = words(text);
  const hits: Attribution[] = [];
  for (const deal of await store.listOpenDeals()) {
    const move = await store.getMove(deal.moveId);
    if (!move) continue;
    const owners = (await store.listParticipants(move.id)).filter((p) => p.role === "owner");
    if (!owners.some((o) => o.agentUserId === msg.agentId)) continue;
    if ([...words(deal.title)].some((w) => said.has(w) || said.has(`${w}s`)))
      hits.push({ deal, move, via: "match" });
  }
  return hits.length === 1 ? hits[0]! : null;
}

/** Put a counterparty in a deal: a participant row for their space and a party row for this deal. */
export async function joinDeal(
  store: Store,
  deal: Deal,
  who: { spaceId: string; handle: string; platform: string; agentUserId: string | null },
): Promise<{ participant: Participant; party: DealParty }> {
  const p = policyFor(deal.mode);
  const existing = await store.getParticipantBySpace(who.spaceId);
  const participant =
    existing && existing.moveId === deal.moveId
      ? existing
      : await store.upsertParticipant({
          moveId: deal.moveId,
          handle: who.handle,
          role: p.counterpartyRole,
          spaceId: who.spaceId,
          platform: who.platform,
          agentUserId: who.agentUserId,
        });
  const prior = (await store.listDealPartiesBySpace(who.spaceId)).find((x) => x.dealId === deal.id);
  const party =
    prior ??
    (await store.upsertDealParty({
      dealId: deal.id,
      moveId: deal.moveId,
      spaceId: who.spaceId,
      handle: who.handle,
      role: p.counterpartyRole,
    }));
  return { participant, party };
}

/**
 * The party a counterparty text is for. A ref code for another open deal of the same move opens a party there;
 * otherwise the most recently active party whose deal is still open.
 */
export async function partyForText(
  store: Store,
  spaceId: string,
  text: string,
  who: { handle: string; platform: string; agentUserId: string | null },
): Promise<DealParty | null> {
  const parties = await store.listDealPartiesBySpace(spaceId);
  if (!parties.length) return null;
  const moveId = parties[0]!.moveId;
  for (const code of codesIn(text)) {
    const deal = await store.getDealByCode(code);
    if (deal && deal.moveId === moveId && isOpen(deal.state)) {
      return (await joinDeal(store, deal, { spaceId, ...who })).party;
    }
  }
  const said = words(text);
  const withDeals = await Promise.all(parties.map(async (p) => ({ p, d: await store.getDeal(p.dealId) })));
  const open = withDeals.filter((x) => x.d && isOpen(x.d.state));
  const pool = open.length ? open : withDeals;
  const named = pool.filter(
    (x) => x.d && [...words(x.d.title)].some((w) => said.has(w) || said.has(`${w}s`)),
  );
  if (named.length === 1) return named[0]!.p;
  if (named.length > 1) return null;
  pool.sort((a, b) => b.p.updatedAt.localeCompare(a.p.updatedAt));
  return pool[0]?.p ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers

async function setState(store: Store, deal: Deal, to: DealState, patch: Partial<Deal> = {}): Promise<Deal> {
  assertTransition(deal.state, to);
  return store.upsertDeal({ ...deal, ...patch, state: to });
}

function terms(deal: Deal): Terms {
  const ask = deal.askCents ?? deal.limitCents ?? 0;
  return { ask, limit: deal.limitCents ?? ask };
}

function position(party: DealParty): PartyPosition {
  return {
    rounds: party.rounds,
    lastOffer: party.lastOfferCents,
    lastCounter: party.lastCounterCents,
    ownerApproved: party.ownerApprovedCents,
  };
}

/** Every slot booked anywhere in the move: one shared pickup calendar. */
async function bookedSlots(store: Store, moveId: string, except?: string): Promise<Slot[]> {
  const out: Slot[] = [];
  for (const d of await store.listDeals(moveId)) {
    if (d.state !== "scheduled") continue;
    for (const p of await store.listDealParties(d.id)) if (p.slot && p.id !== except) out.push(p.slot);
  }
  return out;
}

async function freshSlots(store: Store, move: Move, clock: EngineClock, except?: string): Promise<Slot[]> {
  const tz = clock.tz ?? DEFAULT_TZ;
  return offerSlots({
    now: clock.now,
    until: moveOutInstant(move.moveOutAt, tz),
    booked: await bookedSlots(store, move.id, except),
    windows: clock.windows,
    tz,
  });
}

const who = (p: ModePolicy) => p.counterpartyRole;
const slotList = (slots: Slot[]) => slots.map((s, i) => `${i + 1}) ${s.label}`).join("  ");

/** What a counterparty may hear about the deal: never the limit, never other parties. */
function publicFacts(deal: Deal, p: ModePolicy, extra: Record<string, unknown> = {}) {
  return { title: deal.title, price: price(deal.askCents, p.unit), meet: p.meetNoun, ...extra };
}

/** Move a party to agreed at `cents` and offer pickup slots. */
async function agree(
  store: Store,
  move: Move,
  deal: Deal,
  party: DealParty,
  cents: number,
  clock: EngineClock,
  lead: string,
): Promise<TurnResult> {
  const p = policyFor(deal.mode);
  const slots = await freshSlots(store, move, clock, party.id);
  party = await store.upsertDealParty({
    ...party,
    status: "agreed",
    agreedCents: cents,
    lastCounterCents: cents,
    offeredSlots: slots,
    ownerAskMessageId: null,
  });
  if (deal.state !== "negotiating") deal = await setState(store, deal, "negotiating");
  const at = price(cents, p.unit);
  const messages: EngineMessage[] = [
    {
      to: "counterparty",
      partyId: party.id,
      dealId: deal.id,
      kind: "agreed",
      text: slots.length
        ? `${lead}${at === "free" ? "It's yours." : `Deal at ${at}.`} ${cap(p.meetNoun)} times: ${slotList(slots)}. Which works?`
        : `${lead}${at === "free" ? "It's yours." : `Deal at ${at}.`} When could you do the ${p.meetNoun}?`,
      facts: publicFacts(deal, p, {
        agreedPrice: at,
        slots: slots.map((s) => s.label),
        lead: lead.trim() || null,
      }),
    },
    {
      to: "owner",
      dealId: deal.id,
      kind: "agreed",
      text: `${cap(who(p))} agreed to ${at} for the ${deal.title}; offering ${p.meetNoun} times now.`,
      facts: { title: deal.title, agreedPrice: at, counterparty: who(p), slots: slots.map((s) => s.label) },
    },
  ];
  return {
    deal,
    party,
    messages,
    events: [
      {
        type: "deal.agreed",
        payload: { dealId: deal.id, partyId: party.id, cents, slots: slots.map((s) => s.id) },
      },
      ...(cents > 0
        ? [{ type: "ledger.hold", payload: { dealId: deal.id, partyId: party.id, cents } }]
        : []),
    ],
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A party leaves (walked, blocked). Unless someone else holds the booking, the deal goes back to the inbound
 * queue: negotiating while others are still talking, else listed (relisted when it is already free). Waitlisted
 * parties hear it is available again.
 */
async function release(
  store: Store,
  deal: Deal,
  leaving: DealParty,
): Promise<{ deal: Deal; messages: EngineMessage[] }> {
  const p = policyFor(deal.mode);
  const others = (await store.listDealParties(deal.id)).filter((x) => x.id !== leaving.id);
  const waiting = others.filter((x) => x.status === "waitlisted");
  const active = others.filter((x) => ["talking", "agreed", "awaiting_owner"].includes(x.status));
  const heldByOther =
    deal.state === "scheduled" && deal.winnerPartyId != null && deal.winnerPartyId !== leaving.id;
  const messages: EngineMessage[] = [];
  if (heldByOther) return { deal, messages };
  const back: DealState =
    active.length || waiting.length ? "negotiating" : deal.askCents === 0 ? "relisted" : "listed";
  if (deal.state !== back) deal = await setState(store, deal, back);
  if (deal.winnerPartyId === leaving.id || deal.slot)
    deal = await store.upsertDeal({ ...deal, winnerPartyId: null, slot: null, agreedCents: null });
  for (const w of waiting) {
    await store.upsertDealParty({ ...w, status: "talking" });
    messages.push({
      to: "counterparty",
      partyId: w.id,
      dealId: deal.id,
      kind: "available_again",
      text: `Good news: the ${deal.title} is available again (${price(deal.askCents, p.unit)}). Still want it?`,
      facts: publicFacts(deal, p),
    });
  }
  return { deal, messages };
}

// ---------------------------------------------------------------------------------------------------------------
// A counterparty texts in

export async function counterpartyTurn(input: {
  store: Store;
  move: Move;
  party: DealParty;
  text: string;
  clock: EngineClock;
}): Promise<TurnResult> {
  const { store, move, text, clock } = input;
  let party = input.party;
  let deal = await store.getDeal(party.dealId);
  if (!deal) throw new Error(`deal ${party.dealId} not found`);
  const p = policyFor(deal.mode);
  const events: EngineEvent[] = [];
  const messages: EngineMessage[] = [];
  const done = (): TurnResult => ({ deal: deal!, party, messages, events });

  if (party.status === "blocked") return done();

  // Scam Shield: money only moves through escrow.
  const hits = shield(text);
  if (hits.length) {
    const severe = hits.some((h) => h.severe);
    const flags = [...new Set([...party.scamFlags, ...hits.map((h) => h.flag)])];
    party = await store.upsertDealParty({
      ...party,
      scamFlags: flags,
      status: severe ? "blocked" : party.status,
    });
    events.push({
      type: "scam.flagged",
      payload: { dealId: deal.id, partyId: party.id, flags: hits.map((h) => h.flag), severe },
    });
    if (severe) {
      const r = await release(store, deal, party);
      deal = r.deal;
      messages.push(...r.messages);
    }
    messages.push(
      severe
        ? {
            to: "counterparty",
            partyId: party.id,
            dealId: deal.id,
            kind: "scam_blocked",
            text: "Sorry, I can't do that. Payment and pickup only go through Elves, so I'll pass on this one.",
            facts: { blocked: true },
          }
        : {
            to: "counterparty",
            partyId: party.id,
            dealId: deal.id,
            kind: "escrow_only",
            text: `All payments go through the Elves escrow link I send at the ${p.meetNoun}; no Venmo, Zelle or cash apps. Still interested at ${price(party.lastCounterCents ?? deal.askCents, p.unit)}?`,
            facts: publicFacts(deal, p, {
              rule: "escrow only",
              price: price(party.lastCounterCents ?? deal.askCents, p.unit),
            }),
          },
      {
        to: "owner",
        dealId: deal.id,
        kind: "scam",
        text: severe
          ? `Scam Shield blocked a ${who(p)} on the ${deal.title} (${hits.map((h) => h.flag.replace(/_/g, " ")).join(", ")}). Nothing was sent.`
          : `Scam Shield: a ${who(p)} on the ${deal.title} asked to pay outside escrow; I told them escrow only.`,
        facts: { title: deal.title, flags: hits.map((h) => h.flag), severe },
      },
    );
    return done();
  }

  if (!isOpen(deal.state)) {
    messages.push({
      to: "counterparty",
      partyId: party.id,
      dealId: deal.id,
      kind: "gone",
      text: `Sorry, the ${deal.title} is gone.`,
      facts: { title: deal.title, gone: true },
    });
    return done();
  }

  if (deal.state === "scheduled" && deal.winnerPartyId && deal.winnerPartyId !== party.id) {
    if (party.status !== "waitlisted")
      party = await store.upsertDealParty({ ...party, status: "waitlisted" });
    messages.push({
      to: "counterparty",
      partyId: party.id,
      dealId: deal.id,
      kind: "waitlisted",
      text: `Someone has a ${p.meetNoun} booked for the ${deal.title}. I'll text you if it falls through.`,
      facts: { title: deal.title, spokenFor: true },
    });
    return done();
  }

  if (deal.state === "listed" || deal.state === "relisted") deal = await setState(store, deal, "negotiating");

  const standing = party.lastCounterCents ?? deal.askCents;
  const intent = readCounterparty(text, {
    offeredSlots: party.status === "agreed" ? party.offeredSlots : [],
    scheduled: party.status === "scheduled",
    hasStandingPrice: standing != null,
  });
  events.push({ type: "deal.read", payload: { dealId: deal.id, partyId: party.id, intent: intent.kind } });

  switch (intent.kind) {
    case "walk": {
      const refundCents =
        (party.agreedCents ?? 0) > 0 && (party.status === "agreed" || party.status === "scheduled")
          ? (party.agreedCents ?? 0)
          : 0;
      party = await store.upsertDealParty({
        ...party,
        status: "walked",
        offeredSlots: [],
        slot: null,
        ownerAskMessageId: null,
      });
      if (refundCents > 0)
        events.push({
          type: "ledger.refund",
          payload: { dealId: deal.id, partyId: party.id, cents: refundCents },
        });
      const r = await release(store, deal, party);
      deal = r.deal;
      events.push({ type: "deal.party_walked", payload: { dealId: deal.id, partyId: party.id } });
      messages.push(
        {
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "walked",
          text: "No problem, thanks for letting me know.",
          facts: {},
        },
        {
          to: "owner",
          dealId: deal.id,
          kind: "walked",
          text: `A ${who(p)} walked away from the ${deal.title}; it's back on the market.`,
          facts: { title: deal.title },
        },
        ...r.messages,
      );
      return done();
    }

    case "handoff": {
      const cents = party.agreedCents ?? deal.agreedCents ?? 0;
      const outcome = cents > 0 ? p.outcomeSold : p.outcomeFree;
      party = await store.upsertDealParty({ ...party, status: "handed_off" });
      deal = await setState(store, deal, "handed_off", {
        agreedCents: cents,
        outcome,
        winnerPartyId: party.id,
      });
      await tagSubject(store, deal, outcome);
      events.push({
        type: "deal.handed_off",
        payload: { dealId: deal.id, partyId: party.id, cents, outcome },
      });
      if (cents > 0) {
        events.push({ type: "escrow.requested", payload: { dealId: deal.id, partyId: party.id, cents } });
        events.push({ type: "ledger.release", payload: { dealId: deal.id, partyId: party.id, cents } });
      }
      for (const other of await store.listDealParties(deal.id)) {
        if (
          other.id === party.id ||
          !["talking", "agreed", "awaiting_owner", "waitlisted"].includes(other.status)
        )
          continue;
        await store.upsertDealParty({ ...other, status: "walked" });
        messages.push({
          to: "counterparty",
          partyId: other.id,
          dealId: deal.id,
          kind: "gone",
          text: `Sorry, the ${deal.title} went to someone else. Thanks for your interest!`,
          facts: { title: deal.title, gone: true },
        });
      }
      messages.push(
        {
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "handed_off",
          text:
            cents > 0
              ? `Enjoy the ${deal.title}! Payment (${price(cents)}) runs through Elves escrow.`
              : `Enjoy the ${deal.title}!`,
          facts: { title: deal.title, price: price(cents) },
        },
        {
          to: "owner",
          dealId: deal.id,
          kind: "handed_off",
          text:
            cents > 0
              ? `Handed off: the ${deal.title} went for ${price(cents)}. Payment runs through escrow; I'll mark it paid when it clears.`
              : `Handed off: the ${deal.title} went free to a good home.`,
          facts: { title: deal.title, price: price(cents), outcome },
        },
      );
      return done();
    }

    case "reschedule": {
      party = await store.upsertDealParty({
        ...party,
        status: "agreed",
        slot: null,
        noShows: party.noShows + 1,
      });
      deal = await setState(store, deal, "negotiating", { winnerPartyId: null, slot: null });
      const slots = await freshSlots(store, move, clock, party.id);
      party = await store.upsertDealParty({ ...party, offeredSlots: slots });
      events.push({ type: "deal.rescheduled", payload: { dealId: deal.id, partyId: party.id } });
      messages.push(
        {
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "reschedule",
          text: slots.length
            ? `No worries. Other times: ${slotList(slots)}. Which works?`
            : "No worries. When could you come instead?",
          facts: publicFacts(deal, p, { slots: slots.map((s) => s.label) }),
        },
        {
          to: "owner",
          dealId: deal.id,
          kind: "reschedule",
          text: `The ${who(p)} for the ${deal.title} needs a new ${p.meetNoun} time; I'm offering new slots.`,
          facts: { title: deal.title },
        },
      );
      return done();
    }

    case "slot": {
      const booked = await bookedSlots(store, move.id, party.id);
      if (!isFree(intent.slot, booked)) {
        const slots = await freshSlots(store, move, clock, party.id);
        party = await store.upsertDealParty({ ...party, offeredSlots: slots });
        messages.push({
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "slot_taken",
          text: slots.length
            ? `That one just got taken. How about ${slotList(slots)}?`
            : "That one just got taken. When else could you come?",
          facts: publicFacts(deal, p, { slots: slots.map((s) => s.label) }),
        });
        return done();
      }
      const cents = party.agreedCents ?? standing ?? 0;
      party = await store.upsertDealParty({
        ...party,
        status: "scheduled",
        slot: intent.slot,
        offeredSlots: [],
      });
      deal = await setState(store, deal, "scheduled", {
        winnerPartyId: party.id,
        slot: intent.slot,
        agreedCents: cents,
      });
      events.push({
        type: "deal.scheduled",
        payload: { dealId: deal.id, partyId: party.id, slot: intent.slot, cents },
      });
      events.push({
        type: "pickup.scheduled",
        payload: {
          dealId: deal.id,
          partyId: party.id,
          subjectId: deal.subjectId,
          title: deal.title,
          slot: intent.slot,
        },
      });
      const where = move.fromAddress
        ? ` Address: ${move.fromAddress}.`
        : " I'll text the address before then.";
      messages.push(
        {
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "booked",
          text: `Booked: ${intent.slot.label}.${where}${cents > 0 ? ` ${price(cents, p.unit)}, paid through Elves escrow.` : ""}`,
          facts: publicFacts(deal, p, {
            slot: intent.slot.label,
            address: move.fromAddress,
            agreedPrice: price(cents, p.unit),
          }),
        },
        {
          to: "owner",
          dealId: deal.id,
          kind: "booked",
          text: `Booked: ${who(p)} picks up the ${deal.title} ${intent.slot.label} for ${price(cents, p.unit)}. It comes off the truck estimate.`,
          facts: { title: deal.title, slot: intent.slot.label, agreedPrice: price(cents, p.unit) },
        },
      );
      return done();
    }

    case "accept": {
      if (party.status === "awaiting_owner") {
        messages.push(holdingMessage(deal, party));
        return done();
      }
      const r = await agree(store, move, deal, party, standing ?? 0, clock, "");
      return { ...r, events: [...events, ...r.events] };
    }

    case "offer": {
      const d = decide(p, terms(deal), position(party), intent.cents, { final: intent.final });
      if (d.kind === "accept") {
        const r = await agree(
          store,
          move,
          deal,
          { ...party, lastOfferCents: intent.cents },
          d.cents,
          clock,
          "",
        );
        return { ...r, events: [...events, ...r.events] };
      }
      if (d.kind === "counter") {
        party = await store.upsertDealParty({
          ...party,
          status: "talking",
          lastOfferCents: intent.cents,
          lastCounterCents: d.cents,
          rounds: party.rounds + 1,
        });
        events.push({
          type: "deal.countered",
          payload: { dealId: deal.id, partyId: party.id, offer: intent.cents, counter: d.cents },
        });
        messages.push({
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "counter",
          text: `I can do ${price(d.cents, p.unit)}.`,
          facts: publicFacts(deal, p, {
            theirOffer: price(intent.cents, p.unit),
            counter: price(d.cents, p.unit),
          }),
        });
        return done();
      }
      if (d.kind === "ask_owner") {
        const changed = party.status !== "awaiting_owner" || party.lastOfferCents !== intent.cents;
        party = await store.upsertDealParty({
          ...party,
          status: "awaiting_owner",
          lastOfferCents: intent.cents,
          lastCounterCents: d.hold,
          rounds: party.rounds + 1,
        });
        events.push({
          type: "deal.owner_asked",
          payload: { dealId: deal.id, partyId: party.id, offer: intent.cents, hold: d.hold },
        });
        messages.push(holdingMessage(deal, party));
        if (changed)
          messages.push({
            to: "owner",
            dealId: deal.id,
            kind: "ask",
            askFor: party.id,
            text: `A ${who(p)} offers ${price(intent.cents, p.unit)} for the ${deal.title} (your ${p.limitLabel} ${price(deal.limitCents, p.unit)}; I'm holding at ${price(d.hold, p.unit)}). Take ${price(intent.cents, p.unit)}? Reply yes, no, or a number.`,
            facts: {
              title: deal.title,
              offer: price(intent.cents, p.unit),
              limit: price(deal.limitCents, p.unit),
              holding: price(d.hold, p.unit),
              question: "take it? yes, no, or a number",
            },
          });
        return done();
      }
      return done();
    }

    case "ask": {
      const first = party.rounds === 0 && party.lastCounterCents == null && party.status === "talking";
      if (party.status === "agreed" && party.offeredSlots.length) {
        messages.push({
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "slots",
          text: `${cap(p.meetNoun)} times: ${slotList(party.offeredSlots)}. Which works?`,
          facts: publicFacts(deal, p, {
            agreedPrice: price(party.agreedCents, p.unit),
            slots: party.offeredSlots.map((s) => s.label),
          }),
        });
      } else if (party.status === "scheduled" && party.slot) {
        messages.push({
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "booked_reminder",
          text: `You're booked for ${party.slot.label}.${move.fromAddress ? ` Address: ${move.fromAddress}.` : ""}`,
          facts: publicFacts(deal, p, { slot: party.slot.label, address: move.fromAddress }),
        });
      } else if (party.status === "awaiting_owner") {
        messages.push(holdingMessage(deal, party));
      } else {
        const at = price(standing, p.unit);
        messages.push({
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: first ? "greet" : "info",
          text: first
            ? `Hi! The ${deal.title} is available${at === "free" ? " for free" : `, ${at}`}. Want it?`
            : `It's ${at === "free" ? "free" : at}. Want it?`,
          facts: publicFacts(deal, p, { price: at, firstMessage: first }),
        });
      }
      return done();
    }
  }
}

function holdingMessage(deal: Deal, party: DealParty): EngineMessage {
  return {
    to: "counterparty",
    partyId: party.id,
    dealId: deal.id,
    kind: "checking",
    text: "Let me check with the owner and get back to you.",
    facts: { title: deal.title, checkingWithOwner: true },
  };
}

/** Close an open deal with a terminal outcome and tag its item. */
export async function markOutcome(
  store: Store,
  dealId: string,
  outcome: "donated" | "dumped",
): Promise<Deal | null> {
  const deal = await store.getDeal(dealId);
  if (!deal) return null;
  if (!isOpen(deal.state) || !canTransition(deal.state, outcome)) return deal;
  const next = await setState(store, deal, outcome, { outcome, lastCallStage: "closed" });
  await tagSubject(store, next, outcome);
  return next;
}

/** Item outcome tag so the Move Report can count it. */
async function tagSubject(store: Store, deal: Deal, outcome: NonNullable<Deal["outcome"]>) {
  if (!deal.subjectId || (deal.mode !== "sell_item" && deal.mode !== "buy_item")) return;
  const item = (await store.listItems(deal.moveId)).find((i) => i.id === deal.subjectId);
  if (item)
    await store.upsertItem({
      id: item.id,
      moveId: item.moveId,
      name: item.name,
      category: item.category,
      outcome,
    });
}

// ---------------------------------------------------------------------------------------------------------------
// The owner answers an in-thread question

/** Parties waiting on the owner, across the move. */
export async function pendingOwnerAsks(
  store: Store,
  moveId: string,
): Promise<{ deal: Deal; party: DealParty }[]> {
  const out: { deal: Deal; party: DealParty }[] = [];
  for (const deal of await store.listDeals(moveId)) {
    if (!isOpen(deal.state)) continue;
    for (const party of await store.listDealParties(deal.id))
      if (party.status === "awaiting_owner") out.push({ deal, party });
  }
  return out;
}

/**
 * An owner text that answers a pending "take $X?". Matched by thread (the ask, or the deal's summary thread),
 * else when exactly one ask is pending. Null when the text is not such an answer.
 */
export async function ownerTurn(input: {
  store: Store;
  move: Move;
  text: string;
  parentMessageIds: string[];
  clock: EngineClock;
}): Promise<TurnResult | null> {
  const { store, move, text, clock } = input;
  const pending = await pendingOwnerAsks(store, move.id);
  if (!pending.length) return null;
  const parents = new Set(input.parentMessageIds);
  const threaded =
    pending.find((x) => x.party.ownerAskMessageId && parents.has(x.party.ownerAskMessageId)) ??
    (() => {
      const inThread = pending.filter((x) => x.deal.ownerThreadId && parents.has(x.deal.ownerThreadId));
      return inThread.length === 1 ? inThread[0] : undefined;
    })();
  // Unthreaded (the shared pool often has no threads), only a short answer with exactly one ask pending counts.
  const target = threaded ?? (pending.length === 1 && text.trim().length <= 60 ? pending[0] : undefined);
  if (!target) return null;
  const decision = readOwnerDecision(text);
  if (!decision) return null;

  let { deal, party } = target;
  const p = policyFor(deal.mode);
  const offer = party.lastOfferCents;
  const events: EngineEvent[] = [
    { type: "deal.owner_answered", payload: { dealId: deal.id, partyId: party.id, decision } },
  ];

  if (decision.kind === "yes" && offer != null) {
    party = await store.upsertDealParty({ ...party, ownerApprovedCents: offer });
    const r = await agree(store, move, deal, party, offer, clock, "Good news: the owner said yes. ");
    // The owner already knows; replace the engine's owner summary with a direct answer.
    const messages = r.messages.filter((m) => m.to !== "owner");
    messages.push({
      to: "owner",
      dealId: deal.id,
      kind: "owner_yes",
      text: `Done: ${price(offer, p.unit)} for the ${deal.title}. I'm setting up the ${p.meetNoun}.`,
      facts: { title: deal.title, agreedPrice: price(offer, p.unit) },
    });
    return { ...r, messages, events: [...events, ...r.events] };
  }

  if (decision.kind === "price") {
    const P = decision.cents;
    // The owner named a number at or past the buyer's offer: that is a yes to the buyer's offer.
    if (offer != null && p.dir * P <= p.dir * offer) {
      party = await store.upsertDealParty({ ...party, ownerApprovedCents: offer });
      const r = await agree(store, move, deal, party, offer, clock, "Good news: the owner said yes. ");
      const messages = r.messages.filter((m) => m.to !== "owner");
      messages.push({
        to: "owner",
        dealId: deal.id,
        kind: "owner_yes",
        text: `That's at or past their ${price(offer, p.unit)}, so I took it. Setting up the ${p.meetNoun}.`,
        facts: { title: deal.title, agreedPrice: price(offer, p.unit) },
      });
      return { ...r, messages, events: [...events, ...r.events] };
    }
    party = await store.upsertDealParty({
      ...party,
      status: "talking",
      ownerApprovedCents: P,
      lastCounterCents: P,
      ownerAskMessageId: null,
    });
    events.push({
      type: "deal.countered",
      payload: { dealId: deal.id, partyId: party.id, offer, counter: P, byOwner: true },
    });
    return {
      deal,
      party,
      events,
      messages: [
        {
          to: "counterparty",
          partyId: party.id,
          dealId: deal.id,
          kind: "counter",
          text: `I checked with the owner: ${price(P, p.unit)} is the best they can do.`,
          facts: publicFacts(deal, p, { counter: price(P, p.unit), checkedWithOwner: true }),
        },
        {
          to: "owner",
          dealId: deal.id,
          kind: "owner_counter",
          text: `Countered at ${price(P, p.unit)} for the ${deal.title}.`,
          facts: { title: deal.title, counter: price(P, p.unit) },
        },
      ],
    };
  }

  // No: hold where we stood.
  const hold = party.lastCounterCents ?? deal.limitCents ?? deal.askCents ?? 0;
  party = await store.upsertDealParty({ ...party, status: "talking", ownerAskMessageId: null });
  return {
    deal,
    party,
    events,
    messages: [
      {
        to: "counterparty",
        partyId: party.id,
        dealId: deal.id,
        kind: "owner_no",
        text: `I checked with the owner and can't go that low; ${price(hold, p.unit)} is the lowest.`,
        facts: publicFacts(deal, p, { lowest: price(hold, p.unit), checkedWithOwner: true }),
      },
      {
        to: "owner",
        dealId: deal.id,
        kind: "owner_no",
        text: `Got it. I told them ${price(hold, p.unit)} is the lowest for the ${deal.title}.`,
        facts: { title: deal.title, holding: price(hold, p.unit) },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Last Call: drop at T−48h, free at T−24h, donation or 311 at move-out

/** Hours before move-out at which each Last Call stage becomes due. */
export const LAST_CALL_HOURS = { drop: 48, free: 24, close: 0 } as const;

/** 60% of the ask, rounded to the dollar, and never under $1. */
export function droppedAsk(askCents: number): number {
  return Math.max(100, Math.round((askCents * 0.6) / 100) * 100);
}

const HOLD_ALL =
  /\b(no last call|skip last call|don'?t drop anything|do not drop anything|hold (?:all |the )?prices|not free)\b/i;
const HOLD = /\b(keep|hold|don'?t drop|do not drop)\b/i;

/**
 * "keep the couch", "don't drop the lamp", "no last call". Null when the text is not a hold.
 * `all` covers every open deal; otherwise `name` is the item to match.
 */
export function lastCallHold(text: string): { all: boolean; name: string | null } | null {
  if (!HOLD.test(text) && !HOLD_ALL.test(text)) return null;
  if (HOLD_ALL.test(text) && !/\bkeep\b/i.test(text)) return { all: true, name: null };
  const m = text
    .toLowerCase()
    .match(/\b(?:keep|hold|don'?t drop|do not drop)(?:\s+the)?\s+([a-z][a-z0-9 ]{1,40}?)(?:[.!?]+)?\s*$/);
  const name = m?.[1]?.replace(/\b(please|thanks|thank you)\b/g, "").trim() ?? "";
  if (!name || /^(it|them|this|that|price|prices)$/.test(name)) return { all: true, name: null };
  return { all: false, name };
}

/** Mark matching open deals so Last Call leaves their price alone. Null when `text` is not a hold. */
export async function holdLastCall(store: Store, moveId: string, text: string): Promise<Deal[] | null> {
  const intent = lastCallHold(text);
  if (!intent) return null;
  const open = (await store.listDeals(moveId)).filter(
    (d) => policyFor(d.mode).lastCall && isOpen(d.state) && !d.lastCallOptOut,
  );
  const hits = intent.all
    ? open
    : open.filter((d) => {
        const title = d.title.toLowerCase();
        const name = intent.name!;
        return title.includes(name) || name.includes(title);
      });
  const out: Deal[] = [];
  for (const d of hits) out.push(await store.upsertDeal({ ...d, lastCallOptOut: true }));
  return out;
}

export interface SweepMessage extends EngineMessage {
  moveId: string;
}

const ACTIVE_PARTY = ["talking", "awaiting_owner", "agreed", "waitlisted"];

/** The next Last Call stage this deal is due for, or null when it should sit. */
function dueLastCall(deal: Deal, hoursLeft: number): "drop" | "free" | "close" | null {
  if (deal.lastCallOptOut || deal.state === "scheduled" || deal.lastCallStage === "closed") return null;
  if (hoursLeft <= LAST_CALL_HOURS.close) return "close";
  if (hoursLeft <= LAST_CALL_HOURS.free && deal.lastCallStage !== "free") return "free";
  if (hoursLeft <= LAST_CALL_HOURS.drop && deal.lastCallStage === "none" && (deal.askCents ?? 0) > 0)
    return "drop";
  return null;
}

async function resetTalking(store: Store, deal: Deal): Promise<DealParty[]> {
  const active: DealParty[] = [];
  for (const party of await store.listDealParties(deal.id)) {
    if (!ACTIVE_PARTY.includes(party.status)) continue;
    active.push(
      await store.upsertDealParty({
        ...party,
        status: "talking",
        lastOfferCents: null,
        lastCounterCents: null,
        agreedCents: null,
        ownerApprovedCents: null,
        ownerAskMessageId: null,
        offeredSlots: [],
        slot: null,
        rounds: 0,
      }),
    );
  }
  return active;
}

async function syncSubjectPrice(store: Store, deal: Deal, askCents: number, limitCents: number) {
  if (!deal.subjectId || (deal.mode !== "sell_item" && deal.mode !== "buy_item")) return;
  const item = (await store.listItems(deal.moveId)).find((i) => i.id === deal.subjectId);
  if (!item) return;
  await store.upsertItem({
    id: item.id,
    moveId: item.moveId,
    name: item.name,
    category: item.category,
    listPriceCents: askCents,
    floorPriceCents: limitCents,
  });
}

export async function lastCallSweep(
  store: Store,
  clock: EngineClock,
): Promise<{ messages: SweepMessage[]; events: (EngineEvent & { moveId: string })[] }> {
  const tz = clock.tz ?? DEFAULT_TZ;
  const messages: SweepMessage[] = [];
  const events: (EngineEvent & { moveId: string })[] = [];
  const moves = new Map<string, Move | undefined>();
  for (const deal of await store.listOpenDeals()) {
    const p = policyFor(deal.mode);
    if (!p.lastCall) continue;
    if (!moves.has(deal.moveId)) moves.set(deal.moveId, await store.getMove(deal.moveId));
    const move = moves.get(deal.moveId);
    const out = moveOutInstant(move?.moveOutAt ?? null, tz);
    if (!move || !out) continue;
    const hoursLeft = (out.getTime() - clock.now.getTime()) / 3_600_000;
    const stage = dueLastCall(deal, hoursLeft);
    if (!stage) continue;

    if (stage === "drop") {
      const ask = droppedAsk(deal.askCents ?? 0);
      const limit = Math.min(deal.limitCents ?? ask, ask);
      const next = await store.upsertDeal({
        ...deal,
        askCents: ask,
        limitCents: limit,
        lastCallStage: "dropped",
      });
      await syncSubjectPrice(store, next, ask, limit);
      const parties = await resetTalking(store, next);
      events.push({
        moveId: move.id,
        type: "deal.price_dropped",
        payload: { dealId: deal.id, askCents: ask, limitCents: limit, reason: "last_call" },
      });
      const at = price(ask, p.unit);
      messages.push({
        moveId: move.id,
        to: "owner",
        dealId: deal.id,
        kind: "last_call_drop",
        text: `Last Call, 48 hours out: the ${deal.title} dropped to ${at}. Reply "keep the ${deal.title}" to hold that price.`,
        facts: { title: deal.title, price: at },
      });
      for (const party of parties) {
        messages.push({
          moveId: move.id,
          to: "counterparty",
          partyId: party.id,
          dealId: next.id,
          kind: "last_call_drop",
          text: `Price drop: the ${deal.title} is now ${at}. Want it?`,
          facts: publicFacts(next, p),
        });
      }
      continue;
    }

    if (stage === "free") {
      const relisted = await setState(store, deal, "relisted", {
        askCents: 0,
        limitCents: 0,
        lastCallStage: "free",
      });
      await syncSubjectPrice(store, relisted, 0, 0);
      const parties = await resetTalking(store, relisted);
      events.push({
        moveId: move.id,
        type: "deal.relisted",
        payload: { dealId: deal.id, reason: "last_call" },
      });
      events.push({
        moveId: move.id,
        type: "pickup.requested",
        payload: { dealId: deal.id, title: deal.title, kinds: ["donation", "311"] },
      });
      messages.push({
        moveId: move.id,
        to: "owner",
        dealId: deal.id,
        kind: "last_call",
        text: `Last Call, 24 hours out: the ${deal.title} is free now for anyone who can pick it up before move-out. I'm booking a donation or 311 pickup if nobody claims it.`,
        facts: { title: deal.title },
      });
      for (const party of parties) {
        messages.push({
          moveId: move.id,
          to: "counterparty",
          partyId: party.id,
          dealId: relisted.id,
          kind: "last_call",
          text: `Last Call: the ${deal.title} is free now if you can pick it up before move-out. Want it?`,
          facts: publicFacts(relisted, p),
        });
      }
      continue;
    }

    const closed = await setState(store, deal, "dumped", { lastCallStage: "closed", outcome: "dumped" });
    await tagSubject(store, closed, "dumped");
    events.push({ moveId: move.id, type: "deal.dumped", payload: { dealId: deal.id, reason: "last_call" } });
    if (deal.lastCallStage !== "free")
      events.push({
        moveId: move.id,
        type: "pickup.requested",
        payload: { dealId: deal.id, title: deal.title, kinds: ["donation", "311"] },
      });
    messages.push({
      moveId: move.id,
      to: "owner",
      dealId: deal.id,
      kind: "last_call_close",
      text: `Last Call: nobody claimed the ${deal.title}, so it's marked dumped and it stays off the truck.`,
      facts: { title: deal.title },
    });
    for (const party of await store.listDealParties(deal.id)) {
      if (!ACTIVE_PARTY.includes(party.status)) continue;
      await store.upsertDealParty({
        ...party,
        status: "walked",
        offeredSlots: [],
        slot: null,
        ownerAskMessageId: null,
      });
      messages.push({
        moveId: move.id,
        to: "counterparty",
        partyId: party.id,
        dealId: closed.id,
        kind: "last_call_close",
        text: `The ${deal.title} is gone. Thanks for looking.`,
        facts: { title: deal.title, gone: true },
      });
    }
  }
  return { messages, events };
}

// ---------------------------------------------------------------------------------------------------------------
// The Crew Board line

export async function dealBoard(
  store: Store,
  moveId: string,
  mode: DealMode | DealMode[] = "sell_item",
): Promise<string | null> {
  const modes = Array.isArray(mode) ? mode : [mode];
  const deals = (await store.listDeals(moveId)).filter((d) => modes.includes(d.mode));
  if (!deals.length) return null;
  const parts: string[] = [];
  for (const d of deals) {
    const parties = await store.listDealParties(d.id);
    const active = parties.filter((x) =>
      ["talking", "agreed", "awaiting_owner", "waitlisted"].includes(x.status),
    ).length;
    const label =
      d.state === "scheduled" && d.slot
        ? `booked ${d.slot.label}`
        : d.state === "handed_off" || d.state === "paid"
          ? (d.outcome ?? d.state)
          : d.state === "relisted"
            ? "free (Last Call)"
            : d.lastCallStage === "dropped"
              ? `dropped to ${price(d.askCents, policyFor(d.mode).unit)}`
              : active
                ? `${active} ${policyFor(d.mode).counterpartyRole}${active === 1 ? "" : "s"}`
                : d.state;
    parts.push(`${d.title}: ${label}`);
  }
  return parts.join(" · ");
}
