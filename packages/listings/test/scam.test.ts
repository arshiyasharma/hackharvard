import { describe, expect, test } from "bun:test";
import { FIXTURES, isHardFlagged, medianPriceCents, type SiteResult, scamFlags } from "../src/index.ts";

const clean = FIXTURES[0] as SiteResult;
const rooms = FIXTURES.filter((f) => f.kind === "room");

function room(over: Partial<SiteResult>): SiteResult {
  return { ...clean, url: `https://boston.craigslist.org/gbs/roo/d/${Math.random()}.html`, ...over };
}

describe("scam flags", () => {
  test("a clean listing has none", () => {
    expect(scamFlags(clean, rooms)).toEqual([]);
  });
  test("the fixture scam trips price, prepay, away and no-photos", () => {
    const scam = FIXTURES.find((f) => f.priceCents === 40000) as SiteResult;
    const flags = scamFlags(scam, rooms);
    expect(flags).toEqual(
      expect.arrayContaining(["price_too_low", "wire_or_prepay", "out_of_country", "no_photos"]),
    );
    expect(isHardFlagged(flags)).toBe(true);
  });
  test("price_too_low needs at least four peers", () => {
    const cheap = room({ priceCents: 30000 });
    expect(medianPriceCents(rooms.slice(0, 3), "room", "month")).toBeNull();
    expect(scamFlags(cheap, rooms.slice(0, 3))).not.toContain("price_too_low");
    expect(scamFlags(cheap, rooms)).toContain("price_too_low");
  });
  test("wire_or_prepay catches app payments before a viewing but not a plain mention", () => {
    expect(scamFlags(room({ snippet: "Venmo deposit required before viewing." }), rooms)).toContain(
      "wire_or_prepay",
    );
    expect(
      scamFlags(room({ snippet: "Rent can be paid by Venmo or check each month." }), rooms),
    ).not.toContain("wire_or_prepay");
    expect(scamFlags(room({ snippet: "Pay via Western Union." }), rooms)).toContain("wire_or_prepay");
  });
  test("no_address only for housing", () => {
    expect(scamFlags(room({ location: null }), rooms)).toContain("no_address");
    const hotel = FIXTURES.find((f) => f.kind === "hotel") as SiteResult;
    expect(scamFlags({ ...hotel, location: null }, FIXTURES)).not.toContain("no_address");
  });
  test("cross-site price mismatch", () => {
    const twin: SiteResult = {
      ...clean,
      site: "facebook",
      url: "https://www.facebook.com/marketplace/item/9",
      priceCents: 60000,
    };
    expect(scamFlags(twin, [...rooms, twin])).toContain("cross_site_price_mismatch");
    expect(scamFlags(clean, [...rooms, twin])).toContain("cross_site_price_mismatch");
  });
});
