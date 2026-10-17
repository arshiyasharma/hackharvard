import { isHardFlagged, SCAM_FLAG_LABELS, type ScamFlag } from "@elves/listings";
import type { HousingSearch, Listing, ListingKind, PriceUnit, SiteResult } from "@elves/shared";
import { z } from "zod";
import type { ElfContext } from "./contract.ts";
import { formatDate } from "./facts.ts";
import { HOUSING_KINDS } from "./home-facts.ts";

export const ListingScores = z.object({
  scores: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(100),
      reason: z.string().describe("under 80 characters: why it fits or does not, in the owner's terms"),
    }),
  ),
});
export type ListingScores = z.infer<typeof ListingScores>;

export interface Candidate {
  result: SiteResult;
  flags: ScamFlag[];
}

export interface Ranked extends Candidate {
  score: number;
  reason: string;
}

export function fmtPrice(cents: number | null, unit: PriceUnit): string {
  if (cents == null) return "price not listed";
  const usd = cents / 100;
  const n = `$${usd.toLocaleString("en-US", { maximumFractionDigits: usd % 1 === 0 ? 0 : 2 })}`;
  return `${n}/${unit === "night" ? "night" : "mo"}`;
}

/** Fit against the owner's ask, with a reason the owner can read. Used alone with the fake LLM. */
export function heuristicScore(
  r: SiteResult,
  s: HousingSearch,
  flags: ScamFlag[],
): { score: number; reason: string } {
  let score = 100;
  const why: string[] = [];
  const budget = r.priceUnit === "night" ? s.hotelNightlyMaxCents : s.budgetMaxCents;
  if (budget != null && r.priceCents != null) {
    const over = r.priceCents - budget;
    if (over > 0) {
      score -= Math.min(50, Math.round((over / budget) * 200));
      why.push(`over budget by ${fmtPrice(over, r.priceUnit).replace(/\/.*/, "")}`);
    } else why.push(over < -budget * 0.1 ? "under budget" : "within budget");
  } else if (r.priceCents == null) {
    score -= 10;
    why.push("no price shown");
  }
  if (s.neighborhoods.length && HOUSING_KINDS.includes(r.kind)) {
    const loc = (r.location ?? "").toLowerCase();
    const hit = s.neighborhoods.find((n) => loc.includes(n.toLowerCase()));
    if (hit) why.push(`in ${hit}`);
    else {
      score -= 20;
      why.push("outside the areas you named");
    }
  }
  if (s.moveIn && r.availableFrom) {
    const late = (Date.parse(r.availableFrom) - Date.parse(s.moveIn)) / 86400_000;
    if (late > 14) {
      score -= 15;
      why.push(`not available until ${formatDate(r.availableFrom)}`);
    } else why.push(`available ${formatDate(r.availableFrom)}`);
  }
  if (
    s.furnished &&
    /furnished/i.test(`${r.title} ${r.snippet ?? ""}`) &&
    !/unfurnished/i.test(r.snippet ?? "")
  )
    why.push("furnished");
  for (const f of flags) score -= isHardFlagged([f]) ? 30 : 10;
  if (flags.length) why.push(flags.map((f) => SCAM_FLAG_LABELS[f]).join(", "));
  return { score: Math.max(0, Math.min(100, score)), reason: why.slice(0, 3).join(", ") };
}

const RANK_SYSTEM =
  "You rank housing listings for someone who texted a moving crew. Score each candidate 0-100 for how well it " +
  "fits their requirements (budget, areas, dates, bedrooms, must-haves, notes). Give a reason under 80 characters " +
  "in plain words they would use. Do not invent details that are not in the candidate.";

/**
 * Score and explain every candidate. The real model scores at most 25 compact candidates in one call; the
 * heuristic fills anything it skips and stands alone with the fake LLM. Hard-flagged listings sink to the bottom.
 */
export async function rankListings(
  ctx: ElfContext,
  s: HousingSearch,
  candidates: Candidate[],
): Promise<Ranked[]> {
  const ranked: Ranked[] = candidates.map((c) => ({ ...c, ...heuristicScore(c.result, s, c.flags) }));
  if (ctx.llm.name !== "fake" && ranked.length) {
    const compact = ranked.slice(0, 25).map((c, i) => ({
      id: String(i + 1),
      kind: c.result.kind,
      title: c.result.title,
      price: fmtPrice(c.result.priceCents, c.result.priceUnit),
      location: c.result.location,
      availableFrom: c.result.availableFrom,
      bedrooms: c.result.bedrooms,
      snippet: c.result.snippet?.slice(0, 200) ?? null,
      flags: c.flags,
    }));
    try {
      const res = await ctx.llm.extract(ListingScores, {
        system: RANK_SYSTEM,
        user: `Requirements (JSON):\n${JSON.stringify(requirementsSummary(s))}\n\nCandidates (JSON):\n${JSON.stringify(compact)}`,
      });
      for (const sc of res.scores) {
        const idx = Number(sc.id) - 1;
        const target = ranked[idx];
        if (!target || !Number.isFinite(sc.score)) continue;
        target.score = Math.round(sc.score);
        if (sc.reason.trim()) target.reason = sc.reason.trim().slice(0, 100);
      }
    } catch (err) {
      ctx.log.warn("listing ranking failed; using heuristic scores", { error: String(err) });
    }
  }
  for (const r of ranked) if (isHardFlagged(r.flags)) r.score = Math.min(r.score, 19);
  return ranked.sort((a, b) => b.score - a.score);
}

