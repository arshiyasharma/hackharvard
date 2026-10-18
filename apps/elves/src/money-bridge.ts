import { policyFor } from "@elves/engine";
import type { ElfOutbound } from "@elves/elves";
import {
  approvalPollFor,
  boardLine,
  formatLines,
  formatOutbound,
  type MoneyMove,
  type MoneyService,
  type OpResult,
  ledgerTotals,
} from "@elves/money-elf";
import type { Deal, DealParty, Move, Store } from "@elves/shared";

/**
 * Where the Stuff and Home Elves' sales meet the Money Elf. The Deal Engine already says what happened as events
 * (`ledger.hold` when a price is agreed, `pickup.scheduled`, `ledger.release` when the counterparty confirms the
 * hand-off, `ledger.refund` when they walk); this turns each into the Money Elf's own flow, all of it behind the
 * owner's yes and all of it recorded in Nessie:
 *
 *   agreed price, counterparty pays the owner (a sale, a sublet applicant)
 *     → "Hold their $60 in escrow until pickup? Reply yes."  → yes opens escrow in Nessie
 *   pickup booked                  → the escrow's pickup time (the 24h no-show rule)
 *   counterparty confirms hand-off → the owner is asked to release escrow into the Moving Fund
 *   counterparty walks             → a question still waiting is dropped; money in escrow gets a refund question
 *   agreed price, owner pays (buying an item, renting a place)
 *     → at hand-off, "Pay them $X? Reply yes."
 *
 * The Money Elf never texts anyone itself; this returns the notes and the service sends them.
 */

type Ev = { type: string; payload: Record<string, unknown> };

export interface BridgeResult {
  notes: ElfOutbound[];
  events: Ev[];
}

const none = (): BridgeResult => ({ notes: [], events: [] });
const last4 = (h: string) => h.replace(/\D/g, "").slice(-4);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Buyer …0199": a counterparty known only by their number. */
export function counterpartyLabel(deal: Deal, party: DealParty): string {
  return `${cap(policyFor(deal.mode).counterpartyRole)} …${last4(party.handle)}`;
}

/** What the sale is called in the Ledger. A sublet's agreed rent is the first month, held until the keys change hands. */
export function itemLabel(deal: Deal): string {
  return deal.mode === "sublet_out" ? `${deal.title} (first month)` : deal.title;
}

