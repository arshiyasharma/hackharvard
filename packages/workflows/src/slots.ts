import type { Slot } from "./types.ts";

export interface SlotRules {
  /** Hard rules from the owner's constraints, e.g. "no mornings". */
  noMornings?: boolean;
  noEvenings?: boolean;
  noWeekends?: boolean;
  noWeekdays?: boolean;
}

const WINDOWS_WEEKDAY: [number, number][] = [
  [12, 13],
  [17.5, 19],
];
const WINDOWS_WEEKEND: [number, number][] = [
  [10, 12],
  [14, 16],
];

/** Wall-clock parts of an instant in a time zone. */
function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, min: Number(o.minute), weekday: o.weekday ?? "" };
}

/** The instant for a wall-clock time in a time zone (two-pass offset correction, good enough for DST). */
export function zoned(y: number, m: number, d: number, hour: number, tz: string): Date {
  const h = Math.floor(hour);
  const min = Math.round((hour - h) * 60);
  let guess = new Date(Date.UTC(y, m - 1, d, h, min));
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const want = Date.UTC(y, m - 1, d, h, min);
    guess = new Date(guess.getTime() + (want - asUtc));
  }
  return guess;
}

function label(start: Date, end: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })
    .format(start)
    .replace(",", "");
  const t = (x: Date) => {
    const p = parts(x, tz);
    const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    const ampm = p.h >= 12 ? "pm" : "am";
    return p.min ? `${h12}:${String(p.min).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
  };
  return `${day}, ${t(start)}–${t(end)}`;
}

/**
 * Up to `count` pickup windows: lunch and early evening on weekdays, late morning and afternoon on weekends,
 * starting at least two hours from now and ending by move-out. Owner constraints remove windows.
 */
export function proposeSlots(opts: {
  now: Date;
  moveOutAt: string | null;
  count?: number;
  rules?: SlotRules;
  tz?: string;
}): Slot[] {
  const tz = opts.tz ?? "America/New_York";
  const count = opts.count ?? 3;
  const rules = opts.rules ?? {};
  const earliest = opts.now.getTime() + 2 * 3600_000;
  const limit = opts.moveOutAt ? zoned(...(opts.moveOutAt.split("-").map(Number) as [number, number, number]), 23.99, tz).getTime() : Number.POSITIVE_INFINITY;
  const out: Slot[] = [];
  const start = parts(opts.now, tz);
  for (let offset = 0; offset < 10 && out.length < count; offset++) {
    const dayStart = zoned(start.y, start.m, start.d + offset, 0, tz);
    const p = parts(dayStart, tz);
    const weekend = p.weekday === "Sat" || p.weekday === "Sun";
    if ((weekend && rules.noWeekends) || (!weekend && rules.noWeekdays)) continue;
    for (const [a, b] of weekend ? WINDOWS_WEEKEND : WINDOWS_WEEKDAY) {
      if (rules.noMornings && a < 12) continue;
      if (rules.noEvenings && a >= 17) continue;
      const s = zoned(p.y, p.m, p.d, a, tz);
      const e = zoned(p.y, p.m, p.d, b, tz);
      if (s.getTime() < earliest || e.getTime() > limit) continue;
      out.push({ start: s.toISOString(), end: e.toISOString(), label: label(s, e, tz) });
      if (out.length >= count) break;
    }
  }
  return out;
}

/** Turn remembered constraints ("Owner can't do mornings") into slot rules. */
export function rulesFromFacts(facts: string[]): SlotRules {
  const text = facts.join(" \n ").toLowerCase();
  const neg = (word: string) => new RegExp(`\\b(no|not|never|can'?t|cannot|avoid|rather not|don'?t do|except)\\b[^.\\n]{0,24}\\b${word}`, "i").test(text) || new RegExp(`\\b${word}[^.\\n]{0,12}\\b(don'?t|doesn'?t|won'?t) work`, "i").test(text);
  return {
    noMornings: neg("mornings?") || /\bnot before (10|11|noon)\b/.test(text),
    noEvenings: neg("evenings?|nights?"),
    noWeekends: neg("weekends?"),
    noWeekdays: neg("weekdays?"),
  };
}
