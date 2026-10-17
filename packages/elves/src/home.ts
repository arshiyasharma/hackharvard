import { openDeal } from "@elves/engine";
import { dedupeResults, isHardFlagged, type ListingSource, type ScamFlag, scamFlags } from "@elves/listings";
import type { HousingSearch, Listing, ListingKind, ListingQuery, SiteResult } from "@elves/shared";
import {
  batchText,
  type Elf,
  type ElfContext,
  type ElfResult,
  lastMessageId,
  memoryPreamble,
} from "./contract.ts";
import { handleCounterparty, handleOwnerDecision } from "./deal.ts";
import { formatDate } from "./facts.ts";
import {
  emptySearch,
  extractHousingHeuristic,
  HOUSING_KINDS,
  HousingRequirements,
  type MissingRequirement,
  mergeSearch,
  missingRequirement,
  queriesFor,
  searchKey,
} from "./home-facts.ts";
import { extractListingUrls, type FollowUp, parseFollowUp, wantsFreshSearch } from "./home-followups.ts";
import {
  type Candidate,
  describeAsk,
  fmtPrice,
  formatDetail,
  formatPicks,
  rankListings,
} from "./home-rank.ts";
import { handleSubletOut } from "./home-sublet.ts";
import { pickSkill, type Skill, skillReply } from "./stubs.ts";

export const LEASE_SKILL: Skill = {
  id: "lease",
  keywords: [
    "lease",
    "sublease",
    "landlord",
    "clause",
    "notice",
    "security deposit",
    "agreement",
    "contract",
    "tenant",
  ],
  task: "Waiting for the lease",
  reply:
    "Home Elf here. Send the lease PDF and I'll tell you whether you can sublet, quote the clauses, and draft the landlord notice.",
};

export const HUNT_SKILL: Skill = {
  id: "hunt",
  keywords: [
    "find a sublet",
    "find me a place",
    "looking for a room",
    "need a place",
    "apartment",
    "studio",
    "sublet",
    "room",
    "housing",
    "listings",
    "budget",
    "neighborhood",
    "room for",
    "rent in",
    "allston",
    "brighton",
    "brookline",
    "cambridge",
    "somerville",
  ],
  task: "Collecting requirements",
  reply:
    "Home Elf here. Tell me budget, dates and neighborhoods, and forward any listings you find; I'll rank them and flag anything that smells like a scam.",
};

export const MOVEIN_SKILL: Skill = {
  id: "movein",
  keywords: [
    "move-in",
    "move in",
    "utilities",
    "internet",
    "wifi",
    "address change",
    "insurance",
    "hotel",
    "luggage",
    "airbnb",
    "electric",
    "gas bill",
  ],
  task: "Building the move-in checklist",
  reply:
    "Home Elf here. Give me your move-in date and new address and I'll line up utilities, internet, address change and a place for your bags in the gap.",
};

/** A repeat of the same ask inside this window re-sends the picks instead of searching again. */
const SEARCH_WINDOW_MS = 3 * 60_000;
const PAGE = 3;

const ASK_SYSTEM = `You are the Home Elf of Elves, a moving crew the owner texts. You find them a place to live (a room, a sublet or an apartment), a hotel for the gap between leases, and storage.

Write the reply as a text message:
- Plain text, 2 short lines, no markdown, no bullet symbols, at most one emoji (usually none).
- Line 1 confirms what you captured this turn in the owner's own words (what, where, budget, dates). Skip it if nothing new was captured.
- Line 2 asks for exactly ONE thing, the one named in facts.ask: budget = the most they'd pay per month; area = which neighborhoods or city; dates = when they need the place from and until.
- Never ask for something facts.search already has. Never promise to post anywhere or contact anyone.`;

