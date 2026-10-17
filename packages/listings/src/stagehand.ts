import { createLogger, type Logger } from "@elves/shared";
import {
  BLOCK_PAGE_TITLE,
  type BrowserConfig,
  type BrowserOpener,
  type BrowserSession,
  openStagehandBrowser,
} from "./browser.ts";
import type { ListingKind, ListingQuery, SiteResult } from "./domain.ts";
import {
  type PlannedSearch,
  recipesFor,
  resolveNodeUrls,
  SiteExtraction,
  type SiteRecipe,
  toResults,
} from "./recipe.ts";
import { RECIPES } from "./recipes/index.ts";
import type { ListingSource, SearchOpts, SearchOutcome, SiteRun } from "./types.ts";

export interface StagehandListingsOptions {
  config: BrowserConfig;
  recipes?: SiteRecipe[];
  /** Injected in tests; defaults to the real Stagehand opener. */
  open?: BrowserOpener;
  /** Site allowlist; null = every recipe. */
  sites?: string[] | null;
  perSiteTimeoutMs?: number;
  totalTimeoutMs?: number;
  concurrency?: number;
  /** Same search URL within this window is served from memory. */
  cacheTtlMs?: number;
  log?: Logger;
  now?: () => number;
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}
class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError(ms));
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new AbortedError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

/** One signal that fires when either input fires or the total budget runs out. */
function combinedSignal(outer: AbortSignal, totalMs: number): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (outer.aborted) ctrl.abort();
  else outer.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), totalMs);
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      outer.removeEventListener("abort", onAbort);
    },
  };
}

async function pool<T>(
  items: T[],
  size: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i] as T, i);
    }
  });
  await Promise.all(workers);
}

/**
 * Runs every planned (site, query) pair in one browser session, one page per site, a few at a time. A site
 * that throws, hangs or returns junk is one failed run; the others still come back.
 */
