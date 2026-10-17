import { z } from "zod";
import type { ListingKind, ListingQuery, PriceUnit, SiteResult } from "./domain.ts";

/** The one schema every site is extracted with; prices stay as text so parsing is deterministic and tested. */
export const SiteExtraction = z.object({
  listings: z.array(
    z.object({
      title: z.string(),
      // A plain string on purpose: the model answers with the link's node id ("[1-778]") and the runner maps
      // it to the real href through the snapshot's urlMap. z.url() would make Stagehand reject the whole
      // page when one link does not resolve.
      url: z.string().describe("the listing link: its href, or the id of the link node"),
      priceText: z
        .string()
        .nullable()
        .describe("price exactly as shown, e.g. '$1,200/mo', '$140 night', '$2,310 total'"),
      priceBasis: z.enum(["month", "night", "total", "unknown"]).describe("what the shown price covers"),
      location: z.string().nullable().describe("neighborhood, address or distance line as shown"),
      availableFrom: z
        .string()
        .nullable()
        .describe("ISO date YYYY-MM-DD if the listing says when it is available"),
      bedrooms: z.number().nullable(),
      snippet: z.string().nullable().describe("one or two sentences of the description, verbatim"),
      postedAt: z.string().nullable().describe("ISO date if the post date is shown"),
      photoCount: z.number().nullable().describe("number of photos, or null if not shown"),
      contactPhone: z.string().nullable(),
      contactEmail: z.string().nullable(),
    }),
  ),
});
export type SiteExtraction = z.infer<typeof SiteExtraction>;
export type ExtractedListing = SiteExtraction["listings"][number];
export type PriceBasis = ExtractedListing["priceBasis"];

export interface SiteRecipe {
  /** Stable id used in allowlists, runs and Listing.site. */
  site: string;
  /** What the owner reads: "Craigslist". */
  label: string;
  kinds: ListingKind[];
  /** True when the site only works inside a logged-in browser context. */
  needsLogin: boolean;
  /** Hosts a returned listing URL may live on (suffix match), e.g. ["craigslist.org"]. */
  hosts: string[];
  /** Search URL for the query, or null when the recipe cannot serve it. Pure; unit-tested. */
  buildUrl(q: ListingQuery): string | null;
  /** Best-effort act() steps before extraction (close a popup, load more). Failures are ignored. */
  prepare?(q: ListingQuery): string[];
  instruction(q: ListingQuery): string;
  /** CSS selector that scopes what the model reads; keeps token cost down. */
  locator?: string;
  maxListings?: number;
}

export const DEFAULT_MAX_LISTINGS = 12;

export function nightsBetween(moveIn: string | null, moveOut: string | null): number | null {
  if (!moveIn || !moveOut) return null;
  const a = Date.parse(moveIn);
  const b = Date.parse(moveOut);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const n = Math.round((b - a) / 86400_000);
  return n > 0 ? n : null;
}

const MONTH_WORDS = /\/\s?mo\b|\bmonth|\bmo\b|\bmonthly|\bper month|\bpm\b/i;
const NIGHT_WORDS = /\bnight|\/\s?nt\b|\bnightly|\bper night/i;

/**
 * Turn "$1,200/mo", "$140 night" or "$2,310 total" into cents per month or per night. A total is spread over
 * the nights of the query: hotels per night, housing per 30-night month. Returns null when there is no number.
 */
export function parseListingPrice(
  text: string | null,
  basis: PriceBasis,
  nights: number | null,
  kind: ListingKind,
): { cents: number; unit: PriceUnit } | null {
  if (!text) return null;
  const m = text.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!m?.[1]) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  const defaultUnit: PriceUnit = kind === "hotel" ? "night" : "month";
  // "$375 for 5 nights": the site's own stay length beats the query's (Airbnb quotes a sample stay).
  const stated = text.match(/\bfor\s+(\d{1,3})\s+nights?\b/i);
  const span = stated?.[1] ? Number(stated[1]) : nights;
  let resolved: PriceBasis = basis;
  if (stated) resolved = "total";
  else if (resolved === "unknown") {
    if (NIGHT_WORDS.test(text)) resolved = "night";
    else if (MONTH_WORDS.test(text)) resolved = "month";
    else if (/\btotal\b/i.test(text)) resolved = "total";
  }
  if (resolved === "month") return { cents, unit: "month" };
  if (resolved === "night") return { cents, unit: "night" };
  if (resolved === "total") {
    if (!span) return { cents, unit: defaultUnit };
    const nightly = Math.round(cents / span);
    if (kind === "hotel") return { cents: nightly, unit: "night" };
    // Short sample stays are quoted per night; a real monthly quote spreads the total over its months.
    return span < 28
      ? { cents: nightly * 30, unit: "month" }
      : { cents: Math.round(cents / Math.max(1, span / 30)), unit: "month" };
  }
  return { cents, unit: defaultUnit };
}

function hostAllowed(host: string, hosts: string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

/** Resolve a listing URL against the site and keep it only when it stays on that site. */
export function resolveListingUrl(raw: string, recipe: SiteRecipe, base: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!hostAllowed(url.hostname, recipe.hosts)) return null;
  url.hash = "";
  return url.toString();
}