export const homeElf: Elf = {
  name: "home",
  description:
    "Housing on both ends: finding the owner a room, sublet or apartment (budget, neighborhoods, dates, listings they found), a hotel for the gap between leases, storage units; the current lease, subletting it out, landlord notices, security deposit; move-in week (utilities, internet, address change, renters insurance)",
  keywords: [...LEASE_SKILL.keywords, ...HUNT_SKILL.keywords, ...MOVEIN_SKILL.keywords],

  async handle(ctx: ElfContext): Promise<ElfResult> {
    // Sublet applicants and listers talk to the Deal Engine in their own space.
    if (ctx.participant.role !== "owner") return handleCounterparty(ctx);
    const decided = await handleOwnerDecision(ctx);
    if (decided) return decided;
    const text = batchText(ctx.batch);
    const parent = lastMessageId(ctx.batch);
    const subletOut = await handleSubletOut(ctx, text, parent);
    if (subletOut) return subletOut;
    const now = ctx.now();
    const saved = await ctx.store.getSearch(ctx.move.id);
    const listings = await ctx.store.listListings(ctx.move.id);

    const fu = parseFollowUp(text);
    if (fu && listings.some((l) => l.rank != null))
      return followUp(ctx, fu, saved ?? emptySearch(ctx.move.id, now), listings, parent);

    const heuristic = extractHousingHeuristic(text, now);
    const { skill } = pickSkill(text, [HUNT_SKILL, LEASE_SKILL, MOVEIN_SKILL]);
    const hasHousingFacts =
      heuristic.kinds.length > 0 ||
      heuristic.neighborhoods.length > 0 ||
      heuristic.budgetMaxUsd != null ||
      heuristic.moveIn != null;
    if (skill.id !== "hunt" && !(saved && hasHousingFacts)) return skillReply(ctx, "home", skill);

    let reqs = heuristic;
    if (ctx.llm.name !== "fake") {
      try {
        const llm = await ctx.llm.extract(HousingRequirements, {
          system:
            `Extract housing requirements from an owner's text messages to a moving crew. Today is ${now.toISOString().slice(0, 10)}. ` +
            "Resolve relative dates to ISO dates. Boston-area neighborhoods are common (Allston, Brighton, Cambridge, Somerville, Brookline, Fenway). " +
            "Only include what the owner actually said; use null or empty lists when unknown.",
          user: `${memoryPreamble(ctx.conversation)}\n\nOwner's latest message(s):\n"""${text}"""`,
        });
        reqs = {
          ...llm,
          kinds: llm.kinds.length ? llm.kinds : heuristic.kinds,
          city: llm.city ?? heuristic.city,
          neighborhoods: llm.neighborhoods.length ? llm.neighborhoods : heuristic.neighborhoods,
          budgetMaxUsd: llm.budgetMaxUsd ?? heuristic.budgetMaxUsd,
          hotelNightlyMaxUsd: llm.hotelNightlyMaxUsd ?? heuristic.hotelNightlyMaxUsd,
          moveIn: llm.moveIn ?? heuristic.moveIn,
          moveOut: llm.moveOut ?? heuristic.moveOut,
          bedrooms: llm.bedrooms ?? heuristic.bedrooms,
          furnished: llm.furnished ?? heuristic.furnished,
          mustHaves: llm.mustHaves.length ? llm.mustHaves : heuristic.mustHaves,
        };
      } catch (err) {
        ctx.log.warn("housing extraction failed; using heuristic", { error: String(err) });
      }
    }

    let search = mergeSearch(saved, reqs, ctx.move, now);
    for (const url of extractListingUrls(text)) {
      const tag = `link:${url}`;
      if (!search.notes.includes(tag)) search = { ...search, notes: [...search.notes, tag] };
    }
    await ctx.store.saveSearch(search);
    const events: NonNullable<ElfResult["events"]> = [
      {
        type: "housing.requirements_updated",
        payload: {
          kinds: search.kinds,
          city: search.city,
          neighborhoods: search.neighborhoods,
          budgetMaxCents: search.budgetMaxCents,
          moveIn: search.moveIn,
          moveOut: search.moveOut,
        },
      },
    ];
    const movePatch: ElfResult["movePatch"] = {};
    if (search.moveIn && !ctx.move.moveInAt && search.kinds.some((k) => HOUSING_KINDS.includes(k)))
      movePatch.moveInAt = search.moveIn;

    const missing = missingRequirement(search);
    if (missing) {
      const reply = await draftAsk(ctx, search, missing, reqs);
      return {
        replies: [{ text: reply, parentMessageId: parent }],
        events,
        movePatch,
        boardPatch: {
          status: "waiting",
          currentTask: `Collecting requirements: need ${missing}`,
          lastUpdate: describeAsk(search),
        },
      };
    }

    const queries = queriesFor(search, ctx.move);
    const key = searchKey(queries);
    const recent =
      saved?.lastSearchKey === key &&
      saved.lastSearchedAt != null &&
      now.getTime() - Date.parse(saved.lastSearchedAt) < SEARCH_WINDOW_MS;
    const ranked = listings.filter((l) => l.rank != null && l.status !== "rejected").sort(byRank);
    const refresh = wantsFreshSearch(text);
    const forwarded = forwardedResults(search, extractListingUrls(text));
    if (recent && ranked.length && !refresh && !forwarded.length) {
      return {
        replies: [
          {
            text: formatPicks(search, ranked.slice(0, PAGE), {
              skippedScams: 0,
              more: Math.max(0, ranked.length - PAGE),
              hotel: null,
              storage: null,
              intro: "Here's what I have so far:",
            }),
            parentMessageId: parent,
          },
        ],
        events,
        movePatch,
        boardPatch: { status: "working", currentTask: `Hunting: ${describeAsk(search)}` },
      };
    }

    const labels = [...new Set(queries.flatMap((q) => ctx.listings.sitesFor(q.kind)))];
    const extras = forwardedResults(search, rememberedLinks(search));
    const addOnly = forwarded.length > 0 && ranked.length > 0 && !refresh;
    events.push({
      type: "housing.search_started",
      payload: { sites: addOnly ? [] : labels, kinds: queries.map((q) => q.kind), key },
    });
    return {
      replies: [
        {
          text: addOnly
            ? `Adding the listing you sent to ${describeAsk(search)}.`
            : ackText(search, queries, labels),
          parentMessageId: parent,
        },
      ],
      events,
      movePatch,
      boardPatch: {
        status: "working",
        currentTask: `Searching: ${describeAsk(search)}`,
        lastUpdate: labels.length ? `Checking ${labels.join(", ")}` : "No sites available for this search",
      },
      later: () => runSearch(ctx, search, queries, key, labels, parent, { extras, skipFetch: addOnly }),
    };
  },
};

