import { describe, expect, test } from "bun:test";
import { dedupeResults, FIXTURES, fingerprint, normalizeUrl, type SiteResult } from "../src/index.ts";

const base = FIXTURES[0] as SiteResult;

describe("dedupe", () => {
  test("normalizeUrl ignores www, query, hash and trailing slash", () => {
    expect(normalizeUrl("https://www.Example.com/a/b/?x=1#y")).toBe("example.com/a/b");
    expect(normalizeUrl("https://example.com/a/b")).toBe("example.com/a/b");
  });
  test("same url with a different query string is one listing", () => {
    const a = { ...base, url: `${base.url}?utm=1` };
    expect(dedupeResults([base, a])).toHaveLength(1);
  });
  test("same title and price on two sites is one listing; the earlier wins", () => {
    const twin: SiteResult = {
      ...base,
      site: "facebook",
      url: "https://www.facebook.com/marketplace/item/1",
    };
    expect(fingerprint(twin)).toBe(fingerprint(base));
    const out = dedupeResults([base, twin]);
    expect(out).toHaveLength(1);
    expect(out[0]?.site).toBe("craigslist");
  });
  test("same title at a different price stays", () => {
    const other: SiteResult = {
      ...base,
      site: "facebook",
      url: "https://www.facebook.com/marketplace/item/2",
      priceCents: 90000,
    };
    expect(dedupeResults([base, other])).toHaveLength(2);
  });
});
