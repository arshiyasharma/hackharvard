import { describe, expect, test } from "bun:test";
import { extractFactsHeuristic, parseDate } from "@elves/elves";

const now = new Date("2026-10-17T12:00:00Z");

describe("parseDate", () => {
  test.each([
    ["moving out november 1", "2026-11-01"],
    ["Nov 1st", "2026-11-01"],
    ["out by 11/1", "2026-11-01"],
    ["leaving the 3rd of december", "2026-12-03"],
    ["move out jan 15", "2027-01-15"],
    ["2026-11-30 is the day", "2026-11-30"],
  ])("%p -> %p", (text, iso) => {
    expect(parseDate(text, now)).toBe(iso);
  });
  test("tomorrow", () => {
    expect(parseDate("leaving tomorrow", now)).toBe("2026-10-18");
  });
  test("no date", () => {
    expect(parseDate("hello there", now)).toBeNull();
  });
});

describe("extractFactsHeuristic", () => {
  test("captures the move-out date and items to sell", () => {
    const f = extractFactsHeuristic("Im moving out november 1 and i have a couch and a lamp to sell", now);
    expect(f.moveOutDate).toBe("2026-11-01");
    expect(f.items.map((i) => [i.name, i.category, i.intent])).toEqual([
      ["couch", "couch", "sell"],
      ["lamp", "small", "sell"],
    ]);
  });
  test("move-in dates are kept apart from move-out", () => {
    const f = extractFactsHeuristic("moving in on december 1", now);
    expect(f.moveInDate).toBe("2026-12-01");
    expect(f.moveOutDate).toBeNull();
  });
});
