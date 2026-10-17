import type { Item, ItemOutcome, Store } from "@elves/shared";
import { z } from "zod";
import type { DealHooks } from "./deal-hooks.ts";
import { findItemByText } from "./intake.ts";

/** What the owner wants done with existing items, outside of selling. */
export type StuffAction =
  | { kind: "donate" | "give" | "keep"; targets: "named" | "rest"; names: string[] }
  | { kind: "gone"; outcome: Exclude<ItemOutcome, "listed" | "kept"> | "picked_up"; names: string[] }
  | { kind: "report" }
  | { kind: "status" };

const REST =
  /\b(the rest|everything else|all the rest|whatever(?:'s| is) left|anything left|all of it|everything)\b/i;
const NAMED_TAIL =
  /\b(?:the|my|our|that|this)?\s*([a-z][a-z' -]{1,40}?)(?:[.,!?]|$| and | too| please| for free| away)/i;

/**
 * Deterministic parse of owner phrasings; null when nothing matches (the caller may ask the model).
 * "donate the rest", "give away the lamp", "can the desk go on the curb", "keep the bed",
 * "sold the couch myself", "the lamp got picked up", "donated the chair", "tossed the mattress", "report".
 */
export function parseStuffAction(text: string): StuffAction | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  if (
    /\b(move report|report|how did we do|how much (?:did we|have we) (?:save|divert)|impact|landfill)\b/.test(
      t,
    )
  )
    return { kind: "report" };
  if (/\b(what'?s left|what is left|last call|what hasn'?t sold|unsold)\b/.test(t)) return { kind: "status" };

  // A question ("when does the couch get picked up?") is not a report that it happened.
  const question = /\?\s*$/.test(t) || /^(when|can|could|will|would|should|is|are|does|do|how)\b/.test(t);
  const gone: [RegExp, Exclude<ItemOutcome, "listed" | "kept"> | "picked_up"][] = [
    [/\b(sold (?:it |the |my )?|someone bought)\b/, "sold"],
    [/\b(donated|dropped (?:it )?off at)\b/, "donated"],
    [/\b(gave (?:it )?away|gave the|gave my|someone took)\b/, "given"],
    [/\b(tossed|trashed|threw (?:it |the )?(?:out|away)|dumped|put (?:it )?on the curb)\b/, "dumped"],
    [/\b(picked up|got picked up|came and got|was collected|is gone|are gone)\b/, "picked_up"],
  ];
  if (!question)
    for (const [re, outcome] of gone) if (re.test(t)) return { kind: "gone", outcome, names: [t] };

  const want: [RegExp, "donate" | "give" | "keep"][] = [
    [/\b(donate|donating|donation)\b/, "donate"],
    [
      /\b(give away|giving away|give it away|for free|free to|go on the curb|curb it|put on the curb|leave on the curb)\b/,
      "give",
    ],
    [/\b(keep|keeping|taking (?:it|the|my) with|bring(?:ing)? (?:it|the|my) with|not selling)\b/, "keep"],
  ];
  for (const [re, kind] of want) {
    if (re.test(t)) return { kind, targets: REST.test(t) ? "rest" : "named", names: [t] };
  }
  return null;
}

/** Model fallback for phrasings the regex misses; only used when the batch looked like a Stuff action. */
export const StuffActionSchema = z.object({
  action: z.enum([
    "donate",
    "give",
    "keep",
    "sold",
    "donated",
    "given",
    "dumped",
    "picked_up",
    "report",
    "status",
    "none",
  ]),
  itemNames: z
    .array(z.string())
    .describe("items the owner refers to, in their words; empty when they mean all the rest"),
  allTheRest: z.boolean(),
});

export function fromModel(r: z.infer<typeof StuffActionSchema>): StuffAction | null {
  const names = r.itemNames.length ? r.itemNames : [];
  switch (r.action) {
    case "donate":
    case "give":
    case "keep":
      return { kind: r.action, targets: r.allTheRest ? "rest" : "named", names };
    case "sold":
    case "donated":
    case "given":
    case "dumped":
    case "picked_up":
      return { kind: "gone", outcome: r.action, names };
    case "report":
      return { kind: "report" };
    case "status":
      return { kind: "status" };
    default:
      return null;
  }
}

/** Items still in play: no outcome yet. */
export function openItems(items: Item[]): Item[] {
  return items.filter((i) => i.outcome === "listed" && i.intent !== "buy");
}

/** The items an action refers to: every item named in any of `names`, or all open items for "the rest". */
export function resolveTargets(items: Item[], names: string[], rest: boolean): Item[] {
  const open = openItems(items);
  if (rest) return open.filter((i) => i.intent !== "keep");
  const out: Item[] = [];
  for (const n of names) {
    // A phrase can name several items ("the lamp and the chair"): match each item against the phrase.
    for (const it of open) {
      if (out.includes(it)) continue;
      if (findItemByText(n, [it])) out.push(it);
    }
  }
  if (!out.length && names.length) {
    const tail = names[0]?.match(NAMED_TAIL)?.[1];
    if (tail) {
      const hit = findItemByText(tail, open);
      if (hit) out.push(hit);
    }
  }
  return out;
}

/** Map "picked up" to the outcome the item's intent implies. */
export function outcomeFor(
  item: Item,
  said: Exclude<ItemOutcome, "listed" | "kept"> | "picked_up",
): ItemOutcome {
  if (said !== "picked_up") return said;
  if (item.intent === "donate") return "donated";
  if (item.intent === "give" || item.listPriceCents === 0) return "given";
  return "sold";
}

export interface Changed {
  item: Item;
  events: { type: string; payload: Record<string, unknown> }[];
}

/**
 * Record a final outcome on an item. Used by the Stuff Elf, Last Call and, after the merge, the Deal Engine
 * when a hand-off completes. Anything that leaves (sold, given, donated, dumped) is dropped from the truck.
 */
export async function recordOutcome(
  store: Store,
  item: Item,
  outcome: ItemOutcome,
  now: Date,
  extra: Record<string, unknown> = {},
): Promise<Changed> {
  const leaves = outcome !== "kept" && outcome !== "listed";
  const next = await store.upsertItem({
    id: item.id,
    moveId: item.moveId,
    name: item.name,
    category: item.category,
    outcome,
    outcomeAt: now.toISOString(),
    leavesBeforeMoveDay: leaves,
    ...(outcome === "kept" ? { intent: "keep" as const, listingApproved: false } : {}),
  });
  const events: Changed["events"] = [
    {
      type: "item.outcome",
      payload: { itemId: item.id, name: item.name, outcome, weightLb: item.weightLb, ...extra },
    },
  ];
  if (leaves)
    events.push({
      type: "item.leaving",
      payload: { itemId: item.id, name: item.name, weightLb: item.weightLb, at: now.toISOString(), outcome },
    });
  return { item: next, events };
}

/** Apply a donate / give / keep decision to one item; tells the Deal Engine when a live listing changes. */
export async function applyIntent(
  store: Store,
  deals: DealHooks,
  item: Item,
  kind: "donate" | "give" | "keep",
  now: Date,
): Promise<Changed> {
  const base = { id: item.id, moveId: item.moveId, name: item.name, category: item.category };
  if (kind === "keep") {
    const res = await recordOutcome(store, item, "kept", now);
    if (item.listingApproved) await deals.itemWithdrawn(res.item, "kept");
    return res;
  }
  if (kind === "donate") {
    const next = await store.upsertItem({ ...base, intent: "donate", listingApproved: false });
    if (item.listingApproved) await deals.itemWithdrawn(next, "donating");
    return {
      item: next,
      events: [{ type: "item.intent_set", payload: { itemId: item.id, name: item.name, intent: "donate" } }],
    };
  }
  const next = await store.upsertItem({ ...base, intent: "give", listPriceCents: 0, listingApproved: true });
  if (item.listingApproved) await deals.priceChanged(next, "free");
  else await deals.listingApproved(next);
  return {
    item: next,
    events: [
      { type: "item.intent_set", payload: { itemId: item.id, name: item.name, intent: "give" } },
      {
        type: "item.price_changed",
        payload: { itemId: item.id, name: item.name, listPriceCents: 0, reason: "free" },
      },
    ],
  };
}
