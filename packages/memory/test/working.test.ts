import { describe, expect, test } from "bun:test";
import { housingLines, renderWorkingMemory } from "@elves/memory";
import { type HousingSearch, type Listing, listingDefaults, MemoryStore } from "@elves/shared";

describe("working memory: housing search", () => {
  test("renders the ask, the last search and the top picks; nothing when there is no search", async () => {
    const store = new MemoryStore();
    const move = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "s1", platform: "script" });
    const plain = renderWorkingMemory(move, [], await store.getBoard(move.id));
    expect(plain).not.toContain("## Housing search");

    const search: HousingSearch = {
      moveId: move.id,
      kinds: ["room"],
      city: "Boston, MA",
      neighborhoods: ["Allston", "Brighton"],
      budgetMaxCents: 120000,
      hotelNightlyMaxCents: null,
      moveIn: "2026-06-01",
      moveOut: "2026-08-30",
      bedrooms: null,
      furnished: true,
      mustHaves: ["near the T"],
      notes: [],
      lastSearchedAt: "2026-03-01T12:00:00.000Z",
      lastSearchKey: "abc",
      shownCount: 3,
      updatedAt: "2026-03-01T12:00:00.000Z",
    };
    const listing = (over: Partial<Listing>): Listing => ({
      ...listingDefaults(),
      id: "ls_1",
      moveId: move.id,
      site: "craigslist",
      kind: "room",
      url: "https://boston.craigslist.org/x/1",
      title: "Sunny room",
      ...over,
    });
    const listings = [
      listing({ id: "ls_1", rank: 1, priceCents: 110000, location: "Allston", status: "shortlisted" }),
      listing({
        id: "ls_2",
        rank: 2,
        priceCents: 125000,
        location: "Allston",
        title: "Allston Green",
        url: "https://x/2",
      }),
      listing({
        id: "ls_3",
        rank: null,
        priceCents: 40000,
        scamFlags: ["wire_or_prepay"],
        url: "https://x/3",
      }),
    ];
    const lines = housingLines({ search, listings });
    expect(lines[0]).toBe(
      "- Looking for: room · Allston, Brighton · max $1200/mo · 2026-06-01 → 2026-08-30 · furnished",
    );
    expect(lines).toContain("- Must-haves: near the T");
    expect(lines).toContain("- Last search: 2026-03-01 · 3 found · 1 flagged as likely scams · 3 shown");
    expect(lines[lines.length - 1]).toBe(
      "- Picks: 1. Sunny room · $1100/mo · Allston (shortlisted) 2. Allston Green · $1250/mo · Allston",
    );
    const full = renderWorkingMemory(move, [], await store.getBoard(move.id), [], { search, listings });
    expect(full).toContain("## Housing search\n- Looking for: room");
    expect(full.indexOf("## Housing search")).toBeLessThan(full.indexOf("## Crew"));
    expect(housingLines({ search: null, listings: [] })).toEqual(["- (no search yet)"]);
  });
});
