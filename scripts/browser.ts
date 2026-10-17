/**
 * Operator CLI for the housing-search browser.
 *
 *   bun run browser sites  [--kind room --area allston --max 1200 --in 2026-06-01 --out 2026-08-30]
 *       print the URL every recipe would open for the query (no browser)
 *   bun run browser search [same flags]
 *       run a real search through Stagehand (ELVES_BROWSER=local|browserbase) and print the runs + results
 *   bun run browser login  [--site facebook]
 *       open a Browserbase session on a persistent context, print its live-view URL so the owner can log in,
 *       then print the BROWSERBASE_CONTEXT_ID to set
 */
import {
  createListings,
  type ListingKind,
  type ListingQuery,
  loadBrowserbaseSdk,
  loadListingsConfig,
  loadStagehand,
  RECIPES,
  recipesFor,
} from "@elves/listings";
import { createLogger } from "@elves/shared";

const log = createLogger("browser");
const [cmd = "help", ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function queryFromFlags(): ListingQuery {
  const kind = (flag("kind") ?? "room") as ListingKind;
  const area = flag("area");
  const max = flag("max");
  return {
    kind,
    city: flag("city") ?? "Boston, MA",
    neighborhoods: area ? area.split(",").map((a) => a.trim().replace(/\b\w/g, (c) => c.toUpperCase())) : [],
    budgetMaxCents: max ? Number(max) * 100 : null,
    priceUnit: kind === "hotel" ? "night" : "month",
    moveIn: flag("in") ?? "2026-06-01",
    moveOut: flag("out") ?? "2026-08-30",
    bedrooms: flag("beds") ? Number(flag("beds")) : null,
    furnished: null,
    mustHaves: [],
  };
}

async function sites() {
  const q = queryFromFlags();
  const { planned, skipped } = recipesFor([q], { loggedIn: true, sites: null }, RECIPES);
  for (const p of planned) console.log(`${p.recipe.site.padEnd(11)} ${p.url}`);
  for (const s of skipped) console.log(`${s.site.padEnd(11)} (skipped: ${s.reason})`);
}

async function search() {
  const cfg = loadListingsConfig();
  if (cfg.source === "fake") {
    console.error(`Not running a real search: ${cfg.reason}. Set ELVES_BROWSER=local or browserbase.`);
    process.exit(1);
  }
  const q = queryFromFlags();
  const src = createListings(process.env, log);
  console.log(`source ${src.name}; sites for ${q.kind}: ${src.sitesFor(q.kind).join(", ")}`);
  const t0 = Date.now();
  const out = await src.search([q], { signal: new AbortController().signal, log });
  console.log(`\n${out.runs.length} runs in ${Date.now() - t0}ms`);
  for (const r of out.runs)
    console.log(
      `  ${r.site.padEnd(11)} ${r.status.padEnd(8)} ${String(r.count).padStart(3)} results ${String(r.ms).padStart(6)}ms${r.cached ? " (cached)" : ""}${r.error ? `  ${r.error.slice(0, 100)}` : ""}`,
    );
  console.log(`\n${out.results.length} results`);
  for (const r of out.results) {
    const price = r.priceCents != null ? `$${r.priceCents / 100}/${r.priceUnit}` : "no price";
    console.log(`- [${r.site}] ${r.title} · ${price} · ${r.location ?? "?"}\n  ${r.url}`);
  }
}

async function login() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");
  const site = flag("site") ?? "facebook";
  const startUrl =
    site === "facebook"
      ? "https://www.facebook.com/marketplace"
      : site === "zillow"
        ? "https://www.zillow.com"
        : site;
  // Both packages live in packages/listings; its loaders resolve them from there.
  const { Browserbase } = await loadBrowserbaseSdk();
  const bb = new Browserbase({ apiKey });
  const contextId = process.env.BROWSERBASE_CONTEXT_ID || (await bb.contexts.create({ projectId })).id;
  const session = await bb.sessions.create({
    projectId,
    browserSettings: { context: { id: contextId, persist: true } },
    keepAlive: true,
    timeout: 900,
  });
  const { browserbase, Stagehand } = await loadStagehand();
  const browser = await browserbase.connect({ apiKey, sessionId: session.id });
  // v4 exposes browser.context only once a Stagehand instance is attached.
  const modelKey = process.env.ANTHROPIC_API_KEY;
  const stagehand = await Stagehand.create({
    browser,
    ...(modelKey ? { model: { modelName: "anthropic/claude-haiku-5-5", apiKey: modelKey } } : {}),
  });
  await browser.context.newPage(startUrl);
  const live = await bb.sessions.debug(session.id);
  console.log(`\nOpen this in your browser and log in to ${site}:\n\n  ${live.debuggerFullscreenUrl}\n`);
  console.log("When you are logged in and the page has settled, press Enter here.");
  for await (const _line of console) break;
  await stagehand.close().catch(() => {});
  await browser.close().catch(() => {});
  await bb.sessions.update(session.id, { projectId, status: "REQUEST_RELEASE" }).catch(() => {});
  console.log("\nContext saved. Set this on the service and restart it:\n");
  console.log(`  BROWSERBASE_CONTEXT_ID=${contextId}\n`);
}

const commands: Record<string, () => Promise<void>> = { sites, search, login };
const run = commands[cmd];
if (!run) {
  console.log(
    "usage: bun run browser <sites|search|login> [--kind room --area allston --max 1200 --in YYYY-MM-DD --out YYYY-MM-DD] [--site facebook]",
  );
  process.exit(cmd === "help" ? 0 : 1);
}
await run();
