import { describe, expect, test } from "bun:test";
import { createLogger } from "@elves/shared";
import {
  type BrowserConfig,
  type BrowserOpener,
  type BrowserSession,
  type ListingQuery,
  type PageLike,
  RECIPES,
  type SiteExtraction,
  StagehandListings,
} from "../src/index.ts";

const log = createLogger("test", "error");
const config: BrowserConfig = { mode: "local", model: { modelName: "anthropic/x", apiKey: "k" } };
const room: ListingQuery = {
  kind: "room",
  city: "Boston, MA",
  neighborhoods: ["Allston"],
  budgetMaxCents: 120000,
  priceUnit: "month",
  moveIn: "2026-06-01",
  moveOut: "2026-08-30",
  bedrooms: null,
  furnished: null,
  mustHaves: [],
};

function listing(site: string, i: number): SiteExtraction["listings"][number] {
  const url =
    site === "craigslist"
      ? `https://boston.craigslist.org/gbs/roo/d/x/${i}.html`
      : site === "airbnb"
        ? `https://www.airbnb.com/rooms/${i}`
        : `https://www.facebook.com/marketplace/item/${i}`;
  return {
    title: `${site} room ${i}`,
    url,
    priceText: "$1,000",
    priceBasis: "month",
    location: "Allston",
    availableFrom: null,
    bedrooms: null,
    snippet: null,
    postedAt: null,
    photoCount: 1,
    contactPhone: null,
    contactEmail: null,
  };
}

interface FakeBrowserOptions {
  /** site -> behaviour */
  behave?: Record<string, "ok" | "throw" | "hang" | "block">;
  openFails?: boolean;
  delayMs?: number;
}

function siteOf(url: string): string {
  const host = new URL(url).hostname;
  return RECIPES.find((r) => r.hosts.some((h) => host === h || host.endsWith(`.${h}`)))?.site ?? host;
}

/** A browser that answers from the URL it was asked to open. */
function fakeBrowser(o: FakeBrowserOptions = {}) {
  const state = { opened: 0, closed: 0, pagesClosed: 0, inflight: 0, maxInflight: 0, acts: [] as string[] };
  const open: BrowserOpener = async () => {
    if (o.openFails) throw new Error("no browser");
    state.opened++;
    const session: BrowserSession = {
      sessionId: "s1",
      async newPage(url) {
        const page: PageLike & { site: string } = {
          site: siteOf(url),
          url: () => url,
          close: async () => {
            state.pagesClosed++;
          },
        };
        return page;
      },
      async act(instruction) {
        state.acts.push(instruction);
      },
      async waitFor() {
        return true;
      },
      async dismiss() {},
      async linkMap() {
        return { "1-778": "https://boston.craigslist.org/gbs/roo/d/x/778.html" };
      },
      async title(page) {
        const site = (page as PageLike & { site: string }).site;
        return o.behave?.[site] === "block" ? "Access Denied" : `${site} results`;
      },
      async extract(_instruction, schema, opts) {
        const site = (opts.page as PageLike & { site: string }).site;
        state.inflight++;
        state.maxInflight = Math.max(state.maxInflight, state.inflight);
        try {
          const mode = o.behave?.[site] ?? "ok";
          if (mode === "hang") await new Promise(() => {});
          if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
          if (mode === "throw") throw new Error(`${site} exploded`);
          if (mode === "block") return schema.parse({ listings: [] });
          return schema.parse({ listings: [listing(site, 1), listing(site, 2)] });
        } finally {
          state.inflight--;
        }
      },
      async close() {
        state.closed++;
      },
    };
    return session;
  };
  return { open, state };
}

const opts = () => ({ signal: new AbortController().signal, log });

