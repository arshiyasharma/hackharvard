/** Cents, dollars, dates and phone numbers. Every amount in the Money Elf is integer cents. */

export function fmtUsd(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `$${(abs / 100).toFixed(abs % 100 === 0 ? 0 : 2)}`;
  return neg ? `-${s}` : s;
}

const AMOUNT_RE =
  /\$\s?(\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.(\d{1,2}))?|\b(\d{1,6})(?:\.(\d{1,2}))?\s?(?:dollars|bucks|usd)\b/gi;

/** Every dollar amount written with a $ or a unit ("$240", "$1,200.50", "80 bucks"), in order, as cents. */
export function parseAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const whole = (m[1] ?? m[3] ?? "").replace(/,/g, "");
    const frac = m[2] ?? m[4] ?? "";
    if (!whole) continue;
    out.push(Number(whole) * 100 + (frac ? Number(frac.padEnd(2, "0")) : 0));
  }
  return out;
}

/** True when `cents` is written somewhere in the text, with or without a $ (guards LLM-invented amounts). */
export function amountAppearsIn(text: string, cents: number): boolean {
  if (parseAmounts(text).includes(cents)) return true;
  const plain = text.replace(/,/g, "");
  const dollars = cents / 100;
  const forms = cents % 100 === 0 ? [String(dollars), dollars.toFixed(2)] : [dollars.toFixed(2)];
  return forms.some((f) => new RegExp(`(^|[^0-9.])${f.replace(".", "\\.")}([^0-9]|$)`).test(plain));
}

/**
 * Split `totalCents` by weights so the parts always add up to the total exactly. Leftover cents go one at a
 * time to the largest fractional remainders, earliest person first on ties.
 */
export function splitCents(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || weights.some((w) => w < 0))
    throw new Error("split weights must be non-negative and sum > 0");
  const raw = weights.map((w) => (totalCents * w) / sum);
  const parts = raw.map((r) => Math.floor(r));
  let left = totalCents - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    left--;
  }
  return parts;
}

/** US phone number in E.164 (+1XXXXXXXXXX), or null. */
export function normalizePhone(text: string): string | null {
  const m = text.match(/(\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/);
  if (!m) return null;
  return `+1${m[2]}${m[3]}${m[4]}`;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The next occurrence of a written date ("Dec 1", "12/1", "2026-12-01") on or after `now`, as YYYY-MM-DD. */
export function parseDate(text: string, now: Date): string | null {
  const t = text.toLowerCase();
  const full = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (full) return iso(Number(full[1]), Number(full[2]), Number(full[3]));
  let month: number | null = null;
  let day: number | null = null;
  const named = t.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  if (named) {
    month = MONTHS[named[1] ?? ""] ?? null;
    day = Number(named[2]);
  } else {
    const slash = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (slash) {
      month = Number(slash[1]);
      day = Number(slash[2]);
      if (slash[3]) {
        const y = Number(slash[3]);
        return iso(y < 100 ? 2000 + y : y, month, day);
      }
    }
  }
  if (month == null || day == null || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = now.getUTCFullYear();
  const candidate = iso(y, month, day);
  return candidate >= now.toISOString().slice(0, 10) ? candidate : iso(y + 1, month, day);
}

export function fmtDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
