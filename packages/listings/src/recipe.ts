import { z } from "zod";
import type { ListingKind, ListingQuery, PriceUnit, SiteResult } from "./domain.ts";

/** The one schema every site is extracted with; prices stay as text so parsing is deterministic and tested. */
export const SiteExtraction = z.object({
  listings: z.array(
    z.object({
      title: z.string(),
      // z.url() matters: Stagehand resolves URL-typed fields to real hrefs; a plain string gets a node id.
      url: z.url().describe("link to the listing"),
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
  let resolved: PriceBasis = basis;
  if (resolved === "unknown") {
    if (NIGHT_WORDS.test(text)) resolved = "night";
    else if (MONTH_WORDS.test(text)) resolved = "month";
    else if (/\btotal\b/i.test(text)) resolved = "total";
  }
  if (resolved === "month") return { cents, unit: "month" };
  if (resolved === "night") return { cents, unit: "night" };
  if (resolved === "total") {
    if (!nights) return { cents, unit: defaultUnit };
    if (kind === "hotel") return { cents: Math.round(cents / nights), unit: "night" };
    return { cents: Math.round(cents / Math.max(1, nights / 30)), unit: "month" };
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
  for (const it of data.listings) {
    if (out.length >= max) break;
    const title = nonEmpty(it.title);
    if (!title) continue;
    const url = resolveListingUrl(it.url, recipe, searchUrl);
    if (!url) continue;
    const price = parseListingPrice(it.priceText, it.priceBasis, nights, q.kind);
    out.push({
      site: recipe.site,
      kind: q.kind,
      url,
      title,
      priceCents: price?.cents ?? null,
      priceUnit: price?.unit ?? q.priceUnit,
      location: nonEmpty(it.location),
      availableFrom: nonEmpty(it.availableFrom),
      bedrooms: it.bedrooms ?? null,
      snippet: nonEmpty(it.snippet),
      postedAt: nonEmpty(it.postedAt),
      photoCount: it.photoCount ?? null,
      contact: {
        phone: nonEmpty(it.contactPhone),
        email: nonEmpty(it.contactEmail),
        messageUrl: null,
      },
    });
  }
  return out;
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
