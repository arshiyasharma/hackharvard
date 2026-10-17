import { slug } from "./dedupe.ts";
import type { ListingKind, PriceUnit, SiteResult } from "./domain.ts";

export const SCAM_FLAGS = [
  "price_too_low",
  "wire_or_prepay",
  "out_of_country",
  "no_address",
  "no_photos",
  "cross_site_price_mismatch",
] as const;
export type ScamFlag = (typeof SCAM_FLAGS)[number];

/** Flags that sink a listing below every clean one. */
export const HARD_FLAGS: ScamFlag[] = ["price_too_low", "wire_or_prepay", "out_of_country"];

export const SCAM_FLAG_LABELS: Record<ScamFlag, string> = {
  price_too_low: "priced far below similar listings",
  wire_or_prepay: "asks for a wire, gift card or app payment up front",
  out_of_country: "the poster says they are away or abroad",
  no_address: "no location given",
  no_photos: "no photos",
  cross_site_price_mismatch: "listed at a different price on another site",
};

const PREPAY =
  /\b(western union|moneygram|wire transfer|wire the|gift cards?|bitcoin|crypto)\b|\b(zelle|venmo|cash ?app|paypal|apple pay)\b[^.!?\n]{0,80}\b(deposit|before|prior|first|hold|secure|reserve)\b|\b(deposit|payment)\b[^.!?\n]{0,60}\b(before|prior to)\b[^.!?\n]{0,40}\b(viewing|seeing|tour|visit)\b/i;
const AWAY =
  /\b(out of (the )?country|out of state|overseas|abroad|on a mission|missionary|deployed|military base|can'?t show (it|the place)|keys? (will be )?(mailed|shipped))\b/i;

const MIN_PEERS = 4;

/** Median price of the other listings of the same kind and unit; null until there are enough to compare. */
export function medianPriceCents(peers: SiteResult[], kind: ListingKind, unit: PriceUnit): number | null {
  const prices = peers
    .filter((p) => p.kind === kind && p.priceUnit === unit && p.priceCents != null)
    .map((p) => p.priceCents as number)
    .sort((a, b) => a - b);
  if (prices.length < MIN_PEERS) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2
    ? (prices[mid] as number)
    : ((prices[mid - 1] as number) + (prices[mid] as number)) / 2;
}

/**
 * Deterministic scam signals. Run on the raw, pre-dedupe results so cross-site pairs are still visible.
 */
export function scamFlags(r: SiteResult, allRaw: SiteResult[]): ScamFlag[] {
  const flags: ScamFlag[] = [];
  const text = `${r.title}\n${r.snippet ?? ""}`;
  const peers = allRaw.filter((p) => p !== r);
  const median = medianPriceCents(peers, r.kind, r.priceUnit);
  if (r.priceCents != null && median != null && r.priceCents < median * 0.5) flags.push("price_too_low");
  if (PREPAY.test(text)) flags.push("wire_or_prepay");
  if (AWAY.test(text)) flags.push("out_of_country");
  if (!r.location && r.kind !== "hotel") flags.push("no_address");
  if (r.photoCount === 0) flags.push("no_photos");
  const price = r.priceCents;
  if (price != null) {
    const mine = slug(r.title);
    const twin = peers.find(
      (p) =>
        p.site !== r.site &&
        p.priceCents != null &&
        p.priceUnit === r.priceUnit &&
        slug(p.title) === mine &&
        Math.abs(p.priceCents - price) > price * 0.3,
    );
    if (twin) flags.push("cross_site_price_mismatch");
  }
  return flags;
}

export function isHardFlagged(flags: readonly string[]): boolean {
  return flags.some((f) => (HARD_FLAGS as readonly string[]).includes(f));
}
