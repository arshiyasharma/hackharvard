import { nightsBetween } from "@elves/listings";
import {
  type HousingSearch,
  LISTING_KINDS,
  type ListingKind,
  type ListingQuery,
  type Move,
} from "@elves/shared";
import { z } from "zod";
import { parseDateRange } from "./facts.ts";

/** Boston-area places the owner might name, with the words they use for them. */
export const NEIGHBORHOODS: Record<string, { city: string; aliases: string[] }> = {
  Allston: { city: "Boston, MA", aliases: ["allston"] },
  Brighton: { city: "Boston, MA", aliases: ["brighton"] },
  Fenway: { city: "Boston, MA", aliases: ["fenway", "kenmore"] },
  "Back Bay": { city: "Boston, MA", aliases: ["back bay"] },
  "South End": { city: "Boston, MA", aliases: ["south end"] },
  "North End": { city: "Boston, MA", aliases: ["north end"] },
  "Beacon Hill": { city: "Boston, MA", aliases: ["beacon hill"] },
  Seaport: { city: "Boston, MA", aliases: ["seaport"] },
  Chinatown: { city: "Boston, MA", aliases: ["chinatown"] },
  "Jamaica Plain": { city: "Boston, MA", aliases: ["jamaica plain"] },
  "Mission Hill": { city: "Boston, MA", aliases: ["mission hill"] },
  Roxbury: { city: "Boston, MA", aliases: ["roxbury"] },
  Dorchester: { city: "Boston, MA", aliases: ["dorchester"] },
  "South Boston": { city: "Boston, MA", aliases: ["south boston", "southie"] },
  "East Boston": { city: "Boston, MA", aliases: ["east boston", "eastie"] },
  Charlestown: { city: "Boston, MA", aliases: ["charlestown"] },
  Cambridge: {
    city: "Boston, MA",
    aliases: ["cambridge", "harvard square", "central square", "porter square"],
  },
  Somerville: { city: "Boston, MA", aliases: ["somerville", "davis square", "union square"] },
  Brookline: { city: "Boston, MA", aliases: ["brookline", "coolidge corner"] },
  Medford: { city: "Boston, MA", aliases: ["medford"] },
  Malden: { city: "Boston, MA", aliases: ["malden"] },
  Watertown: { city: "Boston, MA", aliases: ["watertown"] },
  Newton: { city: "Boston, MA", aliases: ["newton"] },
  Quincy: { city: "Boston, MA", aliases: ["quincy"] },
};

export const HOUSING_KINDS: ListingKind[] = ["room", "sublet", "apartment"];

export const HousingRequirements = z.object({
  kinds: z.array(z.enum(LISTING_KINDS)).describe("what the owner is looking for; empty when unclear"),
  city: z
    .string()
    .nullable()
    .describe("'City, ST' when the owner names a city or a neighborhood whose city is known"),
  neighborhoods: z.array(z.string()).describe("neighborhoods or towns the owner named, capitalized"),
  budgetMaxUsd: z.number().nullable().describe("max monthly rent in whole dollars, or null"),
  hotelNightlyMaxUsd: z.number().nullable().describe("max per night for a hotel, or null"),
  moveIn: z.string().nullable().describe("ISO YYYY-MM-DD the owner wants the place from, or null"),
  moveOut: z.string().nullable().describe("ISO YYYY-MM-DD the stay ends, or null"),
  bedrooms: z.number().nullable().describe("0 for a studio"),
  furnished: z.boolean().nullable(),
  mustHaves: z.array(z.string()).describe("short phrases: 'near the T', 'parking', 'cats ok'"),
  notes: z.array(z.string()).describe("constraints that fit no field, in the owner's words"),
  wantsSearchNow: z.boolean().describe("true when the owner is asking the crew to find places"),
});
export type HousingRequirements = z.infer<typeof HousingRequirements>;

const BUDGET_PATTERNS = [
  /\$\s?(\d{1,2},?\d{3}|\d{3,5})(?:\s*(?:\/|per|a)\s*(?:mo|month))?/i,
  /\b(?:under|below|max|up to|at most|budget(?: is|:)?|no more than|less than|around|about|cap(?: of)?)\s*\$?\s?(\d{1,2},?\d{3}|\d{3,5})\b/i,
  /\b(\d{1,2},?\d{3}|\d{3,5})\s*(?:\/|per|a)\s*(?:mo|month)\b/i,
  /\b(\d{1,2},?\d{3}|\d{3,5})\s*(?:dollars|bucks)\b/i,
];

