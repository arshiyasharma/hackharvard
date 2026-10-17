import { z } from "zod";

/** Weight defaults from the design doc's factor table (approximate, labeled as such in the UI). */
export const CATEGORIES = [
  "couch",
  "mattress",
  "desk_table",
  "chair",
  "bookshelf_dresser",
  "small",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];
export const DEFAULT_WEIGHT_LB: Record<Category, number> = {
  couch: 150,
  mattress: 60,
  desk_table: 70,
  chair: 20,
  bookshelf_dresser: 90,
  small: 10,
  other: 25,
};

export const CATEGORY_WORDS: Record<Category, string[]> = {
  couch: ["couch", "sofa", "loveseat", "sectional", "futon"],
  mattress: ["mattress", "bed", "bed frame", "box spring"],
  desk_table: ["desk", "table", "dining table", "coffee table", "nightstand"],
  chair: ["chair", "stool", "armchair", "office chair"],
  bookshelf_dresser: ["bookshelf", "shelf", "shelves", "dresser", "wardrobe", "cabinet"],
  small: ["lamp", "rug", "mirror", "tv", "monitor", "microwave", "fan", "heater", "plant", "speaker"],
  other: [],
};

export const ExtractedFacts = z.object({
  moveOutDate: z.string().nullable().describe("ISO date YYYY-MM-DD the owner moves out, or null"),
  moveInDate: z.string().nullable().describe("ISO date YYYY-MM-DD the owner moves in, or null"),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  items: z.array(
    z.object({
      name: z.string(),
      category: z.enum(CATEGORIES),
      intent: z.enum(["sell", "donate", "keep", "buy", "unknown"]),
    }),
  ),
  roommates: z.array(z.string()),
  asks: z.array(z.string()).describe("explicit requests the owner made, in their words"),
});
export type ExtractedFacts = z.infer<typeof ExtractedFacts>;

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Parse "november 1", "nov 1st", "11/1", "tomorrow", "next friday" relative to `now`; returns YYYY-MM-DD or null. */
export function parseDate(text: string, now: Date): string | null {
  const t = text.toLowerCase();
  const y = now.getFullYear();
  const mk = (yy: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(yy, m - 1, d));
    // roll into next year if the date already passed by more than 30 days
    if (dt.getTime() < now.getTime() - 30 * 86400_000) dt.setUTCFullYear(yy + 1);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  };
  if (/\btomorrow\b/.test(t)) {
    const d = new Date(now.getTime() + 86400_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const m1 = t.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/,
  );
  if (m1) return mk(m1[3] ? Number(m1[3]) : y, MONTHS[m1[1] as string] ?? 1, Number(m1[2]));
  const m2 = t.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/,
  );
  if (m2) return mk(y, MONTHS[m2[2] as string] ?? 1, Number(m2[1]));
  const m3 = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m3) {
    const yy = m3[3] ? (m3[3].length === 2 ? 2000 + Number(m3[3]) : Number(m3[3])) : y;
    return mk(yy, Number(m3[1]), Number(m3[2]));
  }
  const m4 = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m4) return `${m4[1]}-${m4[2]}-${m4[3]}`;
  return null;
}

/** Deterministic extraction used without an LLM (and as a safety net beside it). */
export function extractFactsHeuristic(text: string, now: Date): ExtractedFacts {
  const t = text.toLowerCase();
  const items: ExtractedFacts["items"] = [];
  const seen = new Set<string>();
  for (const [cat, words] of Object.entries(CATEGORY_WORDS) as [Category, string[]][]) {
    for (const w of words) {
      const re = new RegExp(`(^|[^a-z])${w}(es|s)?([^a-z]|$)`, "i");
      if (re.test(t) && !seen.has(w)) {
        seen.add(w);
        const intent = /\b(sell|selling|get rid|take|offload|list)\b/.test(t)
          ? "sell"
          : /\b(donate|give away|free)\b/.test(t)
            ? "donate"
            : /\b(buy|looking for|need a)\b/.test(t)
              ? "buy"
              : "unknown";
        items.push({ name: w, category: cat, intent });
      }
    }
  }
  const out = /\b(move|moving|movin|leave|leaving|out)\b[^.\n]{0,40}?\b(out|by|on)?\b/.test(t)
    ? parseDate(t, now)
    : parseDate(t, now);
  const isMoveIn = /\bmove[- ]?in\b|\bmoving in\b/.test(t) && !/\bmove[- ]?out\b|\bmoving out\b/.test(t);
  return {
    moveOutDate: isMoveIn ? null : out,
    moveInDate: isMoveIn ? out : null,
    fromAddress: null,
    toAddress: null,
    items,
    roommates: [],
    asks: [],
  };
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1));
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