describe("StagehandListings", () => {
  test("searches every planned site in one session and closes it", async () => {
    const { open, state } = fakeBrowser();
    const src = new StagehandListings({ config, open, sites: null, log });
    const out = await src.search([room], opts());
    expect(state.opened).toBe(1);
    expect(state.closed).toBe(1);
    expect(state.pagesClosed).toBe(2);
    expect(out.runs.filter((r) => r.status === "ok").map((r) => r.site)).toEqual(["craigslist", "airbnb"]);
    expect(out.runs.find((r) => r.site === "facebook")?.status).toBe("skipped");
    expect(out.results).toHaveLength(4);
    expect(out.results[0]?.site).toBe("craigslist");
    expect(state.acts).toEqual([]); // no recipe on this path has an LLM prepare step
  });
  test("a site that throws is one failed run; the others still come back", async () => {
    const { open } = fakeBrowser({ behave: { craigslist: "throw" } });
    const out = await new StagehandListings({ config, open, sites: null, log }).search([room], opts());
    expect(out.runs.find((r) => r.site === "craigslist")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("exploded"),
    });
    expect(out.runs.find((r) => r.site === "airbnb")?.status).toBe("ok");
    expect(out.results.every((r) => r.site === "airbnb")).toBe(true);
  });
  test("an anti-bot page with nothing to extract is a failed run, not an empty one", async () => {
    const { open } = fakeBrowser({ behave: { craigslist: "block" } });
    const out = await new StagehandListings({ config, open, sites: null, log }).search([room], opts());
    expect(out.runs.find((r) => r.site === "craigslist")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("blocked"),
    });
    expect(out.runs.find((r) => r.site === "airbnb")?.status).toBe("ok");
  });
  test("a hanging site times out within the per-site budget and the session still closes", async () => {
    const { open, state } = fakeBrowser({ behave: { craigslist: "hang" } });
    const src = new StagehandListings({ config, open, sites: null, log, perSiteTimeoutMs: 50 });
    const t0 = Date.now();
    const out = await src.search([room], opts());
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.runs.find((r) => r.site === "craigslist")?.status).toBe("timeout");
    expect(out.runs.find((r) => r.site === "airbnb")?.status).toBe("ok");
    expect(state.closed).toBe(1);
  });
  test("the concurrency cap holds", async () => {
    const { open, state } = fakeBrowser({ delayMs: 20 });
    const src = new StagehandListings({ config, open, sites: null, log, concurrency: 1 });
    await src.search([room, { ...room, kind: "sublet" }], opts());
    expect(state.maxInflight).toBe(1);
    const wide = fakeBrowser({ delayMs: 20 });
    await new StagehandListings({ config, open: wide.open, sites: null, log, concurrency: 3 }).search(
      [room, { ...room, kind: "sublet" }],
      opts(),
    );
    expect(wide.state.maxInflight).toBeGreaterThan(1);
  });
  test("a browser that will not open fails every run without throwing", async () => {
    const { open } = fakeBrowser({ openFails: true });
    const out = await new StagehandListings({ config, open, sites: null, log }).search([room], opts());
    expect(out.results).toEqual([]);
    expect(out.runs.filter((r) => r.status === "failed")).toHaveLength(2);
  });
  test("login sites run only with a context id, and sitesFor says so", async () => {
    const { open } = fakeBrowser();
    const anon = new StagehandListings({ config, open, sites: null, log });
    expect(anon.sitesFor("room")).toEqual(["Craigslist", "Airbnb"]);
    const logged = new StagehandListings({
      config: {
        ...config,
        mode: "browserbase",
        browserbase: { apiKey: "a", projectId: "p", contextId: "ctx", proxies: true },
      },
      open,
      sites: null,
      log,
    });
    expect(logged.sitesFor("room")).toEqual(["Craigslist", "Facebook Marketplace", "Airbnb"]);
    const out = await logged.search([room], opts());
    expect(out.runs.find((r) => r.site === "facebook")?.status).toBe("ok");
  });
  test("abort stops the sites that have not started", async () => {
    const { open } = fakeBrowser({ delayMs: 30 });
    const ctrl = new AbortController();
    const src = new StagehandListings({ config, open, sites: null, log, concurrency: 1 });
    setTimeout(() => ctrl.abort(), 10);
    const out = await src.search([room, { ...room, kind: "sublet" }], { signal: ctrl.signal, log });
    expect(out.runs.some((r) => r.status === "timeout")).toBe(true);
  });
  test("a repeated search URL is served from the cache", async () => {
    const { open, state } = fakeBrowser();
    const src = new StagehandListings({ config, open, sites: ["craigslist"], log });
    await src.search([room], opts());
    const again = await src.search([room], opts());
    expect(state.opened).toBe(1);
    expect(again.runs.find((r) => r.site === "craigslist")).toMatchObject({
      status: "ok",
      cached: true,
      count: 2,
    });
  });
});
