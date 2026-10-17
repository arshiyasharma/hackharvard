import { createLogger, type Logger } from "@elves/shared";
import type { BrowserConfig } from "./browser.ts";
import { FakeListings } from "./fake.ts";
import { DEFAULT_SITES } from "./recipes/index.ts";
import { StagehandListings } from "./stagehand.ts";
import type { ListingSource } from "./types.ts";

export interface ListingsConfig {
  source: "fake" | "stagehand";
  /** Why the source is fake, for the health endpoint and logs. */
  reason: string | null;
  browser: BrowserConfig | null;
  /** Site allowlist; null = every recipe. */
  sites: string[] | null;
  perSiteTimeoutMs: number;
  totalTimeoutMs: number;
  concurrency: number;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v == null || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(v: string | undefined): string[] | null {
  const items = (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

/**
 * ELVES_LISTINGS=fake forces fixtures. Otherwise ELVES_BROWSER picks browserbase (prod) or local (dev Chrome);
 * off/unset, a missing Anthropic key, or missing Browserbase keys all fall back to fixtures with a reason.
 */
export function loadListingsConfig(env: NodeJS.ProcessEnv = process.env): ListingsConfig {
  const base = {
    sites: list(env.ELVES_LISTINGS_SITES) ?? DEFAULT_SITES,
    perSiteTimeoutMs: num(env.ELVES_LISTINGS_SITE_TIMEOUT_MS, 45_000),
    totalTimeoutMs: num(env.ELVES_LISTINGS_TOTAL_TIMEOUT_MS, 120_000),
    concurrency: num(env.ELVES_LISTINGS_CONCURRENCY, 2),
  };
  const fake = (reason: string): ListingsConfig => ({ source: "fake", reason, browser: null, ...base });
  if (env.ELVES_LISTINGS === "fake") return fake("ELVES_LISTINGS=fake");
  const mode = env.ELVES_BROWSER;
  if (!mode || mode === "off") return fake("ELVES_BROWSER is off");
  if (mode !== "browserbase" && mode !== "local") return fake(`unknown ELVES_BROWSER=${mode}`);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return fake("ANTHROPIC_API_KEY missing");
  const modelRaw =
    env.STAGEHAND_MODEL || env.ANTHROPIC_MODEL_FAST || env.ELVES_MODEL_FAST || "claude-haiku-5-5";
  const modelName = modelRaw.includes("/") ? modelRaw : `anthropic/${modelRaw}`;
  const browser: BrowserConfig = { mode, model: { modelName, apiKey } };
  if (mode === "browserbase") {
    if (!env.BROWSERBASE_API_KEY || !env.BROWSERBASE_PROJECT_ID)
      return fake("BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID missing");
    browser.browserbase = {
      apiKey: env.BROWSERBASE_API_KEY,
      projectId: env.BROWSERBASE_PROJECT_ID,
      contextId: env.BROWSERBASE_CONTEXT_ID || null,
      proxies: bool(env.BROWSERBASE_PROXIES, true),
    };
  } else {
    browser.local = {
      userDataDir: env.ELVES_BROWSER_USER_DATA_DIR || ".data/browser",
      headless: bool(env.ELVES_BROWSER_HEADLESS, true),
    };
  }
  return { source: "stagehand", reason: null, browser, ...base };
}

export function createListings(env: NodeJS.ProcessEnv = process.env, log?: Logger): ListingSource {
  const cfg = loadListingsConfig(env);
  const logger = log ?? createLogger("listings");
  if (cfg.source === "fake" || !cfg.browser) {
    logger.info("listings source: fake", { reason: cfg.reason });
    return new FakeListings();
  }
  logger.info("listings source: stagehand", { mode: cfg.browser.mode, sites: cfg.sites });
  return new StagehandListings({
    config: cfg.browser,
    sites: cfg.sites,
    perSiteTimeoutMs: cfg.perSiteTimeoutMs,
    totalTimeoutMs: cfg.totalTimeoutMs,
    concurrency: cfg.concurrency,
    log: logger,
  });
}
