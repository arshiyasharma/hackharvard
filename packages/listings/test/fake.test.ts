import { describe, expect, test } from "bun:test";
import { createLogger } from "@elves/shared";
import { FakeListings, type ListingQuery } from "../src/index.ts";

const log = createLogger("test", "error");
const opts = () => ({ signal: new AbortController().signal, log });
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

describe("FakeListings", () => {
  test("filters by kind, neighborhood and budget with slack, and records the call", async () => {
    const fake = new FakeListings();
    const out = await fake.search([{ ...room, budgetMaxCents: 110000 }], opts());
    expect(fake.calls).toHaveLength(1);
    expect(out.results.every((r) => r.kind === "room")).toBe(true);
    expect(out.results.every((r) => (r.location ?? "").includes("Allston"))).toBe(true);
    // $1,250 is within 15% of $1,100; $1,350 is not
    expect(out.results.map((r) => r.priceCents)).toContain(125000);
    expect(out.results.map((r) => r.priceCents)).not.toContain(135000);
    expect(out.runs.every((r) => r.status === "ok")).toBe(true);
    expect(fake.sitesFor("room")).toEqual(["Craigslist", "Apartments.com", "Airbnb"]);
  });
  test("hotels and storage ignore neighborhoods", async () => {
    const out = await new FakeListings().search(
      [{ ...room, kind: "hotel", priceUnit: "night", budgetMaxCents: 15000 }],
      opts(),
    );
    expect(out.results.map((r) => r.title)).toEqual(["Hotel Indigo Boston Garden"]);
  });
  test("failSites fail their runs; failWith rejects", async () => {
    const out = await new FakeListings({ failSites: ["craigslist"] }).search([room], opts());
    expect(out.runs.find((r) => r.site === "craigslist")?.status).toBe("failed");
    expect(out.results.some((r) => r.site === "craigslist")).toBe(false);
    await expect(new FakeListings({ failWith: new Error("boom") }).search([room], opts())).rejects.toThrow(
      "boom",
    );
  });
});
