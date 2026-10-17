import type { ListingKind, ListingQuery, SiteResult } from "./domain.ts";
import { FIXTURES } from "./fixtures.ts";
import { RECIPES } from "./recipes/index.ts";
import type { ListingSource, SearchOpts, SearchOutcome, SiteRun } from "./types.ts";

export interface FakeListingsOptions {
  fixtures?: SiteResult[];
  /** Simulated search time, so tests can see the ack land before the results. */
  delayMs?: number;
  /** Reject the whole search (a browser that would not open). */
  failWith?: Error;
  /** Sites whose runs fail; their fixtures are dropped. */
  failSites?: string[];
}

const HOUSING: ListingKind[] = ["room", "sublet", "apartment"];

function labelOf(site: string): string {
  return RECIPES.find((r) => r.site === site)?.label ?? site;
}

/** Fixture-backed source for tests and the demo. Filters like a real search would, roughly. */
export class FakeListings implements ListingSource {
  readonly name = "fake";
  /** Every query list this source was asked to search. */
  calls: ListingQuery[][] = [];
  private readonly fixtures: SiteResult[];

  constructor(private readonly opts: FakeListingsOptions = {}) {
    this.fixtures = opts.fixtures ?? FIXTURES;
  }

  sitesFor(kind: ListingKind): string[] {
    return [...new Set(this.fixtures.filter((f) => f.kind === kind).map((f) => labelOf(f.site)))];
  }

  async search(queries: ListingQuery[], _opts: SearchOpts): Promise<SearchOutcome> {
    this.calls.push(queries);
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (this.opts.failWith) throw this.opts.failWith;
    const results: SiteResult[] = [];
    const runs: SiteRun[] = [];
    for (const q of queries) {
      const matched = this.fixtures.filter((f) => matches(f, q));
      const sites = new Set(this.fixtures.filter((f) => f.kind === q.kind).map((f) => f.site));
      for (const site of sites) {
        if (this.opts.failSites?.includes(site)) {
          runs.push({ site, kind: q.kind, status: "failed", count: 0, ms: 1, error: "fake failure" });
          continue;
        }
        const mine = matched.filter((f) => f.site === site);
        results.push(...mine);
        runs.push({ site, kind: q.kind, status: "ok", count: mine.length, ms: 1 });
      }
    }
    return { results, runs };
  }
}

function matches(f: SiteResult, q: ListingQuery): boolean {
  if (f.kind !== q.kind) return false;
  if (q.budgetMaxCents != null && f.priceCents != null && f.priceCents > q.budgetMaxCents * 1.15)
    return false;
  if (HOUSING.includes(q.kind) && q.neighborhoods.length) {
    const loc = (f.location ?? "").toLowerCase();
    if (!q.neighborhoods.some((n) => loc.includes(n.toLowerCase()))) return false;
  }
  return true;
}