function byRank(a: Listing, b: Listing): number {
  return (a.rank ?? 99) - (b.rank ?? 99);
}

function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function ackText(search: HousingSearch, queries: ListingQuery[], labels: string[]): string {
  const hotel = queries.find((q) => q.kind === "hotel");
  const storage = queries.some((q) => q.kind === "storage");
  const extras: string[] = [];
  if (hotel?.moveIn && hotel.moveOut && search.kinds.some((k) => HOUSING_KINDS.includes(k)))
    extras.push(`hotels for the ${formatDate(hotel.moveIn)} to ${formatDate(hotel.moveOut)} gap`);
  if (storage && search.kinds.some((k) => k !== "storage")) extras.push("storage");
  const where = labels.length ? `Checking ${listJoin(labels)} for ` : "Looking for ";
  return `On it. ${where}${describeAsk(search)}${extras.length ? ` and ${listJoin(extras)}` : ""}. Give me a minute or two.`;
}

async function draftAsk(
  ctx: ElfContext,
  search: HousingSearch,
  missing: MissingRequirement,
  reqs: HousingRequirements,
): Promise<string> {
  const template = templateAsk(search, missing, reqs);
  if (ctx.llm.name === "fake") return template;
  try {
    const facts = { ask: missing, search: describeAsk(search), capturedThisTurn: reqs, requirements: search };
    const reply = await ctx.llm.draft({
      system: ASK_SYSTEM,
      user: `${memoryPreamble(ctx.conversation)}\n\nFacts (JSON):\n${JSON.stringify(facts)}\n\nWrite the reply.`,
      maxTokens: 200,
    });
    return reply || template;
  } catch (err) {
    ctx.log.warn("home ask draft failed; using template", { error: String(err) });
    return template;
  }
}

function templateAsk(search: HousingSearch, missing: MissingRequirement, reqs: HousingRequirements): string {
  const captured =
    reqs.kinds.length || reqs.neighborhoods.length || reqs.budgetMaxUsd != null || reqs.moveIn || reqs.city;
  const held = search.notes.some((n) => n.startsWith("link:")) ? " I'll hold onto the link you sent." : "";
  const first = `${captured ? `Got it: ${describeAsk(search)}.` : "I can find you a place."}${held}`;
  const ask =
    missing === "budget"
      ? "What's the most you'd want to pay per month?"
      : missing === "area"
        ? "Which neighborhoods, or which city?"
        : search.kinds.includes("hotel") && !search.kinds.some((k) => HOUSING_KINDS.includes(k))
          ? "Which nights do you need?"
          : "When do you need it from, and until when?";
  return `${first}\n${ask}`;
}