function nonEmpty(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

/** Model output is shaped by the schema but not guaranteed; coerce one field at a time. */
function str(v: unknown): string | null {
  return typeof v === "string" ? nonEmpty(v) : v == null ? null : nonEmpty(String(v));
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Model output -> SiteResults. Everything the owner will see is checked here: the URL must stay on the site,
 * the price is parsed by code, empty titles are dropped.
 */
export function toResults(
  recipe: SiteRecipe,
  q: ListingQuery,
  data: SiteExtraction,
  searchUrl: string,
): SiteResult[] {
  const nights = nightsBetween(q.moveIn, q.moveOut);
  const max = recipe.maxListings ?? DEFAULT_MAX_LISTINGS;
  const out: SiteResult[] = [];
  for (const it of Array.isArray(data?.listings) ? data.listings : []) {
    if (out.length >= max) break;
    if (!it || typeof it !== "object") continue;
    const title = typeof it.title === "string" ? nonEmpty(it.title) : null;
    if (!title) continue;
    const url = typeof it.url === "string" ? resolveListingUrl(it.url, recipe, searchUrl) : null;
    if (!url) continue;
    const basis = (["month", "night", "total", "unknown"] as const).includes(it.priceBasis)
      ? it.priceBasis
      : "unknown";
    const price = parseListingPrice(
      typeof it.priceText === "string" ? it.priceText : null,
      basis,
      nights,
      q.kind,
    );
    out.push({
      site: recipe.site,
      kind: q.kind,
      url,
      title,
      priceCents: price?.cents ?? null,
      priceUnit: price?.unit ?? q.priceUnit,
      location: str(it.location),
      availableFrom: str(it.availableFrom),
      bedrooms: num(it.bedrooms),
      snippet: str(it.snippet),
      postedAt: str(it.postedAt),
      photoCount: num(it.photoCount),
      contact: {
        phone: str(it.contactPhone),
        email: str(it.contactEmail),
        messageUrl: null,
      },
    });
  }
  return out;
}

const NODE_ID = /^\[?(\d+-\d+)\]?$/;

/**
 * Replace node ids the model used as links ("[1-778]") with the hrefs the accessibility snapshot recorded
 * for them. Anything already a URL is left alone.
 */
export function resolveNodeUrls(data: SiteExtraction, urlMap: Record<string, string>): SiteExtraction {
  if (!Array.isArray(data?.listings)) return data;
  // Link ids per frame, ascending, so a card id can find the first link inside the card.
  const byFrame = new Map<string, number[]>();
  for (const key of Object.keys(urlMap)) {
    const m = key.match(/^\[?(\d+)-(\d+)\]?$/);
    if (!m?.[1] || !m[2]) continue;
    const list = byFrame.get(m[1]) ?? [];
    list.push(Number(m[2]));
    byFrame.set(m[1], list);
  }
  for (const list of byFrame.values()) list.sort((a, b) => a - b);
  const MAX_DISTANCE = 200;
  return {
    ...data,
    listings: data.listings.map((it) => {
      const m = typeof it?.url === "string" ? it.url.trim().match(NODE_ID) : null;
      if (!m?.[1]) return it;
      const direct = urlMap[m[1]] ?? urlMap[`[${m[1]}]`];
      if (direct) return { ...it, url: direct };
      // The model usually names the card; its link is the next link node after it.
      const [frame, n] = m[1].split("-");
      const next = (byFrame.get(frame ?? "") ?? []).find(
        (id) => id > Number(n) && id - Number(n) <= MAX_DISTANCE,
      );
      const href = next != null ? (urlMap[`${frame}-${next}`] ?? urlMap[`[${frame}-${next}]`]) : undefined;
      return href ? { ...it, url: href } : it;
    }),
  };
}

export interface PlannedSearch {
  recipe: SiteRecipe;
  query: ListingQuery;
  url: string;
}

export interface SkippedSearch {
  site: string;
  kind: ListingKind;
  reason: "login" | "allowlist" | "no_url";
}

/** Which (recipe, query) pairs to run, in recipe order; login-only sites are skipped without a context. */
export function recipesFor(
  queries: ListingQuery[],
  caps: { loggedIn: boolean; sites: string[] | null },
  recipes: SiteRecipe[],
): { planned: PlannedSearch[]; skipped: SkippedSearch[] } {
  const planned: PlannedSearch[] = [];
  const skipped: SkippedSearch[] = [];
  for (const recipe of recipes) {
    for (const query of queries) {
      if (!recipe.kinds.includes(query.kind)) continue;
      if (caps.sites && !caps.sites.includes(recipe.site)) {
        skipped.push({ site: recipe.site, kind: query.kind, reason: "allowlist" });
        continue;
      }
      if (recipe.needsLogin && !caps.loggedIn) {
        skipped.push({ site: recipe.site, kind: query.kind, reason: "login" });
        continue;
      }
      const url = recipe.buildUrl(query);
      if (!url) {
        skipped.push({ site: recipe.site, kind: query.kind, reason: "no_url" });
        continue;
      }
      planned.push({ recipe, query, url });
    }
  }
  return { planned, skipped };
}

/** "$1,200" / "$1,200/mo" / "$140/night" for prompts and instructions. */
export function fmtUsd(cents: number): string {
  const usd = cents / 100;
  return `$${usd.toLocaleString("en-US", { maximumFractionDigits: usd % 1 === 0 ? 0 : 2 })}`;
}

export function budgetUsd(q: ListingQuery): number | null {
  return q.budgetMaxCents != null ? Math.round(q.budgetMaxCents / 100) : null;
}

/** "rooms", "sublets", "apartments", "hotels", "storage units" */
export function kindNoun(kind: ListingKind, plural = true): string {
  const map: Record<ListingKind, [string, string]> = {
    room: ["room", "rooms"],
    sublet: ["sublet", "sublets"],
    apartment: ["apartment", "apartments"],
    hotel: ["hotel", "hotels"],
    storage: ["storage unit", "storage units"],
  };
  return map[kind][plural ? 1 : 0];
}
