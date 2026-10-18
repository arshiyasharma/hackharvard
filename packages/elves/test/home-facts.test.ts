import { describe, expect, test } from "bun:test";
import {
  emptySearch,
  extractHousingHeuristic,
  mergeSearch,
  missingRequirement,
  parseBudgetCents,
  parseDateRange,
  parseFollowUp,
  parseNeighborhoods,
  queriesFor,
  searchKey,
} from "@elves/elves";
import type { Move } from "@elves/shared";

const now = new Date("2026-03-01T12:00:00Z");
const move: Move = {
  id: "mv_1",
  ownerHandle: "+1",
  ownerSpaceId: "spc_1",
  platform: "script",
  name: null,
  moveOutAt: null,
  moveInAt: null,
  fromAddress: null,
  toAddress: null,
  boardLinkSent: false,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

describe("housing heuristics", () => {
  test("a full ask in one text", () => {
    const r = extractHousingHeuristic("looking for a room in allston under 1200 june 1 to aug 30", now);
    expect(r).toMatchObject({
      kinds: ["room"],
      neighborhoods: ["Allston"],
      city: "Boston, MA",
      budgetMaxUsd: 1200,
      moveIn: "2026-06-01",
      moveOut: "2026-08-30",
      wantsSearchNow: true,
    });
  });
  test.each([
    ["budget is $900/mo", 90000],
    ["under 1200", 120000],
    ["max 1500 a month", 150000],
    ["around $950", 95000],
    ["$1,200/mo", 120000],
    ["june 1 to aug 30", null],
    ["2 bedrooms", null],
    ["$40", null],
  ])("parseBudgetCents(%p) = %p", (text, cents) => {
    expect(parseBudgetCents(text)).toBe(cents);
  });
  test("neighborhoods, kinds, beds and furnished", () => {
    const r = extractHousingHeuristic("furnished studio in cambridge or somerville near the T", now);
    expect(r.neighborhoods).toEqual(["Cambridge", "Somerville"]);
    expect(r.kinds).toEqual(["apartment"]);
    expect(r.bedrooms).toBe(0);
    expect(r.furnished).toBe(true);
    expect(r.mustHaves).toEqual(["near the T"]);
    expect(parseNeighborhoods("somewhere in southie or jp")).toEqual(["South Boston"]);
    expect(extractHousingHeuristic("need a place for the summer", now).kinds).toEqual(["sublet"]);
    expect(extractHousingHeuristic("any hotels for the gap between leases", now).kinds).toEqual(["hotel"]);
    expect(extractHousingHeuristic("2 bed apartment", now).bedrooms).toBe(2);
  });
  test.each([
    ["june 1 to aug 30", "2026-06-01", "2026-08-30"],
    ["june through august", "2026-06-01", "2026-08-31"],
    ["6/1 - 8/30", "2026-06-01", "2026-08-30"],
    ["from jun 1st until sept 15", "2026-06-01", "2026-09-15"],
    ["moving in sept 1", "2026-09-01", null],
    ["I want to sublet my room for $1500 june 1 to aug 31, furnished", "2026-06-01", "2026-08-31"],
    ["need to find a place june 1", "2026-06-01", null],
    ["sublet my room until aug 31", null, "2026-08-31"],
    ["no dates here", null, null],
  ])("parseDateRange(%p)", (text, start, end) => {
    expect(parseDateRange(text, now)).toEqual({ start, end });
  });
  test.each([
    ["more", { kind: "more" }],
    ["Next?", { kind: "more" }],
    ["tell me about 2", { kind: "detail", n: 2 }],
    ["#2", { kind: "detail", n: 2 }],
    ["2", { kind: "detail", n: 2 }],
    ["what about 3?", { kind: "detail", n: 3 }],
    ["skip 1", { kind: "skip", n: 1 }],
    ["pass on 3", { kind: "skip", n: 3 }],
    ["save 2", { kind: "shortlist", n: 2 }],
    ["I like 1", { kind: "shortlist", n: 1 }],
    ["looking for a room", null],
    ["4 dollars", null],
  ])("parseFollowUp(%p)", (text, expected) => {
    expect(parseFollowUp(text)).toEqual(expected as ReturnType<typeof parseFollowUp>);
  });
});

describe("search merging and readiness", () => {
  test("asks for budget, then area, then dates, then searches", () => {
    let s = emptySearch(move.id, now);
    s = { ...s, kinds: ["room"] };
    expect(missingRequirement(s)).toBe("budget");
    s = { ...s, budgetMaxCents: 120000 };
    expect(missingRequirement(s)).toBe("area");
    s = { ...s, neighborhoods: ["Allston"] };
    expect(missingRequirement(s)).toBe("dates");
    s = { ...s, moveIn: "2026-06-01" };
    expect(missingRequirement(s)).toBeNull();
  });
  test("hotel-only needs city and both nights; storage needs only a city", () => {
    const hotel = { ...emptySearch(move.id, now), kinds: ["hotel" as const], city: "Boston, MA" };
    expect(missingRequirement(hotel)).toBe("dates");
    expect(missingRequirement({ ...hotel, moveIn: "2026-06-01", moveOut: "2026-06-03" })).toBeNull();
    const storage = { ...emptySearch(move.id, now), kinds: ["storage" as const] };
    expect(missingRequirement(storage)).toBe("area");
    expect(missingRequirement({ ...storage, city: "Boston, MA" })).toBeNull();
  });
  test("mergeSearch unions lists, overrides scalars and borrows the move's move-in date", () => {
    const first = mergeSearch(
      undefined,
      extractHousingHeuristic("room in allston under 1200", now),
      move,
      now,
    );
    expect(first).toMatchObject({
      kinds: ["room"],
      neighborhoods: ["Allston"],
      budgetMaxCents: 120000,
      moveIn: null,
    });
    const second = mergeSearch(
      first,
      extractHousingHeuristic("brighton works too, max 1300", now),
      { ...move, moveInAt: "2026-06-01" },
      now,
    );
    expect(second).toMatchObject({
      kinds: ["room"],
      neighborhoods: ["Allston", "Brighton"],
      budgetMaxCents: 130000,
      moveIn: "2026-06-01",
      city: "Boston, MA",
    });
  });
  test("queriesFor adds a hotel query for a short gap and a storage query when asked", () => {
    const s = {
      ...emptySearch(move.id, now),
      kinds: ["room" as const],
      neighborhoods: ["Allston"],
      budgetMaxCents: 120000,
      moveIn: "2026-06-01",
      moveOut: "2026-08-30",
    };
    expect(queriesFor(s, move).map((q) => q.kind)).toEqual(["room"]);
    const gap = queriesFor(s, { ...move, moveOutAt: "2026-05-30" });
    expect(gap.map((q) => q.kind)).toEqual(["room", "hotel"]);
    expect(gap[1]).toMatchObject({ moveIn: "2026-05-30", moveOut: "2026-06-01", priceUnit: "night" });
    expect(queriesFor(s, { ...move, moveOutAt: "2026-04-01" }).map((q) => q.kind)).toEqual(["room"]);
    expect(queriesFor({ ...s, kinds: ["room", "storage"] }, move).map((q) => q.kind)).toEqual([
      "room",
      "storage",
    ]);
    const a = searchKey(queriesFor(s, move));
    expect(a).toBe(searchKey(queriesFor({ ...s, mustHaves: ["parking"] }, move)));
    expect(a).not.toBe(searchKey(queriesFor({ ...s, budgetMaxCents: 130000 }, move)));
  });
});
