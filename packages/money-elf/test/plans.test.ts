import { describe, expect, test } from "bun:test";
import { ASSUMPTIONS, draftPlans, floorOf, type PlanInput, type PlanItem, truckFor } from "../src/plans.ts";

const ITEMS: PlanItem[] = [
  { id: "i1", name: "couch", category: "furniture", weightLb: 120, listCents: 12000, floorCents: 8000 },
  { id: "i2", name: "desk", category: "furniture", weightLb: 60, listCents: 8000, floorCents: 5000 },
  { id: "i3", name: "bookshelf", category: "furniture", weightLb: 40, listCents: 4000, floorCents: 2000 },
  { id: "i4", name: "lamp", category: "decor", weightLb: 8, listCents: 2500, floorCents: 1500 },
  {
    id: "i5",
    name: "mattress",
    category: "furniture",
    weightLb: 70,
    listCents: 0,
    floorCents: null,
    keep: true,
  },
];

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    moveId: "mv_plans",
    items: ITEMS,
    moveOutDate: "2026-10-28",
    budgetCents: 30000,
    netNowCents: 36000,
    expected: [],
    now: new Date("2026-10-18T15:00:00Z"),
    runs: 800,
    ...over,
  };
}

function plans(over: Partial<PlanInput> = {}) {
  const r = draftPlans(input(over));
  if (!r.ok) throw new Error(r.reason);
  return r.plans;
}

describe("move plans", () => {
  test("the same input gives the same plans", () => {
    expect(JSON.stringify(plans())).toBe(JSON.stringify(plans()));
  });

  test("three labeled plans, A has the best odds", () => {
    const ps = plans();
    expect(ps.map((p) => p.label)).toEqual(["A", "B", "C"]);
    expect(ps[0]?.name).toBe("best odds");
    for (const p of ps.slice(1))
      expect(ps[0]?.stats.chanceUnderBudget).toBeGreaterThanOrEqual(p.stats.chanceUnderBudget);
    expect(ps.at(-1)?.name).toBe("least effort");
  });

  test("a plan named cheapest really is cheaper than A", () => {
    for (const p of plans())
      if (p.name === "cheapest") expect(p.stats.p50Cents).toBeLessThan(plans()[0]?.stats.p50Cents ?? 0);
  });

  test("never prices below the owner's floor; kept items are always hauled", () => {
    for (const p of plans())
      for (const c of p.choices) {
        const it = ITEMS.find((i) => i.id === c.itemId) as PlanItem;
        if (c.action === "sell_early") expect(c.askCents).toBe(floorOf(it));
        if (c.action === "sell") expect(c.askCents).toBe(it.listCents);
        if (it.keep) expect(c.action).toBe("haul");
      }
  });

  test("percentiles are ordered and the band ends at the final spread", () => {
    for (const p of plans()) {
      expect(p.stats.p10Cents).toBeLessThanOrEqual(p.stats.p50Cents);
      expect(p.stats.p50Cents).toBeLessThanOrEqual(p.stats.p90Cents);
      expect(p.stats.quantiles).toHaveLength(101);
      expect(p.stats.band.at(-1)?.p50).toBe(p.stats.p50Cents);
    }
  });

  test("a bigger budget never lowers the chance", () => {
    const tight = plans({ budgetCents: 28000 })[0]?.stats.chanceUnderBudget ?? 0;
    const loose = plans({ budgetCents: 60000 })[0]?.stats.chanceUnderBudget ?? 0;
    expect(loose).toBeGreaterThanOrEqual(tight);
    expect(loose).toBe(1);
  });

  test("truck size follows the hauled weight", () => {
    const [small, mid, big] = ASSUMPTIONS.trucks;
    expect(truckFor(0)).toEqual(small as never);
    expect(truckFor((small?.capacityLb ?? 0) - ASSUMPTIONS.baseLoadLb + 1)).toEqual(mid as never);
    expect(truckFor(99_999)).toEqual(big as never);
  });

  test("says why when there's nothing to plan", () => {
    const none = draftPlans(input({ items: [] }));
    expect(none.ok).toBe(false);
    const past = draftPlans(input({ moveOutDate: "2026-10-18" }));
    expect(past.ok).toBe(false);
    const unpriced = draftPlans(input({ items: [{ ...(ITEMS[0] as PlanItem), listCents: 0 }] }));
    expect(unpriced.ok).toBe(false);
    if (!unpriced.ok) expect(unpriced.skipped).toEqual(["couch"]);
  });
});