/** "under 1200", "$1,200/mo", "budget is 900": a monthly rent cap in cents, or null. */
export function parseBudgetCents(text: string): number | null {
  for (const re of BUDGET_PATTERNS) {
    const m = text.match(re);
    if (!m?.[1]) continue;
    const usd = Number(m[1].replace(/,/g, ""));
    if (usd >= 300 && usd <= 20000) return usd * 100;
  }
  return null;
}

/** "$150 a night", "under 200/night" */
export function parseNightlyCents(text: string): number | null {
  const m = text.match(/\$?\s?(\d{2,4})\s*(?:\/|per|a)\s*(?:night|nt)\b/i);
  if (!m?.[1]) return null;
  const usd = Number(m[1]);
  return usd >= 30 && usd <= 2000 ? usd * 100 : null;
}

export function parseNeighborhoods(text: string): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  for (const [name, { aliases }] of Object.entries(NEIGHBORHOODS)) {
    if (aliases.some((a) => new RegExp(`(^|[^a-z])${a}([^a-z]|$)`).test(t))) out.push(name);
  }
  return out;
}

export function cityOf(neighborhoods: string[]): string | null {
  for (const n of neighborhoods) {
    const hit = NEIGHBORHOODS[n];
    if (hit) return hit.city;
  }
  return null;
}

const MUST_HAVES: [RegExp, string][] = [
  [/\bnear (?:the )?(?:t|train|red line|green line|orange line|blue line|b line|subway)\b/i, "near the T"],
  [/\bparking\b/i, "parking"],
  [/\b(?:in[- ]unit )?laundry\b/i, "laundry"],
  [/\b(?:cats?|dogs?|pets?) ?(?:ok|friendly|allowed)\b/i, "pets ok"],
  [/\bno (?:broker|realtor) fee\b/i, "no broker fee"],
  [/\bprivate bath(?:room)?\b/i, "private bathroom"],
  [/\butilities included\b/i, "utilities included"],
  [/\bquiet\b/i, "quiet"],
];

