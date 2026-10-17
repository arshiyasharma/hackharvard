import { describe, expect, test } from "bun:test";
import {
  airbnb,
  apartments,
  booking,
  craigslist,
  facebook,
  type ListingQuery,
  nightsBetween,
  parseListingPrice,
  RECIPES,
  recipesFor,
  resolveListingUrl,
  sparefoot,
  toResults,
  zillow,
} from "../src/index.ts";

const room: ListingQuery = {
  kind: "room",
  city: "Boston, MA",
  neighborhoods: ["Allston", "Brighton"],
  budgetMaxCents: 120000,
  priceUnit: "month",
  moveIn: "2026-06-01",
  moveOut: "2026-08-30",
  bedrooms: null,
  furnished: null,
  mustHaves: [],
};
const apartment: ListingQuery = {
  ...room,
  kind: "apartment",
  neighborhoods: ["Cambridge"],
  bedrooms: 1,
  budgetMaxCents: 300000,
};
const hotel: ListingQuery = {
  ...room,
  kind: "hotel",
  neighborhoods: [],
  priceUnit: "night",
  budgetMaxCents: 20000,
  moveIn: "2026-06-01",
  moveOut: "2026-06-03",
};
const storage: ListingQuery = { ...room, kind: "storage", neighborhoods: [], budgetMaxCents: null };

describe("URL builders", () => {
  test("craigslist rooms in greater Boston with price and neighborhoods", () => {
    const url = new URL(craigslist.buildUrl(room) as string);
    expect(url.origin + url.pathname).toBe("https://boston.craigslist.org/search/gbs/roo");
    expect(url.searchParams.get("max_price")).toBe("1200");
    expect(url.searchParams.get("query")).toBe("Allston | Brighton");
    expect(url.searchParams.get("hasPic")).toBe("1");
    expect(url.searchParams.get("min_bedrooms")).toBeNull();
  });
  test("craigslist apartments carry min_bedrooms", () => {
    const url = new URL(craigslist.buildUrl(apartment) as string);
    expect(url.pathname).toBe("/search/gbs/apa");
    expect(url.searchParams.get("min_bedrooms")).toBe("1");
  });
  test("craigslist outside the known map falls back to the city name", () => {
    const url = new URL(craigslist.buildUrl({ ...room, city: "Austin, TX" }) as string);
    expect(url.origin + url.pathname).toBe("https://austin.craigslist.org/search/roo");
  });
  test("apartments.com path carries beds and budget", () => {
    expect(apartments.buildUrl(apartment)).toBe(
      "https://www.apartments.com/cambridge-boston-ma/1-bedrooms-under-3000/",
    );
    expect(apartments.buildUrl({ ...apartment, bedrooms: 0 })).toBe(
      "https://www.apartments.com/cambridge-boston-ma/studios-under-3000/",
    );
    expect(apartments.buildUrl({ ...apartment, bedrooms: null, budgetMaxCents: null })).toBe(
      "https://www.apartments.com/cambridge-boston-ma/",
    );
  });
  test("zillow encodes the filter state", () => {
    const url = new URL(zillow.buildUrl(apartment) as string);
    expect(url.pathname).toBe("/cambridge-boston-ma/rentals/");
    const state = JSON.parse(url.searchParams.get("searchQueryState") as string);
    expect(state.filterState.mp).toEqual({ max: 3000 });
    expect(state.filterState.beds).toEqual({ min: 1 });
  });
  test("facebook needs a login and builds a rentals search", () => {
    expect(facebook.needsLogin).toBe(true);
    const url = new URL(facebook.buildUrl(room) as string);
    expect(url.pathname).toBe("/marketplace/boston/propertyrentals");
    expect(url.searchParams.get("maxPrice")).toBe("1200");
    expect(url.searchParams.get("query")).toBe("room Allston Brighton");
  });
  test("airbnb needs dates and filters on the stay total", () => {
    expect(airbnb.buildUrl({ ...room, moveIn: null })).toBeNull();
    const url = new URL(airbnb.buildUrl(room) as string);
    expect(url.pathname).toBe("/s/Allston--Boston--MA/homes");
    expect(url.searchParams.get("checkin")).toBe("2026-06-01");
    expect(url.searchParams.get("checkout")).toBe("2026-08-30");
    // 90 nights at $1,200/mo
    expect(url.searchParams.get("price_max")).toBe("3600");
    expect(url.searchParams.getAll("room_types[]")).toEqual(["Private room"]);
    const h = new URL(airbnb.buildUrl(hotel) as string);
    expect(h.searchParams.get("price_max")).toBe("400");
    expect(h.searchParams.getAll("room_types[]")).toEqual([]);
  });
  test("booking takes the gap dates and a nightly cap", () => {
    const url = new URL(booking.buildUrl(hotel) as string);
    expect(url.searchParams.get("ss")).toBe("Boston, MA");
    expect(url.searchParams.get("checkin")).toBe("2026-06-01");
    expect(url.searchParams.get("nflt")).toBe("price=USD-min-200-1");
    expect(booking.buildUrl({ ...hotel, moveOut: null })).toBeNull();
  });
  test("sparefoot is a city page", () => {
    expect(sparefoot.buildUrl(storage)).toBe("https://www.sparefoot.com/Boston-MA-self-storage.html");
  });
  test("no city means no URL", () => {
    for (const r of RECIPES) expect(r.buildUrl({ ...room, city: "" })).toBeNull();
  });
});

