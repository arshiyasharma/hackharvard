import { describe, expect, test } from "bun:test";
import { fmtUsd, parsePriceCents, suggestListCents } from "@elves/elves";

describe("parsePriceCents", () => {
  test.each([
    ["$4", 400],
    ["4 dollars", 400],
    ["40 bucks", 4000],
    ["$12.50", 1250],
    ["lowest I'd take is 80", 8000],
    ["floor is 50", 5000],
    ["i'd take 60 for it", 6000],
    ["80", 8000],
    ["80?", 8000],
  ])("%p -> %p", (text, cents) => {
    expect(parsePriceCents(text)).toBe(cents);
  });
  test.each([["hello"], ["moving out november 1"], ["the 3 of us"], ["can you book storage"]])(
    "%p is not a price",
    (text) => {
      expect(parsePriceCents(text)).toBeNull();
    },
  );
});

describe("pricing helpers", () => {
  test("suggestListCents sits in the upper middle of the range, rounded", () => {
    expect(suggestListCents(2500, 4000)).toBe(3500);
    expect(suggestListCents(12000, 18000)).toBe(16000);
    expect(suggestListCents(300, 800)).toBe(600);
  });
  test("fmtUsd", () => {
    expect(fmtUsd(400)).toBe("$4");
    expect(fmtUsd(1250)).toBe("$12.50");
  });
});
