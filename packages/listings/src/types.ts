import type { Logger } from "@elves/shared";
import type { ListingKind, ListingQuery, SiteResult } from "./domain.ts";

export interface SearchOpts {
  signal: AbortSignal;
  log: Logger;
  perSiteTimeoutMs?: number;
  concurrency?: number;
}

export type SiteRunStatus = "ok" | "failed" | "timeout" | "skipped";

/** What happened on one site for one query; the owner never sees these, the logs and events do. */
export interface SiteRun {
  site: string;
  kind: ListingKind;
  status: SiteRunStatus;
  count: number;
  ms: number;
  cached?: boolean;
  error?: string;
}

export interface SearchOutcome {
  results: SiteResult[];
  runs: SiteRun[];
}

/**
 * Where listings come from. One call covers every query (one browser session); a site that fails lands in
 * `runs` with its error and never rejects the whole search.
 */
export interface ListingSource {
  /** "fake" | "stagehand:local" | "stagehand:browserbase" */
  readonly name: string;
  /** Human labels of the sites that would be searched for this kind, for the "checking Craigslist, ..." ack. */
  sitesFor(kind: ListingKind): string[];
  search(queries: ListingQuery[], opts: SearchOpts): Promise<SearchOutcome>;
}