describe("recipesFor", () => {
  test("skips login-only sites without a context and honors the allowlist", () => {
    const { planned, skipped } = recipesFor([room], { loggedIn: false, sites: null }, RECIPES);
    expect(planned.map((p) => p.recipe.site)).toEqual(["craigslist", "airbnb"]);
    expect(skipped).toContainEqual({ site: "facebook", kind: "room", reason: "login" });
    const logged = recipesFor([room], { loggedIn: true, sites: null }, RECIPES);
    expect(logged.planned.map((p) => p.recipe.site)).toContain("facebook");
    const allow = recipesFor([room], { loggedIn: true, sites: ["craigslist"] }, RECIPES);
    expect(allow.planned.map((p) => p.recipe.site)).toEqual(["craigslist"]);
    expect(allow.skipped.some((s) => s.site === "airbnb" && s.reason === "allowlist")).toBe(true);
  });
  test("one query per kind, in trust order", () => {
    const { planned } = recipesFor([room, hotel, storage], { loggedIn: false, sites: null }, RECIPES);
    expect(planned.map((p) => `${p.recipe.site}:${p.query.kind}`)).toEqual([
      "craigslist:room",
      "airbnb:room",
      "airbnb:hotel",
      "booking:hotel",
      "sparefoot:storage",
    ]);
  });
});

describe("parseListingPrice", () => {
  test.each([
    ["$1,200/mo", "month", null, "room", 120000, "month"],
    ["$140 night", "night", null, "hotel", 14000, "night"],
    ["$2,310 total", "total", 3, "hotel", 77000, "night"],
    ["$3,600 total", "total", 90, "sublet", 120000, "month"],
    ["$950", "unknown", null, "room", 95000, "month"],
    ["$180 per night", "unknown", null, "hotel", 18000, "night"],
    ["1,100 / month", "unknown", null, "room", 110000, "month"],
  ] as const)("%p (%p, nights %p, %p)", (text, basis, nights, kind, cents, unit) => {
    expect(parseListingPrice(text, basis, nights, kind)).toEqual({ cents, unit });
  });
  test("no number means no price", () => {
    expect(parseListingPrice("Contact for price", "unknown", null, "room")).toBeNull();
    expect(parseListingPrice(null, "month", null, "room")).toBeNull();
  });
  test("nightsBetween", () => {
    expect(nightsBetween("2026-06-01", "2026-06-03")).toBe(2);
    expect(nightsBetween("2026-06-03", "2026-06-01")).toBeNull();
    expect(nightsBetween(null, "2026-06-01")).toBeNull();
  });
});

describe("toResults", () => {
  const searchUrl = craigslist.buildUrl(room) as string;
  test("keeps on-site links, resolves relative ones, drops the rest", () => {
    expect(resolveListingUrl("/gbs/roo/d/x/1.html", craigslist, searchUrl)).toBe(
      "https://boston.craigslist.org/gbs/roo/d/x/1.html",
    );
    expect(resolveListingUrl("https://evil.example/phish", craigslist, searchUrl)).toBeNull();
    expect(resolveListingUrl("javascript:alert(1)", craigslist, searchUrl)).toBeNull();
    expect(resolveListingUrl("https://boston.craigslist.org/gbs/roo/1.html#x", craigslist, searchUrl)).toBe(
      "https://boston.craigslist.org/gbs/roo/1.html",
    );
  });
  test("builds SiteResults with parsed prices and drops empty titles", () => {
    const data = {
      listings: [
        {
          title: "Room near the B line",
          url: "/gbs/roo/d/allston/1.html",
          priceText: "$1,150",
          priceBasis: "month" as const,
          location: "(Allston)",
          availableFrom: null,
          bedrooms: null,
          snippet: "Furnished.",
          postedAt: "2026-05-20",
          photoCount: 4,
          contactPhone: null,
          contactEmail: null,
        },
        {
          title: "   ",
          url: "/gbs/roo/d/allston/2.html",
          priceText: "$900",
          priceBasis: "month" as const,
          location: null,
          availableFrom: null,
          bedrooms: null,
          snippet: null,
          postedAt: null,
          photoCount: null,
          contactPhone: null,
          contactEmail: null,
        },
        {
          title: "Off-site",
          url: "https://scam.example/x",
          priceText: "$1",
          priceBasis: "month" as const,
          location: null,
          availableFrom: null,
          bedrooms: null,
          snippet: null,
          postedAt: null,
          photoCount: null,
          contactPhone: null,
          contactEmail: null,
        },
      ],
    };
    const out = toResults(craigslist, room, data, searchUrl);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      site: "craigslist",
      kind: "room",
      url: "https://boston.craigslist.org/gbs/roo/d/allston/1.html",
      priceCents: 115000,
      priceUnit: "month",
      location: "(Allston)",
      photoCount: 4,
    });
  });
  test("caps at maxListings", () => {
    const many = {
      listings: Array.from({ length: 20 }, (_, i) => ({
        title: `Room ${i}`,
        url: `/gbs/roo/d/x/${i}.html`,
        priceText: "$1,000",
        priceBasis: "month" as const,
        location: "(Allston)",
        availableFrom: null,
        bedrooms: null,
        snippet: null,
        postedAt: null,
        photoCount: 1,
        contactPhone: null,
        contactEmail: null,
      })),
    };
    expect(toResults(craigslist, room, many, searchUrl)).toHaveLength(12);
  });
});