export function createMoneyBridge(deps: { store: Store; service: MoneyService; now?: () => Date }) {
  const { store, service } = deps;

  const moneyMove = (move: Move): MoneyMove => ({
    id: move.id,
    ownerHandle: move.ownerHandle,
    name: null,
    ownerSpaceId: move.ownerSpaceId,
  });

  /** Money's outbound texts addressed to the crew's spaces; a handle with no space yet is left out. */
  async function toNotes(move: Move, r: OpResult): Promise<ElfOutbound[]> {
    const people = await store.listParticipants(move.id);
    const notes: ElfOutbound[] = [];
    for (const o of r.outbound) {
      const spaceId =
        o.toHandle === move.ownerHandle
          ? move.ownerSpaceId
          : people.find((p) => p.handle === o.toHandle)?.spaceId;
      if (!spaceId) continue;
      notes.push({ spaceId, text: formatOutbound(o.text), elf: "money", ...(o.poll ? { poll: o.poll } : {}) });
    }
    return notes;
  }

  /** The owner's question, with a Yes / Not now poll for the most recent waiting action. */
  async function ask(move: Move, lines: string[]): Promise<ElfOutbound[]> {
    const pending = await service.latestPending(move.id);
    return [
      {
        spaceId: move.ownerSpaceId,
        text: formatLines(lines),
        elf: "money",
        ...(pending ? { poll: approvalPollFor(pending) } : {}),
      },
    ];
  }

  /** Keep the Money row on the Crew Board (and so STATUS) current: the Ledger's totals in one line. */
  async function refreshBoard(move: Move): Promise<void> {
    const mm = moneyMove(move);
    const owner = await service.owner(mm);
    const totals = ledgerTotals(await service.store.listEntries(move.id), owner.id);
    const waiting = (await service.store.listPending(move.id)).length;
    // Same shape the Money Elf's own replies write: the Ledger's totals as the last update (STATUS reads it).
    await store.patchBoard(move.id, "money", {
      status: waiting ? "waiting" : "working",
      currentTask: "Keeping the Ledger",
      lastUpdate: boardLine(totals),
    });
  }

  async function onEvent(move: Move, ev: Ev): Promise<BridgeResult> {
    const mm = moneyMove(move);
    const dealId = String(ev.payload.dealId ?? "");
    const partyId = String(ev.payload.partyId ?? "");
    if (!dealId || !partyId) return none();
    const deal = await store.getDeal(dealId);
    const party = (await store.listDealParties(dealId)).find((p) => p.id === partyId);
    if (!deal || !party) return none();
    const ownerReceives = policyFor(deal.mode).dir === 1;
    const label = counterpartyLabel(deal, party);
    const cents = Number(ev.payload.cents ?? deal.agreedCents ?? 0);

    switch (ev.type) {
      case "ledger.hold": {
        if (!ownerReceives || cents <= 0) return none();
        const r = await service.proposeOpenEscrow(mm, {
          item: itemLabel(deal),
          buyerName: label,
          buyerHandle: party.handle,
          amountCents: cents,
          dealId,
          partyId,
          pickupAt: deal.slot?.start ?? null,
        });
        return { notes: await ask(move, r.lines), events: r.events };
      }
      case "pickup.scheduled": {
        const slot = ev.payload.slot as { start?: string } | undefined;
        if (slot?.start) await service.pickupScheduled(mm, dealId, partyId, slot.start);
        return none();
      }
      case "ledger.release": {
        if (ownerReceives) {
          const held = await service.heldForDeal(move.id, dealId, partyId);
          if (!held) return none();
          const r = await service.confirmPickup(mm, { via: "engine", entryId: held.id });
          return { notes: await toNotes(move, r), events: r.events };
        }
        // The owner paid for something (an item bought, a place rented): a payment waits for their yes.
        if (cents <= 0) return none();
        const r = await service.proposePay(mm, {
          person: label,
          role: policyFor(deal.mode).counterpartyRole,
          amountCents: cents,
          what: deal.title,
          flagged: false,
        });
        return { notes: await ask(move, r.lines), events: r.events };
      }
      case "ledger.refund": {
        if (!ownerReceives) return none();
        if (await service.dropOpenEscrow(move.id, dealId, partyId)) return none();
        const held = await service.heldForDeal(move.id, dealId, partyId);
        if (!held) return none();
        const r = await service.proposeEscrow(mm, "refund_escrow", held.what);
        return { notes: await ask(move, r.lines), events: r.events };
      }
      default:
        return none();
    }
  }

  return {
    /** Turn one batch's Deal Engine events into the Money Elf's questions and records. */
    async onEvents(move: Move, events: Ev[]): Promise<BridgeResult> {
      const out = none();
      let touched = false;
      for (const ev of events) {
        if (!["ledger.hold", "pickup.scheduled", "ledger.release", "ledger.refund"].includes(ev.type))
          continue;
        touched = true;
        const r = await onEvent(move, ev);
        out.notes.push(...r.notes);
        out.events.push(...r.events);
      }
      if (touched) await refreshBoard(move);
      return out;
    },

    /** The periodic sweep: a buyer 24h past the pickup time without confirming gets a refund question. */
    async sweep(): Promise<{ move: Move; result: BridgeResult }[]> {
      const out: { move: Move; result: BridgeResult }[] = [];
      for (const move of await store.listMoves()) {
        const held = (await service.store.listEntries(move.id)).some(
          (e) => e.kind === "sale" && e.escrow === "held",
        );
        if (!held) continue;
        const r = await service.sweepNoShows(moneyMove(move));
        if (!r.outbound.length && !r.events.length) continue;
        out.push({ move, result: { notes: await toNotes(move, r), events: r.events } });
        await refreshBoard(move);
      }
      return out;
    },

    refreshBoard,
  };
}
