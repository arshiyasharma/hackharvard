import type { Category } from "./facts.ts";

/**
 * Where things go when they don't sell, in Boston. Drafts only: the crew never books on the owner's behalf.
 * Names only, no phone numbers or links until someone checks them (see docs/stuff-elf-plan.md, M6).
 */
export interface PickupOption {
  org: string;
  how: string;
}

const MATTRESS: PickupOption = {
  org: "Boston 311 mattress pickup",
  how: "Boston requires a scheduled pickup for mattresses: request one with BOS:311 (call 311 or use the app)",
};
const BULK: PickupOption = {
  org: "Boston 311 bulk item pickup",
  how: "request a bulk item pickup with BOS:311 for your trash day",
};
const FURNITURE_DONATION: PickupOption = {
  org: "Habitat for Humanity ReStore",
  how: "takes furniture in good shape; ask about pickup for large pieces",
};
const SMALL_DONATION: PickupOption = {
  org: "Goodwill or Big Brother Big Sister Foundation",
  how: "drop off small household items, or schedule a free pickup",
};

/** The best donation or pickup route for an item, by category and condition. */
export function pickupFor(category: string, condition: string | null): PickupOption {
  const c = category as Category;
  if (c === "mattress") return MATTRESS;
  if (condition === "worn") return BULK;
  if (c === "small") return SMALL_DONATION;
  return FURNITURE_DONATION;
}

/** Items that need a drafted pickup at Last Call's free stage, rather than waiting for a claimer. */
export function needsPickupDraft(category: string, weightLb: number): boolean {
  return category === "mattress" || weightLb > 60;
}
