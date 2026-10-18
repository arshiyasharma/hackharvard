import type { Deal, ElfName, Move, Store } from "@elves/shared";

/**
 * How the Elves depend on each other. Three carriers exist, and every relationship below names its carrier:
 * - the Move row (dates, addresses): one Elf writes it with `movePatch`, every Elf reads it as `ctx.move`;
 * - the store (items, deals, listings, checklist): one Elf writes, another reads it in its turn;
 * - events: an Elf emits, another reads `store.listEvents` (the Ledger lines, Last Call, the status report).
 * `callElf` (registry.ts) is the fourth: one Elf runs another on the same batch, in the same turn.
 * The README renders this table; keep it true.
 */
export interface ElfRelation {
  from: ElfName;
  to: ElfName;
  what: string;
  carrier: string;
  /** Where in the code the receiving side reads it. */
  readBy: string;
}

export const ELF_RELATIONS: ElfRelation[] = [
  {
    from: "crew_lead",
    to: "stuff",
    what: "Items the owner names and photographs, the move-out date Last Call counts down to, listing approvals",
    carrier: "store items + move.moveOutAt + events item.captured / listing.approved",
    readBy: "sell.ts (items, floors), engine lastCallSweep (moveOutAt)",
  },
  {
    from: "crew_lead",
    to: "home",
    what: "The confirmed brief: needs a place and what, sublet out, move-in needs, dates and addresses",
    carrier: "board row from dispatchBrief + move dates/addresses + working memory",
    readBy: "home.ts (ctx.move, memoryPreamble)",
  },
  {
    from: "crew_lead",
    to: "stuff",
    what: "One text that asks for both Elves' work is handed to each in turn",
    carrier: 'callElves(ctx, ["stuff", "home"]) on the same batch',
    readBy: "crew-lead.ts handle → registry.ts",
  },
  {
    from: "stuff",
    to: "home",
    what: "Booked pickups, so the move checklist and status show when buyers come",
    carrier: "sell_item deals in state scheduled with a slot (engine)",
    readBy: "relations.ts bookedPickups → home-movein.ts formatChecklist, status.ts",
  },
  {
    from: "stuff",
    to: "home",
    what: "What was sold, given, donated or dumped, for the status paragraph and the Move Report line",
    carrier: "item.outcome on store items + impact.ts moveReport",
    readBy: "status.ts",
  },
  {
    from: "home",
    to: "stuff",
    what: "The move-in date and new address once the checklist captures them, so Stuff's board and Last Call lines name real dates",
    carrier: "movePatch moveInAt / toAddress → ctx.move",
    readBy: "crew-lead.ts, sell.ts (ctx.move)",
  },
  {
    from: "home",
    to: "money",
    what: "An agreed sublet and its rent, for the contract and deposit escrow",
    carrier: "events deal.agreed + ledger.hold (sublet_out)",
    readBy: "not read yet: Money is a stub",
  },
  {
    from: "stuff",
    to: "money",
    what: "Escrow holds, releases and refunds on each sale",
    carrier: "events ledger.hold / ledger.release / ledger.refund / escrow.requested",
    readBy: "status.ts (ledger line); Money itself is a stub",
  },
];

/** Stuff → Home: every buyer pickup on the calendar, as "couch Fri 6pm". */
export async function bookedPickups(store: Store, move: Pick<Move, "id">): Promise<string[]> {
  const deals: Deal[] = await store.listDeals(move.id);
  return deals.flatMap((d) =>
    d.mode === "sell_item" && d.state === "scheduled" && d.slot ? [`${d.title} ${d.slot.label}`] : [],
  );
}