export function requirementsSummary(s: HousingSearch) {
  return {
    kinds: s.kinds,
    city: s.city,
    neighborhoods: s.neighborhoods,
    budgetMax: s.budgetMaxCents != null ? fmtPrice(s.budgetMaxCents, "month") : null,
    hotelNightlyMax: s.hotelNightlyMaxCents != null ? fmtPrice(s.hotelNightlyMaxCents, "night") : null,
    moveIn: s.moveIn,
    moveOut: s.moveOut,
    bedrooms: s.bedrooms,
    furnished: s.furnished,
    mustHaves: s.mustHaves,
    notes: s.notes,
  };
}

export function describeAsk(s: HousingSearch): string {
  const kinds = s.kinds.filter((k) => HOUSING_KINDS.includes(k));
  const what = kinds.length
    ? kinds.map((k) => (k === "room" ? "a room" : k === "sublet" ? "a sublet" : "an apartment")).join(" or ")
    : s.kinds.includes("hotel")
      ? "a hotel"
      : s.kinds.includes("storage")
        ? "storage"
        : "a place";
  const where = s.neighborhoods.length
    ? ` in ${s.neighborhoods.join(" or ")}`
    : s.city
      ? ` in ${s.city}`
      : "";
  const budget =
    s.budgetMaxCents != null && kinds.length
      ? ` under ${fmtPrice(s.budgetMaxCents, "month").replace("/mo", "")}`
      : "";
  const when =
    s.moveIn && s.moveOut
      ? ` (${formatDate(s.moveIn)} – ${formatDate(s.moveOut)})`
      : s.moveIn
        ? ` (from ${formatDate(s.moveIn)})`
        : "";
  return `${what}${where}${budget}${when}`;
}

function pickLine(l: Listing): string {
  const parts = [l.title, fmtPrice(l.priceCents, l.priceUnit)];
  if (l.location) parts.push(l.location);
  return `${l.rank}. ${parts.join(" · ")}\n${l.url}${l.reason ? `\n${capitalize(l.reason)}.` : ""}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The results text: exact links, nothing the model wrote. */
export function formatPicks(
  s: HousingSearch,
  picks: Listing[],
  opts: {
    skippedScams: number;
    more: number;
    hotel: Listing | null;
    storage: Listing | null;
    intro?: string;
  },
): string {
  const lines: string[] = [];
  if (picks.length) {
    lines.push(opts.intro ?? `Top picks for ${describeAsk(s)}:`);
    for (const l of picks) lines.push(pickLine(l));
  }
  if (opts.hotel) {
    const gap = opts.hotel.availableFrom ? ` for ${formatDate(opts.hotel.availableFrom)}` : "";
    lines.push(
      `For the gap between places${gap}: ${opts.hotel.title} · ${fmtPrice(opts.hotel.priceCents, "night")}\n${opts.hotel.url}`,
    );
  }
  if (opts.storage) {
    lines.push(
      `Storage: ${opts.storage.title} · ${fmtPrice(opts.storage.priceCents, "month")}\n${opts.storage.url}`,
    );
  }
  const tail: string[] = [];
  if (opts.skippedScams)
    tail.push(`Skipped ${opts.skippedScams} that look${opts.skippedScams === 1 ? "s" : ""} like a scam.`);
  if (picks.length) {
    tail.push(
      opts.more > 0
        ? `Say "more" for the next ${Math.min(3, opts.more)}, or "tell me about ${picks[0]?.rank ?? 1}".`
        : `That's everything that fit. Say "tell me about ${picks[0]?.rank ?? 1}" for details.`,
    );
  }
  if (tail.length) lines.push(tail.join(" "));
  return lines.join("\n");
}

export function formatDetail(l: Listing): string {
  const lines = [`${l.rank != null ? `${l.rank}. ` : ""}${l.title} · ${fmtPrice(l.priceCents, l.priceUnit)}`];
  const facts: string[] = [];
  if (l.location) facts.push(l.location);
  if (l.bedrooms != null) facts.push(l.bedrooms === 0 ? "studio" : `${l.bedrooms} bed`);
  if (l.availableFrom) facts.push(`available ${formatDate(l.availableFrom)}`);
  if (l.postedAt) facts.push(`posted ${formatDate(l.postedAt)}`);
  if (facts.length) lines.push(facts.join(" · "));
  if (l.snippet) lines.push(l.snippet.length > 200 ? `${l.snippet.slice(0, 197)}...` : l.snippet);
  if (l.scamFlags.length)
    lines.push(`Heads up: ${l.scamFlags.map((f) => SCAM_FLAG_LABELS[f as ScamFlag] ?? f).join("; ")}.`);
  if (l.contact.phone) lines.push(`Phone on the listing: ${l.contact.phone}`);
  lines.push(l.url);
  lines.push(
    `Say "save ${l.rank ?? ""}" to shortlist it or "skip ${l.rank ?? ""}" to drop it.`.replace(/\s+"/g, ' "'),
  );
  return lines.join("\n");
}

export function kindLabel(kind: ListingKind): string {
  return kind === "storage" ? "storage units" : `${kind}s`;
}
