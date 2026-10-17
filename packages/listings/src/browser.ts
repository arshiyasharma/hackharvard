import type { Logger } from "@elves/shared";
import type { z } from "zod";

/**
 * A thin seam over Stagehand v4 so the search runner can be tested with a fake browser and so nothing else in
 * the repo loads Stagehand. The real opener imports it lazily.
 */

export interface BrowserConfig {
  mode: "browserbase" | "local";
  /** Stagehand model id, e.g. "anthropic/claude-haiku-5-5", and the key for it. */
  model: { modelName: string; apiKey: string };
  browserbase?: {
    apiKey: string;
    projectId: string;
    /** Persisted context holding the owner's logins; null = fresh profile every search. */
    contextId: string | null;
    proxies: boolean;
  };
  local?: { userDataDir: string; headless: boolean };
}

export interface PageLike {
  url(): string;
  close(): Promise<void>;
}

export interface BrowserSession {
  sessionId: string | null;
  /** Opens the URL and waits for the load event (best effort). */
  newPage(url: string): Promise<PageLike>;
  /**
   * Wait for a selector (the results container) and then a short settle for client-rendered lists.
   * Resolves false when the selector never showed; never throws.
   */
  waitFor(
    page: PageLike,
    opts: { selector?: string; settleMs?: number; timeoutMs: number },
  ): Promise<boolean>;
  extract<T>(
    instruction: string,
    schema: z.ZodType<T>,
    opts: { page: PageLike; timeoutMs: number; locator?: string },
  ): Promise<T>;
  act(instruction: string, opts: { page: PageLike; timeoutMs: number }): Promise<void>;
  /** The page title ("" when unavailable); how a block page is told apart from an empty result list. */
  title(page: PageLike): Promise<string>;
  /** Node id -> href for every link in the current accessibility snapshot ({} when unavailable). */
  linkMap(page: PageLike): Promise<Record<string, string>>;
  /**
   * Close whatever modal greeted us (price notices, sign-in prompts) with Escape. An open modal is all the
   * accessibility snapshot contains, so extraction on it finds nothing.
   */
  dismiss(page: PageLike): Promise<void>;
  /** stagehand.close() then browser.close(); safe to call twice. */
  close(): Promise<void>;
}

/** Titles of anti-bot and access-denied pages; an empty extraction on one of these is a failed run. */
export const BLOCK_PAGE_TITLE =
  /access denied|just a moment|attention required|verify you are (a )?human|are you a robot|pardon our interruption|blocked|captcha|security check|unusual traffic/i;

export type BrowserOpener = (cfg: BrowserConfig, log: Logger) => Promise<BrowserSession>;

