import type { Item } from "@elves/shared";

/**
 * The seam between the Stuff Elf (owner side: intake, floors, approval, Last Call, outcomes) and the Deal Engine
 * (buyer side: negotiation, slots, hand-off), which is built in its own package and merged in later.
 *
 * The Stuff Elf calls these at each owner-side change, and appends the matching event either way, so the engine
 * can integrate by implementing this interface or by reading the event log:
 *
 * | Hook              | Event                  | When                                                         |
 * | ----------------- | ---------------------- | ------------------------------------------------------------ |
 * | listingApproved   | listing.approved       | the owner said yes to listing one item                       |
 * | priceChanged      | item.price_changed     | Last Call dropped the ask, or relisted the item free (ask 0) |
 * | itemWithdrawn     | item.withdrawn         | no longer for sale: kept, donating, sold elsewhere, dumped   |
 *
 * Rules the engine can rely on: `floorPriceCents` is the owner's line and is never lowered by the Stuff Elf;
 * `listPriceCents === 0` with `intent === "give"` means free, and the floor no longer applies.
 * The engine reports a finished hand-off back by setting the item's outcome (see `recordOutcome` in stuff-actions.ts).
 */
export interface DealHooks {
  /** Open a sell deal for this item. May return the buyer-facing code to include in the owner's reply. */
  listingApproved(item: Item): Promise<{ code?: string } | undefined>;
  priceChanged(item: Item, reason: "last_call_drop" | "free"): Promise<void>;
  itemWithdrawn(
    item: Item,
    reason: "kept" | "donating" | "giving" | "sold_elsewhere" | "dumped" | "handed_off",
  ): Promise<void>;
}

/** Used until the Deal Engine is merged: the events still land, nothing else happens. */
export const noDealHooks: DealHooks = {
  async listingApproved() {
    return undefined;
  },
  async priceChanged() {},
  async itemWithdrawn() {},
};
