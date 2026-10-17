import type { SiteResult } from "./domain.ts";

/** Lowercase host without www, no query or hash, no trailing slash: the same post reached two ways is one. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/** Same title at the same price on two sites is one listing cross-posted. */
export function fingerprint(r: SiteResult): string {
  return `${slug(r.title)}|${r.priceCents ?? "?"}`;
}

/** First occurrence wins, so pass results in recipe trust order. */
export function dedupeResults(results: SiteResult[]): SiteResult[] {
  const seenUrl = new Set<string>();
  const seenPrint = new Set<string>();
  const out: SiteResult[] = [];
  for (const r of results) {
    const u = normalizeUrl(r.url);
    const p = fingerprint(r);
    if (seenUrl.has(u) || seenPrint.has(p)) continue;
    seenUrl.add(u);
    seenPrint.add(p);
    out.push(r);
  }
  return out;
}