export class StagehandListings implements ListingSource {
  readonly name: string;
  private readonly recipes: SiteRecipe[];
  private readonly open: BrowserOpener;
  private readonly sites: string[] | null;
  private readonly perSiteTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly concurrency: number;
  private readonly cacheTtlMs: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; results: SiteResult[] }>();

  constructor(private readonly opts: StagehandListingsOptions) {
    this.name = `stagehand:${opts.config.mode}`;
    this.recipes = opts.recipes ?? RECIPES;
    this.open = opts.open ?? openStagehandBrowser;
    this.sites = opts.sites === undefined ? null : opts.sites;
    this.perSiteTimeoutMs = opts.perSiteTimeoutMs ?? 45_000;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? 120_000;
    this.concurrency = opts.concurrency ?? 2;
    this.cacheTtlMs = opts.cacheTtlMs ?? 30 * 60_000;
    this.log = opts.log ?? createLogger("listings");
    this.now = opts.now ?? Date.now;
  }

  private get loggedIn(): boolean {
    return !!this.opts.config.browserbase?.contextId;
  }

  sitesFor(kind: ListingKind): string[] {
    return this.recipes
      .filter((r) => r.kinds.includes(kind))
      .filter((r) => !this.sites || this.sites.includes(r.site))
      .filter((r) => !r.needsLogin || this.loggedIn)
      .map((r) => r.label);
  }

  async search(queries: ListingQuery[], opts: SearchOpts): Promise<SearchOutcome> {
    const plan = recipesFor(queries, { loggedIn: this.loggedIn, sites: this.sites }, this.recipes);
    const runs: SiteRun[] = plan.skipped.map((s) => ({
      site: s.site,
      kind: s.kind,
      status: "skipped",
      count: 0,
      ms: 0,
      error: s.reason,
    }));
    const perIndex: SiteResult[][] = plan.planned.map(() => []);
    const todo: { p: PlannedSearch; i: number }[] = [];
    plan.planned.forEach((p, i) => {
      const hit = this.cache.get(p.url);
      if (hit && this.now() - hit.at < this.cacheTtlMs) {
        perIndex[i] = hit.results;
        runs.push({
          site: p.recipe.site,
          kind: p.query.kind,
          status: "ok",
          count: hit.results.length,
          ms: 0,
          cached: true,
        });
      } else todo.push({ p, i });
    });
    if (todo.length) {
      let session: BrowserSession | null = null;
      try {
        session = await this.open(this.opts.config, this.log);
      } catch (err) {
        this.log.error("browser failed to open", { error: String(err) });
        for (const { p } of todo)
          runs.push({
            site: p.recipe.site,
            kind: p.query.kind,
            status: "failed",
            count: 0,
            ms: 0,
            error: String(err),
          });
      }
      if (session) {
        const { signal, dispose } = combinedSignal(opts.signal, this.totalTimeoutMs);
        const perSite = opts.perSiteTimeoutMs ?? this.perSiteTimeoutMs;
        try {
          await pool(todo, opts.concurrency ?? this.concurrency, async ({ p, i }) => {
            const t0 = this.now();
            if (signal.aborted) {
              runs.push({
                site: p.recipe.site,
                kind: p.query.kind,
                status: "timeout",
                count: 0,
                ms: 0,
                error: "not started",
              });
              return;
            }
            try {
              const results = await withTimeout(
                this.runSite(session as BrowserSession, p, perSite),
                perSite,
                signal,
              );
              perIndex[i] = results;
              this.cache.set(p.url, { at: this.now(), results });
              runs.push({
                site: p.recipe.site,
                kind: p.query.kind,
                status: "ok",
                count: results.length,
                ms: this.now() - t0,
              });
            } catch (err) {
              const status =
                err instanceof TimeoutError || err instanceof AbortedError ? "timeout" : "failed";
              this.log.warn("site search failed", {
                site: p.recipe.site,
                url: p.url,
                status,
                error: String(err),
              });
              runs.push({
                site: p.recipe.site,
                kind: p.query.kind,
                status,
                count: 0,
                ms: this.now() - t0,
                error: String(err),
              });
            }
          });
        } finally {
          dispose();
          await session.close().catch((err) => this.log.warn("session close failed", { error: String(err) }));
        }
      }
    }
    return { results: perIndex.flat(), runs };
  }

  private async runSite(session: BrowserSession, p: PlannedSearch, timeoutMs: number): Promise<SiteResult[]> {
    const page = await session.newPage(p.url);
    try {
      // Modals open a beat after load, so dismiss once the results have settled, then let the page re-render.
      const ready = await session.waitFor(page, {
        selector: p.recipe.locator,
        settleMs: 750,
        timeoutMs: Math.min(10_000, timeoutMs),
      });
      await session.dismiss(page);
      if (!ready)
        this.log.debug("results container not found; extracting the whole page", { site: p.recipe.site });
      for (const step of p.recipe.prepare?.(p.query) ?? []) {
        try {
          await session.act(step, { page, timeoutMs: Math.min(15_000, timeoutMs) });
        } catch (err) {
          this.log.debug("prepare step skipped", { site: p.recipe.site, step, error: String(err) });
        }
      }
      const raw = await session.extract(p.recipe.instruction(p.query), SiteExtraction, {
        page,
        timeoutMs,
        locator: ready ? p.recipe.locator : undefined,
      });
      // The model points at links by node id; the snapshot knows their hrefs.
      const needsLinks =
        Array.isArray(raw?.listings) && raw.listings.some((l) => !/^https?:\/\//i.test(l?.url ?? ""));
      const data = needsLinks ? resolveNodeUrls(raw, await session.linkMap(page)) : raw;
      const results = toResults(p.recipe, p.query, data, p.url);
      if (!results.length) {
        const title = await session.title(page);
        if (BLOCK_PAGE_TITLE.test(title)) throw new Error(`blocked: "${title.trim()}"`);
      }
      return results;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
