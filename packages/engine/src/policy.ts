import type { DealMode, ElfName, ItemOutcome, Role } from "@elves/shared";
import { BUYER, SELLER, type Voice } from "./voice.ts";

/**
 * What changes between the four modes. Everything else (the state machine, negotiation, scheduling, Scam Shield,
 * Last Call) is the same code reading these fields.
 */
export interface ModePolicy {
  mode: DealMode;
  /** +1 when a higher price is better for the owner (selling, renting out); -1 when lower is (buying, renting). */
  dir: 1 | -1;
  /** Who texts in. */
  counterpartyRole: Role;
  /** The Elf that owns these deals and their threads. */
  elf: ElfName;
  /** "couch", "room": what the counterparty is told is on the table. */
  noun: string;
  /** What the owner's line is called in owner-facing summaries. */
  limitLabel: string;
  unit: "each" | "month";
  /** What has to happen before the deal counts as handed off. */
  handoffEvidence: string;
  /** What the hand-off is called in texts: "pickup", "viewing", "key hand-off". */
  meetNoun: string;
  /** Item outcome when the hand-off closes the deal at a price / for free. */
  outcomeSold: ItemOutcome;
  outcomeFree: ItemOutcome;
  /** Fraction of the gap we give up per counter. */
  concession: number;
  /** Counters before we meet any offer inside the limit. */
  maxRounds: number;
  /** Does Last Call apply (anything we are getting rid of before move-out)? */
  lastCall: boolean;
  /** A time the counterparty picks is put to the owner before it is booked (viewings), not booked on the spot. */
  ownerConfirmsSlot: boolean;
  /** The phrases for this side of the table: SELLER when a stranger texts in about ours, BUYER when we want theirs. */
  voice: Voice;
}

export const POLICIES: Record<DealMode, ModePolicy> = {
  sell_item: {
    mode: "sell_item",
    dir: 1,
    counterpartyRole: "buyer",
    elf: "stuff",
    noun: "item",
    limitLabel: "floor",
    unit: "each",
    handoffEvidence: "buyer confirms pickup in their DM",
    meetNoun: "pickup",
    outcomeSold: "sold",
    outcomeFree: "given",
    concession: 0.5,
    maxRounds: 2,
    lastCall: true,
    ownerConfirmsSlot: false,
    voice: SELLER,
  },
  buy_item: {
    mode: "buy_item",
    dir: -1,
    counterpartyRole: "seller",
    elf: "stuff",
    noun: "item",
    limitLabel: "max",
    unit: "each",
    handoffEvidence: "seller confirms and the owner tapbacks received",
    meetNoun: "pickup",
    outcomeSold: "sold",
    outcomeFree: "given",
    concession: 0.5,
    maxRounds: 2,
    lastCall: false,
    ownerConfirmsSlot: false,
    // Still the original copy; BUYER fits this mode too and is a one-word change once its flow is reviewed.
    voice: SELLER,
  },
  sublet_out: {
    mode: "sublet_out",
    dir: 1,
    counterpartyRole: "applicant",
    elf: "home",
    noun: "room",
    limitLabel: "minimum rent",
    unit: "month",
    handoffEvidence: "both accept the agreement and keys are handed over",
    meetNoun: "viewing",
    outcomeSold: "sold",
    outcomeFree: "given",
    concession: 0.34,
    maxRounds: 2,
    lastCall: false,
    ownerConfirmsSlot: true,
    voice: SELLER,
  },
  find_sublet: {
    mode: "find_sublet",
    dir: -1,
    counterpartyRole: "lister",
    elf: "home",
    noun: "place",
    limitLabel: "max rent",
    unit: "month",
    handoffEvidence: "Lease Elf reviews the terms; deposit only through escrow",
    meetNoun: "viewing",
    outcomeSold: "sold",
    outcomeFree: "given",
    concession: 0.34,
    maxRounds: 2,
    lastCall: false,
    ownerConfirmsSlot: true,
    voice: BUYER,
  },
};

export function policyFor(mode: DealMode): ModePolicy {
  return POLICIES[mode];
}