const LINK_PREFIX = "link:";

function rememberedLinks(search: HousingSearch): string[] {
  return search.notes.filter((n) => n.startsWith(LINK_PREFIX)).map((n) => n.slice(LINK_PREFIX.length));
}

function siteOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
  if (host.includes("craigslist")) return "craigslist";
  if (host.includes("airbnb")) return "airbnb";
  if (host.includes("apartments.com")) return "apartments";
  if (host.includes("zillow")) return "zillow";
  if (host.includes("booking.com")) return "booking";
  if (host.includes("facebook") || host === "fb.com") return "facebook";
  if (host.includes("sparefoot")) return "sparefoot";
  return host.split(".")[0] || "link";
}

function titleFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean);
    for (const part of [...last].reverse()) {
      const words = part
        .replace(/\.[a-z0-9]{2,4}$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\b\d{4,}\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (/[a-z]/i.test(words) && words.length >= 8) return words.charAt(0).toUpperCase() + words.slice(1);
    }
  } catch {
    // a bad URL still becomes a listing the owner can see
  }
  return "Listing you sent";
}

/** A link the owner forwarded, with no price invented. Ranked beside what the sites returned. */
function forwardedResults(search: HousingSearch, urls: string[]): SiteResult[] {
  const kind = search.kinds.find((k) => HOUSING_KINDS.includes(k)) ?? search.kinds[0] ?? "room";
  return urls.map((url) => ({
    site: siteOf(url),
    kind,
    url,
    title: titleFromUrl(url),
    priceCents: null,
    priceUnit: kind === "hotel" ? "night" : "month",
    location: search.neighborhoods[0] ?? null,
    availableFrom: null,
    bedrooms: null,
    snippet: "Forwarded by the owner.",
    postedAt: null,
    photoCount: null,
    contact: { phone: null, email: null, messageUrl: url },
  }));
}

/** The message the owner sends. Home drafts it and does not contact the lister. */
function draftOutreach(search: HousingSearch, listing: Listing): string {
  const when =
    search.moveIn && search.moveOut
      ? ` from ${formatDate(search.moveIn)} to ${formatDate(search.moveOut)}`
      : search.moveIn
        ? ` starting ${formatDate(search.moveIn)}`
        : "";
  const budget =
    search.budgetMaxCents != null
      ? ` My budget is ${fmtPrice(search.budgetMaxCents, "month").replace("/mo", "")} a month.`
      : "";
  return [
    `Saved ${listing.rank}: ${listing.title}.`,
    "You send this; I won't contact them:",
    `"Hi, I saw your listing for ${listing.title}${when}.${budget} Is it still available?"`,
    listing.url,
  ].join("\n");
}

