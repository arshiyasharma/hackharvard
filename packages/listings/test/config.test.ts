import { describe, expect, test } from "bun:test";
import { createLogger } from "@elves/shared";
import { createListings, DEFAULT_SITES, loadListingsConfig } from "../src/index.ts";

const log = createLogger("test", "error");

describe("listings config", () => {
  test("falls back to fixtures with a reason", () => {
    expect(loadListingsConfig({})).toMatchObject({ source: "fake", reason: "ELVES_BROWSER is off" });
    expect(loadListingsConfig({ ELVES_LISTINGS: "fake", ELVES_BROWSER: "local" })).toMatchObject({
      source: "fake",
    });
    expect(loadListingsConfig({ ELVES_BROWSER: "local" })).toMatchObject({
      reason: "ANTHROPIC_API_KEY missing",
    });
    expect(loadListingsConfig({ ELVES_BROWSER: "browserbase", ANTHROPIC_API_KEY: "k" })).toMatchObject({
      reason: expect.stringContaining("BROWSERBASE_API_KEY"),
    });
    expect(createListings({}, log).name).toBe("fake");
  });
  test("local Chrome", () => {
    const cfg = loadListingsConfig({
      ELVES_BROWSER: "local",
      ANTHROPIC_API_KEY: "k",
      ELVES_BROWSER_HEADLESS: "false",
    });
    expect(cfg.source).toBe("stagehand");
    expect(cfg.browser).toMatchObject({
      mode: "local",
      model: { modelName: "anthropic/claude-haiku-5-5", apiKey: "k" },
      local: { userDataDir: ".data/browser", headless: false },
    });
    expect(cfg.sites).toEqual(DEFAULT_SITES);
    expect(createListings({ ELVES_BROWSER: "local", ANTHROPIC_API_KEY: "k" }, log).name).toBe(
      "stagehand:local",
    );
  });
  test("browserbase with a context and overrides", () => {
    const cfg = loadListingsConfig({
      ELVES_BROWSER: "browserbase",
      ANTHROPIC_API_KEY: "k",
      BROWSERBASE_API_KEY: "b",
      BROWSERBASE_PROJECT_ID: "p",
      BROWSERBASE_CONTEXT_ID: "ctx",
      STAGEHAND_MODEL: "anthropic/claude-sonnet-5-5",
      ELVES_LISTINGS_SITES: "craigslist, facebook",
      ELVES_LISTINGS_CONCURRENCY: "1",
      ELVES_LISTINGS_SITE_TIMEOUT_MS: "1000",
    });
    expect(cfg.browser).toMatchObject({
      mode: "browserbase",
      model: { modelName: "anthropic/claude-sonnet-5-5" },
      browserbase: { apiKey: "b", projectId: "p", contextId: "ctx", proxies: true },
    });
    expect(cfg.sites).toEqual(["craigslist", "facebook"]);
    expect(cfg.concurrency).toBe(1);
    expect(cfg.perSiteTimeoutMs).toBe(1000);
  });
});