// The slice of Stagehand v4 we touch. Kept local so the package types without the dependency installed.
interface StagehandPage {
  close(): Promise<unknown>;
  locator?(selector: string): unknown;
  waitForLoadState?(state: "load" | "domcontentloaded" | "networkidle", timeout?: number): Promise<unknown>;
  waitForSelector?(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout?(ms: number): Promise<unknown>;
  title?(): Promise<string>;
  keyPress?(key: string): Promise<unknown>;
  snapshot?(): Promise<{ urlMap?: Record<string, string> }>;
}
interface StagehandBrowser {
  sessionId?: string | null;
  context: { newPage(url?: string): Promise<StagehandPage> };
  close(): Promise<unknown>;
}
interface StagehandInstance {
  extract(instruction: string, schema: unknown, opts?: Record<string, unknown>): Promise<{ data: unknown }>;
  act(instruction: string, opts?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<unknown>;
}
interface StagehandModule {
  browserbase: {
    launch(opts: Record<string, unknown>): Promise<StagehandBrowser>;
    connect(opts: { apiKey: string; sessionId: string }): Promise<StagehandBrowser>;
  };
  localBrowser: { launch(opts: Record<string, unknown>): Promise<StagehandBrowser> };
  Stagehand: { create(opts: Record<string, unknown>): Promise<StagehandInstance> };
}

const STAGEHAND = "@browserbasehq/stagehand";
const BROWSERBASE_SDK = "@browserbasehq/sdk";

/** The slice of the Browserbase REST SDK the operator CLI uses (contexts + sessions for the one-time login). */
export interface BrowserbaseSdk {
  Browserbase: new (o: {
    apiKey: string;
  }) => {
    contexts: { create(o: { projectId: string }): Promise<{ id: string }> };
    sessions: {
      create(o: Record<string, unknown>): Promise<{ id: string }>;
      debug(id: string): Promise<{ debuggerFullscreenUrl: string }>;
      update(id: string, o: Record<string, unknown>): Promise<unknown>;
    };
  };
}

/**
 * Loaded lazily, from this package (where it is installed), with a variable specifier so type-checking never
 * needs the dependency. Scripts outside the package import these loaders instead of the modules.
 */
export async function loadStagehand(): Promise<StagehandModule> {
  const specifier: string = STAGEHAND;
  try {
    return (await import(specifier)) as StagehandModule;
  } catch (err) {
    throw new Error(`${STAGEHAND} is not installed (bun add ${STAGEHAND}): ${String(err)}`);
  }
}

export async function loadBrowserbaseSdk(): Promise<BrowserbaseSdk> {
  const specifier: string = BROWSERBASE_SDK;
  try {
    return (await import(specifier)) as BrowserbaseSdk;
  } catch (err) {
    throw new Error(`${BROWSERBASE_SDK} is not installed (bun add ${BROWSERBASE_SDK}): ${String(err)}`);
  }
}

export type { StagehandModule };

/** Launch a browser per the config and wrap it as a BrowserSession. */
export const openStagehandBrowser: BrowserOpener = async (cfg, log) => {
  const mod = await loadStagehand();
  let browser: StagehandBrowser;
  if (cfg.mode === "browserbase") {
    if (!cfg.browserbase) throw new Error("browserbase config missing");
    const { apiKey, projectId, contextId, proxies } = cfg.browserbase;
    browser = await mod.browserbase.launch({
      apiKey,
      projectId,
      proxies,
      ...(contextId ? { browserSettings: { context: { id: contextId, persist: true } } } : {}),
    });
  } else {
    const local = cfg.local ?? { userDataDir: ".data/browser", headless: true };
    browser = await mod.localBrowser.launch({ userDataDir: local.userDataDir, headless: local.headless });
  }
  let stagehand: StagehandInstance;
  try {
    stagehand = await mod.Stagehand.create({ browser, model: cfg.model });
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
  const sessionId = browser.sessionId ?? null;
  log.info("browser session opened", { mode: cfg.mode, sessionId });
  let closed = false;
  return {
    sessionId,
    async newPage(url) {
      const page = await browser.context.newPage(url);
      // Results lists render client-side after load; without these waits the snapshot is an empty shell.
      await page.waitForLoadState?.("load", 15_000).catch(() => {});
      await page.waitForLoadState?.("networkidle", 8_000).catch(() => {});
      const wrapper: PageLike = {
        // The URL we opened; v4's page.url() is async and nothing here needs the post-redirect one.
        url: () => url,
        close: async () => {
          await page.close();
        },
      };
      pages.set(wrapper, page);
      return wrapper;
    },
    async waitFor(p, opts) {
      const page = pageOf(p);
      let found = true;
      if (opts.selector && typeof page.waitForSelector === "function") {
        found = await page
          .waitForSelector(opts.selector, { timeout: opts.timeoutMs })
          .then(() => true)
          .catch(() => false);
      }
      if (opts.settleMs) await page.waitForTimeout?.(opts.settleMs).catch(() => {});
      return found;
    },
    async extract(instruction, schema, opts) {
      const page = pageOf(opts.page);
      const extra: Record<string, unknown> = { page, timeout: opts.timeoutMs };
      if (opts.locator && typeof page.locator === "function") extra.locator = page.locator(opts.locator);
      const res = await stagehand.extract(instruction, schema, extra);
      // Stagehand already shaped the data to the schema; one bad field (an unresolved link) must not sink the
      // whole page, so hand the rows on and let toResults drop the bad ones.
      const parsed = schema.safeParse(res.data);
      if (!parsed.success)
        log.debug("extraction did not fully match the schema", { issues: parsed.error.issues.length });
      return parsed.success ? parsed.data : (res.data as ReturnType<typeof schema.parse>);
    },
    async act(instruction, opts) {
      await stagehand.act(instruction, { page: pageOf(opts.page), timeout: opts.timeoutMs });
    },
    async title(p) {
      const page = pageOf(p);
      return (await page.title?.().catch(() => "")) ?? "";
    },
    async linkMap(p) {
      const page = pageOf(p);
      try {
        return (await page.snapshot?.())?.urlMap ?? {};
      } catch (err) {
        log.debug("snapshot for links failed", { error: String(err) });
        return {};
      }
    },
    async dismiss(p) {
      const page = pageOf(p);
      await page.keyPress?.("Escape").catch(() => {});
      // Let the page re-render before anything snapshots it; a snapshot mid-render is an empty shell.
      await page.waitForTimeout?.(800).catch(() => {});
    },
    async close() {
      if (closed) return;
      closed = true;
      await stagehand.close().catch((err) => log.warn("stagehand close failed", { error: String(err) }));
      await browser.close().catch((err) => log.warn("browser close failed", { error: String(err) }));
      log.info("browser session closed", { sessionId });
    },
  };
};

/** The runner holds PageLike wrappers; this maps them back to the Stagehand pages they wrap. */
const pages = new WeakMap<PageLike, StagehandPage>();

function pageOf(p: PageLike): StagehandPage {
  const raw = pages.get(p);
  if (!raw) throw new Error("unknown page");
  return raw;
}