async function runSearch(
  ctx: ElfContext,
  search: HousingSearch,
  queries: ListingQuery[],
  key: string,
  labels: string[],
  parent: string,
  opts: { extras?: SiteResult[]; skipFetch?: boolean } = {},
): Promise<Pick<ElfResult, "replies" | "boardPatch" | "events">> {
  const t0 = Date.now();
  const extras = opts.extras ?? [];
  let outcome: Awaited<ReturnType<ListingSource["search"]>>;
  try {
    if (opts.skipFetch) {
      const existing = await ctx.store.listListings(ctx.move.id);
      const seen = new Set(existing.map((l) => l.url));
      outcome = { results: [...existing, ...extras.filter((e) => !seen.has(e.url))], runs: [] };
    } else {
      outcome = await ctx.listings.search(queries, { signal: ctx.signal, log: ctx.log });
      const seen = new Set(outcome.results.map((r) => r.url));
      outcome.results.push(...extras.filter((e) => !seen.has(e.url)));
    }
  } catch (err) {
    ctx.log.error("housing search failed", { error: String(err) });
    return {
      replies: [
        {
          text: 'The search hit a snag on my end. Say "search again" and I\'ll give it another go.',
          parentMessageId: parent,
        },
      ],
      boardPatch: { status: "blocked", lastUpdate: `Search failed: ${String(err).slice(0, 120)}` },
      events: [{ type: "housing.search_failed", payload: { error: String(err) } }],
    };
  }

  const raw = outcome.results;
  const flagsByUrl = new Map<string, ScamFlag[]>(raw.map((r) => [r.url, scamFlags(r, raw)]));
  const deduped: Candidate[] = dedupeResults(raw).map((r) => ({
    result: r,
    flags: flagsByUrl.get(r.url) ?? [],
  }));
  const primaryKinds: ListingKind[] =
    !search.kinds.length || search.kinds.some((k) => HOUSING_KINDS.includes(k))
      ? HOUSING_KINDS
      : search.kinds.includes("hotel")
        ? ["hotel"]
        : ["storage"];
  const primary = deduped.filter((c) => primaryKinds.includes(c.result.kind));
  const secondary = deduped.filter((c) => !primaryKinds.includes(c.result.kind));
  const ranked = await rankListings(ctx, search, primary);
  const now = ctx.now().toISOString();

  // Ranks are positions in this ranking; anything ranked before is unranked first so numbers stay unique.
  const existing = await ctx.store.listListings(ctx.move.id);
  const existingByUrl = new Map(existing.map((l) => [l.url, l]));
  for (const l of existing) if (l.rank != null) await ctx.store.upsertListing({ ...l, rank: null });

  const keep = (r: SiteResult, extra: Partial<Listing>) =>
    ctx.store.upsertListing({ ...r, moveId: ctx.move.id, foundAt: now, ...extra });
  const picks: Listing[] = [];
  const scams = ranked.filter((r) => isHardFlagged(r.flags));
  let rank = 0;
  for (const r of ranked) {
    const hard = isHardFlagged(r.flags);
    const rejected = existingByUrl.get(r.result.url)?.status === "rejected";
    const extra = { scamFlags: r.flags, score: r.score, reason: r.reason };
    if (hard || rejected) {
      await keep(r.result, { ...extra, rank: null });
      continue;
    }
    rank++;
    picks.push(await keep(r.result, { ...extra, rank }));
  }
  const cheapest = (kind: ListingKind) =>
    secondary
      .filter((c) => c.result.kind === kind && !isHardFlagged(c.flags))
      .sort((a, b) => (a.result.priceCents ?? Infinity) - (b.result.priceCents ?? Infinity));
  let hotel: Listing | null = null;
  let storage: Listing | null = null;
  for (const c of secondary) {
    const row = await keep(c.result, { scamFlags: c.flags, rank: null, score: 0, reason: "" });
    if (c === cheapest("hotel")[0])
      hotel = { ...row, availableFrom: queries.find((q) => q.kind === "hotel")?.moveIn ?? null };
    if (c === cheapest("storage")[0]) storage = row;
  }

  const shown = picks.slice(0, PAGE);
  await ctx.store.saveSearch({
    ...search,
    lastSearchedAt: now,
    lastSearchKey: key,
    shownCount: shown.length,
  });

  const ms = Date.now() - t0;
  const events: NonNullable<ElfResult["events"]> = [
    {
      type: "housing.search_done",
      payload: {
        found: raw.length,
        deduped: deduped.length,
        flagged: scams.length,
        ranked: picks.length,
        runs: outcome.runs,
        ms,
      },
    },
  ];
  const ran = outcome.runs.filter((r) => r.status !== "skipped");
  const allFailed = ran.length > 0 && ran.every((r) => r.status === "failed" || r.status === "timeout");
  if (!picks.length && !hotel && !storage) {
    const text = allFailed
      ? `I couldn't reach ${listJoin(labels) || "the listing sites"} just now. Say "search again" in a bit and I'll retry.`
      : scams.length
        ? `Everything I found for ${describeAsk(search)} looked like a scam (${scams.length} skipped). Want me to widen the area or raise the budget?`
        : `Nothing matched yet for ${describeAsk(search)}${labels.length ? ` on ${listJoin(labels)}` : ""}. Want me to widen the area or raise the budget?`;
    return {
      replies: [{ text, parentMessageId: parent }],
      events,
      boardPatch: allFailed
        ? { status: "blocked", lastUpdate: "Every site failed; will retry on request" }
        : { status: "waiting", currentTask: `Hunting: ${describeAsk(search)}`, lastUpdate: "No matches yet" },
    };
  }
  const text = formatPicks(search, shown, {
    skippedScams: scams.length,
    more: picks.length - shown.length,
    hotel,
    storage,
  });
  return {
    replies: [{ text, parentMessageId: parent }],
    events,
    boardPatch: {
      status: "working",
      currentTask: `Hunting: ${describeAsk(search)}`,
      lastUpdate: `${shown.length} picks sent, ${picks.length - shown.length} more${scams.length ? `, ${scams.length} scams skipped` : ""}`,
    },
  };
}

