import type { Item, Move } from "@elves/shared";
import { formatDate } from "./facts.ts";
import { NEIGHBORHOODS } from "./home-facts.ts";

/**
 * Donating and hauling away. The Elf takes the listing off and drafts the request the owner sends; it places no
 * call and books nothing. Every contact below is plain data, so a wrong number is a one-line fix here.
 */

/** "donate the couch", "give the lamp away", "put it out for 311". Questions are not commands. */
const DONATE_VERB =
  /\b(donat(?:e|ing)|give (?:it|them|that|the [a-z ]{2,30}) away|give away|goodwill|salvation army|habitat restore|311|bulk pickup|curb(?:side)?|dump|trash|haul(?: it)? away)\b/i;
const QUESTION_LEAD =
  /^\s*(?:how|what|when|where|why|is|are|does|will|should)\b|^\s*(?:can|could|would|do)\s+(?!you\b)/i;
const POLITE_ASK = /\b(?:can|could|would|will) you\b/i;

export function isDonateCommand(text: string): boolean {
  if (!DONATE_VERB.test(text) || QUESTION_LEAD.test(text)) return false;
  return !text.includes("?") || POLITE_ASK.test(text);
}

export interface PickupOption {
  name: string;
  how: string;
}

/** The City of Boston proper, whose 311 handles bulk pickup. Cambridge, Somerville and the rest are not Boston. */
const BOSTON =
  /\b(boston|allston|brighton|fenway|kenmore|back bay|south end|north end|beacon hill|seaport|chinatown|mission hill|dorchester|roxbury|jamaica plain|charlestown|east boston|eastie|south boston|southie|mattapan|roslindale|west roxbury|hyde park)\b/i;

/**
 * The city the owner means, from an address or a short reply ("allston", "I'm in Somerville"). A neighborhood
 * of Boston is "Boston, MA"; another town in the metro keeps its own name, because Boston 311 does not serve it.
 * Null when unclear.
 */
export function areaFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const [town, hood] of Object.entries(NEIGHBORHOODS))
    if (!BOSTON.test(town) && hood.aliases.some((a) => t.includes(a))) return town;
  return BOSTON.test(text) ? "Boston, MA" : null;
}

/** A short answer to "what city or neighborhood?": "somerville", "I'm in Quincy." */
export function areaAnswer(text: string): string | null {
  const known = areaFrom(text);
  if (known) return known;
  const cleaned = text
    .trim()
    .replace(/^(?:it'?s |its |i'?m |we'?re |the pickup is |pickup is )?(?:in |at |near )?/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (!cleaned || cleaned.length > 40 || /\d{3,}/.test(cleaned)) return null;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function pickupOptions(area: string): PickupOption[] {
  const boston = area.toLowerCase().startsWith("boston");
  return [
    boston
      ? {
          name: "Boston 311 bulk pickup",
          how: "call 311 (617-635-4500) or use boston.gov/311, best for anything nobody wants",
        }
      : {
          name: `${area} bulk pickup`,
          how: `search "${area} bulk item pickup"; it is usually 311 or the public works site`,
        },
    {
      name: "Salvation Army",
      how: "1-800-SA-TRUCK or satruck.org, furniture pickup if it is in decent shape",
    },
    { name: "Goodwill", how: "goodwill.org/donate finds the nearest drop-off" },
    {
      name: "Habitat ReStore",
      how: "habitat.org/restores finds one near you that takes furniture and does pickups",
    },
  ];
}

/** "a couch", "an armchair and a lamp", "the couch, the lamp and the desk". */
export function nameList(items: Pick<Item, "name">[], article: "a" | "the" = "a"): string {
  const names = items.map(
    (i) => `${article === "the" ? "the" : /^[aeiou]/i.test(i.name) ? "an" : "a"} ${i.name}`,
  );
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/** The message the owner can forward as it is. */
export function requestDraft(items: Item[], move: Move, area: string): string {
  const where = move.fromAddress ? `${move.fromAddress}, ${area}` : area;
  const by = move.moveOutAt ? ` before ${formatDate(move.moveOutAt)}` : " before I move out";
  const condition = items.length === 1 ? items[0]?.condition : null;
  const shape = condition ? ` It's in ${condition.toLowerCase().replace(/\.$/, "")} condition.` : "";
  return [
    `Hi, I'm moving out of ${where}${move.moveOutAt ? ` on ${formatDate(move.moveOutAt)}` : ""} and would like to donate ${nameList(items)}.${shape}`,
    `Can you pick ${items.length === 1 ? "it" : "them"} up${by}? I can have ${items.length === 1 ? "it" : "them"} by the door or curb. What do you need from me to book it?`,
  ].join(" ");
}

/** What the owner is being asked, kept in events so the router can send the answer back to the Stuff Elf. */
export type DonateAsk = { step: "item" | "area"; itemIds: string[] };

/** The donate question still waiting on the owner: the last `donate.pending` not followed by `donate.drafted`. */
export function pendingDonateAsk(
  events: { type: string; payload: Record<string, unknown> }[],
): DonateAsk | null {
  let ask: DonateAsk | null = null;
  for (const e of events) {
    if (e.type === "donate.pending") {
      const ids = e.payload.itemIds;
      ask = {
        step: e.payload.step === "area" ? "area" : "item",
        itemIds: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [],
      };
    } else if (e.type === "donate.drafted") ask = null;
  }
  return ask;
}
