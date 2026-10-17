import { describe, expect, test } from "bun:test";
import { parseListingPrice, resolveNodeUrls, type SiteExtraction } from "../src/index.ts";

const row = (url: string): SiteExtraction["listings"][number] => ({
  title: "Room in Boston",
  url,
  priceText: "$375 for 5 nights",
  priceBasis: "total",
  location: null,
  availableFrom: null,
  bedrooms: null,
  snippet: null,
  postedAt: null,
  photoCount: 1,
  contactPhone: null,
  contactEmail: null,
});

describe("link resolution from the snapshot", () => {
  const urlMap = {
    "6-1": "https://www.airbnb.com/s/Allston--Boston--MA/homes",
    "6-1623": "https://www.airbnb.com/rooms/1732688897714113332?adults=1",
    "6-1763": "https://www.airbnb.com/rooms/12409042?adults=1",
    "6-1908": "https://www.airbnb.com/rooms/36113606?adults=1",
  };
  test("a link node id maps directly; a card id takes the next link inside it", () => {
    const out = resolveNodeUrls({ listings: [row("[6-1623]"), row("6-1622"), row("6-1762")] }, urlMap);
    expect(out.listings.map((l) => l.url)).toEqual([
      "https://www.airbnb.com/rooms/1732688897714113332?adults=1",
      "https://www.airbnb.com/rooms/1732688897714113332?adults=1",
      "https://www.airbnb.com/rooms/12409042?adults=1",
    ]);
  });
  test("real URLs and ids with no link nearby are left alone", () => {
    const out = resolveNodeUrls(
      { listings: [row("https://x.test/a"), row("6-9000"), row("nonsense")] },
      urlMap,
    );
    expect(out.listings.map((l) => l.url)).toEqual(["https://x.test/a", "6-9000", "nonsense"]);
  });
});

describe("prices quoted for a sample stay", () => {
  test("'for N nights' sets the span: nightly for hotels, nightly x 30 for housing", () => {
    expect(parseListingPrice("$375 for 5 nights", "total", 90, "hotel")).toEqual({
      cents: 7500,
      unit: "night",
    });
    expect(parseListingPrice("$375 for 5 nights", "unknown", 90, "room")).toEqual({
      cents: 225000,
      unit: "month",
    });
    expect(parseListingPrice("$3,600 for 30 nights", "total", 90, "sublet")).toEqual({
      cents: 360000,
      unit: "month",
    });
  });
});