async function followUp(
  ctx: ElfContext,
  fu: FollowUp,
  search: HousingSearch,
  listings: Listing[],
  parent: string,
): Promise<ElfResult> {
  const ranked = listings.filter((l) => l.rank != null).sort(byRank);
  const visible = ranked.filter((l) => l.status !== "rejected");
  const reply = (text: string, extra: Partial<ElfResult> = {}): ElfResult => ({
    replies: [{ text, parentMessageId: parent }],
    boardPatch: { status: "working", currentTask: `Hunting: ${describeAsk(search)}` },
    ...extra,
  });
  const find = (n: number) => ranked.find((l) => l.rank === n);
  const outOfRange = (n: number) =>
    reply(
      ranked.length
        ? `I don't have a pick ${n}; say a number from 1 to ${ranked.length}.`
        : "I haven't sent any picks yet. Tell me budget, area and dates and I'll search.",
    );

  if (fu.kind === "more") {
    const next = visible.filter((l) => (l.rank ?? 0) > search.shownCount).slice(0, PAGE);
    if (!next.length)
      return reply(
        `That's everything I found for ${describeAsk(search)}. Say "search again" to look once more, or give me another area and I'll widen it.`,
      );
    const lastRank = next[next.length - 1]?.rank ?? search.shownCount;
    await ctx.store.saveSearch({ ...search, shownCount: lastRank });
    const remaining = visible.filter((l) => (l.rank ?? 0) > lastRank).length;
    return reply(
      formatPicks(search, next, {
        skippedScams: 0,
        more: remaining,
        hotel: null,
        storage: null,
        intro: "Next up:",
      }),
      { boardPatch: { status: "working", lastUpdate: `${lastRank} picks sent, ${remaining} more` } },
    );
  }
  const target = find(fu.n);
  if (!target) return outOfRange(fu.n);
  if (fu.kind === "detail") return reply(formatDetail(target));
  if (fu.kind === "skip") {
    await ctx.store.upsertListing({ ...target, status: "rejected" });
    const next = visible.find((l) => (l.rank ?? 0) > search.shownCount && l.rank !== fu.n);
    const lines = [`Skipped ${fu.n} (${target.title}).`];
    if (next) {
      await ctx.store.saveSearch({ ...search, shownCount: next.rank ?? search.shownCount });
      lines.push(
        formatPicks(search, [next], {
          skippedScams: 0,
          more: 0,
          hotel: null,
          storage: null,
          intro: "Next up:",
        }),
      );
    }
    return reply(lines.join("\n"), {
      events: [{ type: "housing.listing_rejected", payload: { listingId: target.id, rank: fu.n } }],
    });
  }
  if (fu.kind === "reach") {
    await ctx.store.upsertListing({ ...target, status: "shortlisted" });
    const cents = search.budgetMaxCents ?? target.priceCents;
    const deal = await openDeal(ctx.store, {
      moveId: ctx.move.id,
      mode: "find_sublet",
      subjectId: null,
      title: target.title,
      askCents: target.priceCents,
      limitCents: cents,
    });
    return reply(
      `${draftOutreach(search, target)}\nRef ${deal.code}. When they text this number with that ref, I'll negotiate${cents != null ? ` up to ${fmtPrice(cents, "month")}` : ""}. I still won't message them myself.`,
      {
        events: [
          { type: "housing.listing_shortlisted", payload: { listingId: target.id, rank: fu.n } },
          { type: "deal.opened", payload: { dealId: deal.id, mode: "find_sublet", code: deal.code } },
        ],
        boardPatch: { status: "working", lastUpdate: `Sublet: ${target.title} (ref ${deal.code})` },
      },
    );
  }
  await ctx.store.upsertListing({ ...target, status: "shortlisted" });
  return reply(draftOutreach(search, target), {
    events: [{ type: "housing.listing_shortlisted", payload: { listingId: target.id, rank: fu.n } }],
    boardPatch: { status: "working", lastUpdate: `Shortlisted: ${target.title}` },
  });
}