/** Deterministic extraction used with the fake LLM and as a safety net beside the real one. */
export function extractHousingHeuristic(text: string, now: Date): HousingRequirements {
  const t = text.toLowerCase();
  const kinds: ListingKind[] = [];
  if (/\b(room|roommates?|shared (?:apt|apartment|house))\b/.test(t)) kinds.push("room");
  if (/\b(sublet|sublease|summer sublet|short[- ]term|for the summer)\b/.test(t)) kinds.push("sublet");
  if (/\b(apartment|apt|studio|\d\s?br|\d[- ]?bed(?:room)?s?|one bedroom|two bedroom)\b/.test(t))
    kinds.push("apartment");
  if (
    /\b(hotel|motel|airbnb|place to stay|somewhere to stay|crash|between leases|for (?:a|the) (?:few )?nights?)\b/.test(
      t,
    )
  )
    kinds.push("hotel");
  if (/\bstorage\b/.test(t)) kinds.push("storage");
  const wantsSearchNow =
    /\b(find|look(?:ing)? for|search|need a|any (?:rooms|places|sublets|apartments)|help me find|show me|hunt)\b/.test(
      t,
    );
  if (!kinds.length && /\b(a place|somewhere to live|housing)\b/.test(t)) kinds.push("sublet");
  const neighborhoods = parseNeighborhoods(text);
  const city = cityOf(neighborhoods) ?? (/\bboston\b/.test(t) ? "Boston, MA" : null);
  const range = parseDateRange(text, now);
  const beds = t.match(/\b(\d)\s?(?:br|bed|bedroom)s?\b/);
  const bedrooms = /\bstudio\b/.test(t) ? 0 : beds?.[1] ? Number(beds[1]) : null;
  const furnished = /\bunfurnished\b/.test(t) ? false : /\bfurnished\b/.test(t) ? true : null;
  const budget = parseBudgetCents(text);
  const nightly = parseNightlyCents(text);
  return {
    kinds: [...new Set(kinds)],
    city,
    neighborhoods,
    budgetMaxUsd: budget != null ? budget / 100 : null,
    hotelNightlyMaxUsd: nightly != null ? nightly / 100 : null,
    moveIn: range.start,
    moveOut: range.end,
    bedrooms,
    furnished,
    mustHaves: MUST_HAVES.filter(([re]) => re.test(text)).map(([, label]) => label),
    notes: [],
    wantsSearchNow,
  };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function emptySearch(moveId: string, now: Date): HousingSearch {
  return {
    moveId,
    kinds: [],
    city: null,
    neighborhoods: [],
    budgetMaxCents: null,
    hotelNightlyMaxCents: null,
    moveIn: null,
    moveOut: null,
    bedrooms: null,
    furnished: null,
    mustHaves: [],
    notes: [],
    lastSearchedAt: null,
    lastSearchKey: null,
    shownCount: 0,
    updatedAt: now.toISOString(),
  };
}

/** This turn's facts over the saved ones: scalars override, lists union, the move's dates fill gaps. */
export function mergeSearch(
  prev: HousingSearch | undefined,
  reqs: HousingRequirements,
  move: Move,
  now: Date,
): HousingSearch {
  const base = prev ?? emptySearch(move.id, now);
  const neighborhoods = uniq([...base.neighborhoods, ...reqs.neighborhoods]);
  return {
    ...base,
    kinds: uniq([...base.kinds, ...reqs.kinds]),
    city: reqs.city ?? base.city ?? cityOf(neighborhoods),
    neighborhoods,
    budgetMaxCents: reqs.budgetMaxUsd != null ? Math.round(reqs.budgetMaxUsd * 100) : base.budgetMaxCents,
    hotelNightlyMaxCents:
      reqs.hotelNightlyMaxUsd != null ? Math.round(reqs.hotelNightlyMaxUsd * 100) : base.hotelNightlyMaxCents,
    moveIn: reqs.moveIn ?? base.moveIn ?? move.moveInAt,
    moveOut: reqs.moveOut ?? base.moveOut,
    bedrooms: reqs.bedrooms ?? base.bedrooms,
    furnished: reqs.furnished ?? base.furnished,
    mustHaves: uniq([...base.mustHaves, ...reqs.mustHaves]),
    notes: uniq([...base.notes, ...reqs.notes]),
    updatedAt: now.toISOString(),
  };
}

export type MissingRequirement = "budget" | "area" | "dates";

/** The one thing to ask for next, or null when there is enough to search. */
export function missingRequirement(s: HousingSearch): MissingRequirement | null {
  const kinds = s.kinds.length ? s.kinds : HOUSING_KINDS;
  const housing = kinds.some((k) => HOUSING_KINDS.includes(k));
  const hotel = kinds.includes("hotel");
  if (housing && s.budgetMaxCents == null) return "budget";
  if (!s.city && !s.neighborhoods.length) return "area";
  if (housing && !s.moveIn) return "dates";
  if (hotel && !housing && (!s.moveIn || !s.moveOut)) return "dates";
  return null;
}

/** The hotel nights between leaving the old place and getting the new one, when that gap is short. */
export function hotelGap(s: HousingSearch, move: Move): { moveIn: string; moveOut: string } | null {
  const start = move.moveOutAt;
  const end = s.moveIn ?? move.moveInAt;
  const nights = nightsBetween(start, end);
  return start && end && nights != null && nights <= 14 ? { moveIn: start, moveOut: end } : null;
}

export function queriesFor(s: HousingSearch, move: Move): ListingQuery[] {
  const city = s.city ?? cityOf(s.neighborhoods) ?? "Boston, MA";
  const kinds = s.kinds.length ? s.kinds : (["room", "sublet"] as ListingKind[]);
  const base = {
    city,
    neighborhoods: s.neighborhoods,
    bedrooms: s.bedrooms,
    furnished: s.furnished,
    mustHaves: s.mustHaves,
  };
  const out: ListingQuery[] = [];
  for (const kind of kinds.filter((k) => HOUSING_KINDS.includes(k))) {
    out.push({
      kind,
      ...base,
      budgetMaxCents: s.budgetMaxCents,
      priceUnit: "month",
      moveIn: s.moveIn,
      moveOut: s.moveOut,
    });
  }
  const gap = hotelGap(s, move);
  if (kinds.includes("hotel") || (gap && out.length)) {
    const dates = gap ?? (s.moveIn && s.moveOut ? { moveIn: s.moveIn, moveOut: s.moveOut } : null);
    if (dates) {
      out.push({
        kind: "hotel",
        ...base,
        neighborhoods: [],
        budgetMaxCents: s.hotelNightlyMaxCents,
        priceUnit: "night",
        moveIn: dates.moveIn,
        moveOut: dates.moveOut,
      });
    }
  }
  if (kinds.includes("storage")) {
    out.push({
      kind: "storage",
      ...base,
      neighborhoods: [],
      budgetMaxCents: null,
      priceUnit: "month",
      moveIn: move.moveOutAt,
      moveOut: s.moveIn ?? move.moveInAt,
    });
  }
  return out;
}

/** Stable key for a set of queries, for the "same search again within minutes" guard. */
export function searchKey(queries: ListingQuery[]): string {
  const s = JSON.stringify(
    queries.map((q) => [
      q.kind,
      q.city,
      [...q.neighborhoods].sort(),
      q.budgetMaxCents,
      q.moveIn,
      q.moveOut,
      q.bedrooms,
    ]),
  );
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
