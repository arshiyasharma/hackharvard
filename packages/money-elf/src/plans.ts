/**
 * Move Plans (decision #77): three ways to run the rest of the move, each with a projected cost and the chance of
 * finishing under the owner's budget.
 *
 * A plan says, for every listed item, whether to sell it at the list price (Last Call drops it on schedule),
 * drop it to the floor now so it sells sooner, donate it, or haul it; plus the truck size and whether to hire
 * movers. Each plan is run a couple of thousand times with a seeded random draw per item per day, so the result
 * is a spread of possible final costs rather than one number.
 *
 * The odds come from the assumptions table below, not from data: every likelihood is an estimate and the page
 * prints the table. Pure: no I/O, and the same input and seed always give the same plans.
 */

/** Sale odds, truck sizes and fees. Estimates, not quotes; the Ledger page prints them. */
export const ASSUMPTIONS = {
  /** Chance per day that an item at its list price sells, by category. */
  saleRatePerDay: {
    furniture: 0.07,
    electronics: 0.1,
    appliance: 0.08,
    decor: 0.05,
    other: 0.06,
  } as Record<string, number>,
  /** How much a lower price raises the daily chance: rate × (list / price)^elasticity. */
  priceElasticity: 2,
  /** Daily sale chance never goes above this. */
  maxDailyChance: 0.6,
  /** Last Call (packages/engine/src/deals.ts droppedAsk): 60% of list from T−48h, free from T−24h. */
  lastCallDrop: 0.6,
  /** Chance someone takes a free item in its last day. */
  freeTakeChance: 0.7,
  /** Junk removal for anything still there on move-out day, per item. */
  dumpCents: 2500,
  /** When an item has no floor, the floor is this share of its list price. */
  defaultFloorShare: 0.7,
  /** Boxes, the bed and everything that isn't a listed item. */
  baseLoadLb: 600,
  /** Rate table, not a quote: one-day local rental including typical mileage. */
  trucks: [
    { size: "10 ft", cents: 9000, capacityLb: 1500 },
    { size: "15 ft", cents: 13000, capacityLb: 3000 },
    { size: "20 ft", cents: 17000, capacityLb: 5000 },
  ] as Truck[],
  /** Two movers for about three hours. */
  moversCents: 30000,
} as const;

export interface Truck {
  size: string;
  cents: number;
  capacityLb: number;
}

export interface PlanItem {
  id: string;
  name: string;
  category: string;
  weightLb: number;
  listCents: number;
  floorCents: number | null;
  /** The owner keeps it: it's always hauled. */
  keep?: boolean;
}

export type ItemAction = "sell" | "sell_early" | "donate" | "haul";

export interface PlanChoice {
  itemId: string;
  name: string;
  action: ItemAction;
  /** The asking price this plan starts the item at (0 for donate and haul). */
  askCents: number;
  /** YYYY-MM-DD the price drops: Last Call's drop for sell, today for sell_early. */
  dropOn: string | null;
  /** Chance it sells for money by move-out. */
  sellChance: number;
  /** YYYY-MM-DD it most likely sells, or null if it more likely doesn't. */
  likelySaleDate: string | null;
  /** What it most likely sells for. */
  likelySaleCents: number;
}

export interface PlanStats {
  p10Cents: number;
  p50Cents: number;
  p90Cents: number;
  /** 0..1 */
  chanceUnderBudget: number;
  /** Final net cost at each percentile 0..100, for the cost-spread chart. */
  quantiles: number[];
  /** Net cost by day: the likely line and the 10–90% band. */
  band: { date: string; p10: number; p50: number; p90: number }[];
}

export type PlanLabel = "A" | "B" | "C";
/** Named from the final numbers, so a name never overclaims (decision #77). */
export type PlanName = "best odds" | "cheapest" | "runner-up" | "least effort";

export interface Plan {
  id: string;
  label: PlanLabel;
  name: PlanName;
  choices: PlanChoice[];
  truck: Truck;
  movers: boolean;
  stats: PlanStats;
}

export interface PlanInput {
  moveId: string;
  items: PlanItem[];
  /** YYYY-MM-DD */
  moveOutDate: string;
  budgetCents: number;
  /** What the move has cost so far (projection.netNowCents). */
  netNowCents: number;
  /** Money already expected back, with dates (projection.expected). */
  expected: { date: string; cents: number }[];
  now: Date;
  /** Default: the move id and today, so the same day gives the same plans. */
  seed?: string;
  /** Simulation runs per plan (default 2000). */
  runs?: number;
}

export type DraftResult =
  | { ok: true; plans: Plan[]; skipped: string[] }
  | { ok: false; reason: string; skipped: string[] };

// ---------------------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so a plan run is repeatable. */
export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function floorOf(item: PlanItem): number {
  const f = item.floorCents ?? Math.round((item.listCents * ASSUMPTIONS.defaultFloorShare) / 100) * 100;
  return Math.min(item.listCents, Math.max(100, f));
}

/** The smallest truck that fits the base load plus everything hauled (the biggest one if nothing fits). */
export function truckFor(haulLb: number): Truck {
  const need = ASSUMPTIONS.baseLoadLb + haulLb;
  const ts = ASSUMPTIONS.trucks;
  return ts.find((t) => t.capacityLb >= need) ?? (ts[ts.length - 1] as Truck);
}

/** Daily chance an item sells at this price. */
export function dailyChance(item: PlanItem, priceCents: number): number {
  const base = ASSUMPTIONS.saleRatePerDay[item.category] ?? ASSUMPTIONS.saleRatePerDay.other ?? 0.06;
  const ratio = item.listCents / Math.max(1, priceCents);
  return Math.min(ASSUMPTIONS.maxDailyChance, base * ratio ** ASSUMPTIONS.priceElasticity);
}

/** The price an item asks on day d (0 = today, D = move-out day). 0 means free. */
function priceOn(item: PlanItem, action: ItemAction, d: number, D: number): number {
  if (d >= D - 1) return 0; // T−24h: Last Call relists it free.
  const start = action === "sell_early" ? floorOf(item) : item.listCents;
  if (d >= D - 2)
    return Math.min(
      start,
      Math.max(100, Math.round((item.listCents * ASSUMPTIONS.lastCallDrop) / 100) * 100),
    );
  return start;
}

interface Shape {
  actions: ItemAction[];
  movers: boolean;
}

interface SimOut {
  finals: Float64Array;
  /** Net cost per run per day, flattened [run * days + day]. */
  paths: Float64Array | null;
  days: number;
  /** Per item: runs where it sold for money, and the sale days and prices of those runs. */
  sold: { count: number; days: number[]; prices: number[] }[];
}

function simulate(input: PlanInput, shape: Shape, runs: number, seed: string, keepPaths: boolean): SimOut {
  const today = input.now.toISOString().slice(0, 10);
  const D = Math.max(1, dayDiff(today, input.moveOutDate));
  const lastExpected = input.expected.reduce((m, e) => Math.max(m, dayDiff(today, e.date)), 0);
  const days = Math.max(D, lastExpected) + 1;
  const items = input.items;
  const haulLb = items.reduce((a, it, i) => a + (shape.actions[i] === "haul" ? it.weightLb : 0), 0);
  const fixed = truckFor(haulLb).cents + (shape.movers ? ASSUMPTIONS.moversCents : 0);
  // Expected money by day (already agreed or estimated by the projection).
  const inflow = new Float64Array(days);
  for (const e of input.expected) {
    const d = Math.min(days - 1, Math.max(0, dayDiff(today, e.date)));
    inflow[d] = (inflow[d] ?? 0) + e.cents;
  }

  const r = rng(seed);
  const finals = new Float64Array(runs);
  const paths = keepPaths ? new Float64Array(runs * days) : null;
  const sold = items.map(() => ({ count: 0, days: [] as number[], prices: [] as number[] }));
  const delta = new Float64Array(days);
  for (let run = 0; run < runs; run++) {
    delta.fill(0);
    let dumped = 0;
    items.forEach((it, i) => {
      const a = shape.actions[i];
      // Draw every day even when the item is not for sale, so plans share the same luck (fair comparison).
      let saleDay = -1;
      let salePrice = 0;
      let gone = a === "donate" || a === "haul";
      for (let d = 0; d < D; d++) {
        const u = r();
        if (gone) continue;
        const price = priceOn(it, a as ItemAction, d, D);
        const p = price === 0 ? ASSUMPTIONS.freeTakeChance : dailyChance(it, price);
        if (u < p) {
          gone = true;
          if (price > 0) {
            saleDay = d;
            salePrice = price;
          }
        }
      }
      if (!gone) dumped++;
      const tally = sold[i];
      if (saleDay >= 0 && tally) {
        delta[saleDay] = (delta[saleDay] ?? 0) - salePrice;
        tally.count++;
        tally.days.push(saleDay);
        tally.prices.push(salePrice);
      }
    });
    const out = Math.min(days - 1, D);
    delta[out] = (delta[out] ?? 0) + fixed + dumped * ASSUMPTIONS.dumpCents;
    let net = input.netNowCents;
    for (let d = 0; d < days; d++) {
      net += (delta[d] ?? 0) - (inflow[d] ?? 0);
      if (paths) paths[run * days + d] = net;
    }
    finals[run] = net;
  }
  return { finals, paths, days, sold };
}

function quantile(sorted: Float64Array | number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i] as number;
}

function statsOf(input: PlanInput, sim: SimOut, runs: number): PlanStats {
  const finals = Float64Array.from(sim.finals).sort();
  const today = input.now.toISOString().slice(0, 10);
  const band: PlanStats["band"] = [];
  if (sim.paths) {
    const col = new Float64Array(runs);
    for (let d = 0; d < sim.days; d++) {
      for (let run = 0; run < runs; run++) col[run] = sim.paths[run * sim.days + d] as number;
      col.sort();
      band.push({
        date: addDays(today, d),
        p10: Math.round(quantile(col, 0.1)),
        p50: Math.round(quantile(col, 0.5)),
        p90: Math.round(quantile(col, 0.9)),
      });
    }
  }
  let under = 0;
  for (const f of finals) if (f <= input.budgetCents) under++;
  return {
    p10Cents: Math.round(quantile(finals, 0.1)),
    p50Cents: Math.round(quantile(finals, 0.5)),
    p90Cents: Math.round(quantile(finals, 0.9)),
    chanceUnderBudget: under / runs,
    quantiles: Array.from({ length: 101 }, (_, i) => Math.round(quantile(finals, i / 100))),
    band,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : 0;
}

function buildPlan(
  input: PlanInput,
  shape: Shape,
  label: PlanLabel,
  name: PlanName,
  seed: string,
  runs: number,
): Plan {
  const today = input.now.toISOString().slice(0, 10);
  const D = Math.max(1, dayDiff(today, input.moveOutDate));
  const sim = simulate(input, shape, runs, seed, true);
  const haulLb = input.items.reduce((a, it, i) => a + (shape.actions[i] === "haul" ? it.weightLb : 0), 0);
  const choices: PlanChoice[] = input.items.map((it, i) => {
    const action = shape.actions[i] as ItemAction;
    const s = sim.sold[i] as SimOut["sold"][number];
    const selling = action === "sell" || action === "sell_early";
    const sellChance = selling ? s.count / runs : 0;
    return {
      itemId: it.id,
      name: it.name,
      action,
      askCents: action === "sell" ? it.listCents : action === "sell_early" ? floorOf(it) : 0,
      dropOn: action === "sell" ? addDays(today, Math.max(0, D - 2)) : action === "sell_early" ? today : null,
      sellChance,
      likelySaleDate: sellChance >= 0.5 ? addDays(today, median(s.days)) : null,
      likelySaleCents: sellChance >= 0.5 ? median(s.prices) : 0,
    };
  });
  return {
    id: `${label}${signature(shape)}`,
    label,
    name,
    choices,
    truck: truckFor(haulLb),
    movers: shape.movers,
    stats: statsOf(input, sim, runs),
  };
}

function signature(s: Shape): string {
  const code = { sell: "s", sell_early: "e", donate: "d", haul: "h" } as const;
  return `${s.actions.map((a) => code[a]).join("")}${s.movers ? "m" : ""}`;
}

/**
 * Draft three plans: A the lowest likely cost, B the best chance of finishing under budget, C the least
 * effort (fewest things to sell). Items without a list price are skipped and named.
 */
export function draftPlans(input: PlanInput): DraftResult {
  // Kept items are hauled whatever their price; anything else needs a price to plan around.
  const priced = (it: PlanItem) => it.keep || it.listCents > 0;
  const skipped = input.items.filter((it) => !priced(it)).map((it) => it.name);
  const items = input.items.filter(priced);
  if (!items.some((it) => !it.keep))
    return { ok: false, reason: "there are no listed items with a price to plan around", skipped };
  const today = input.now.toISOString().slice(0, 10);
  if (dayDiff(today, input.moveOutDate) < 1)
    return { ok: false, reason: "move-out is today or already past", skipped };
  if (!(input.budgetCents > 0)) return { ok: false, reason: "the budget has to be a dollar amount", skipped };

  const inp: PlanInput = { ...input, items };
  const seed = input.seed ?? `${input.moveId}:${today}`;
  const pick = (r: () => number): ItemAction => {
    const x = r();
    return x < 0.45 ? "sell" : x < 0.85 ? "sell_early" : "donate";
  };
  const fixedFor = (it: PlanItem, a: ItemAction): ItemAction => (it.keep ? "haul" : a);
  const shapes: Shape[] = [
    { actions: items.map((it) => fixedFor(it, "sell")), movers: false },
    { actions: items.map((it) => fixedFor(it, "sell_early")), movers: false },
    { actions: items.map((it) => fixedFor(it, "donate")), movers: true },
    { actions: items.map((it) => fixedFor(it, "donate")), movers: false },
  ];
  const r = rng(`${seed}:search`);
  for (let i = 0; i < 150; i++)
    shapes.push({ actions: items.map((it) => fixedFor(it, pick(r))), movers: r() < 0.2 });

  // Score every shape on the same luck with a short run, then rerun the winners in full.
  const seen = new Set<string>();
  const scored = shapes
    .filter((s) => {
      const k = signature(s);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((s) => {
      const sim = simulate(inp, s, 400, `${seed}:score`, false);
      const sorted = Float64Array.from(sim.finals).sort();
      let under = 0;
      for (const f of sorted) if (f <= inp.budgetCents) under++;
      const sells = s.actions.filter((a) => a === "sell" || a === "sell_early").length;
      return { s, p50: quantile(sorted, 0.5), chance: under / sorted.length, sells };
    });

  // Rerun the front-runners in full, then name the plans from those final numbers.
  const runs = input.runs ?? 2000;
  const byChance = [...scored].sort((x, y) => y.chance - x.chance || x.p50 - y.p50).slice(0, 6);
  const byCost = [...scored].sort((x, y) => x.p50 - y.p50 || y.chance - x.chance).slice(0, 6);
  const byEffort = [...scored].sort(
    (x, y) => x.sells - y.sells || Number(y.s.movers) - Number(x.s.movers) || x.p50 - y.p50,
  )[0];
  const full = new Map<string, Plan>();
  for (const x of [...byChance, ...byCost]) {
    const k = signature(x.s);
    if (!full.has(k)) full.set(k, buildPlan(inp, x.s, "A", "best odds", `${seed}:final`, runs));
  }
  const finals = [...full.values()];
  const best = [...finals].sort(
    (x, y) => y.stats.chanceUnderBudget - x.stats.chanceUnderBudget || x.stats.p50Cents - y.stats.p50Cents,
  )[0] as Plan;
  const effortKey = byEffort ? signature(byEffort.s) : "";
  // B should be a real alternative: prefer one that differs from A on at least two items.
  const differs = (p: Plan) => p.choices.filter((c, i) => c.action !== best.choices[i]?.action).length;
  const rest = finals
    .filter((p) => p !== best && p.id.slice(1) !== effortKey)
    .sort((x, y) => Number(differs(y) >= 2) - Number(differs(x) >= 2) || x.stats.p50Cents - y.stats.p50Cents);
  const second = rest[0];
  const plans: Plan[] = [{ ...best, label: "A", id: `A${best.id.slice(1)}`, name: "best odds" }];
  if (second)
    plans.push({
      ...second,
      label: "B",
      id: `B${second.id.slice(1)}`,
      name: second.stats.p50Cents < best.stats.p50Cents ? "cheapest" : "runner-up",
    });
  if (byEffort && effortKey !== best.id.slice(1))
    plans.push(
      buildPlan(inp, byEffort.s, plans.length === 1 ? "B" : "C", "least effort", `${seed}:final`, runs),
    );
  return { ok: true, plans, skipped };
}

/** Re-score a plan's choices against today's state (for a switch or the drift sweep). */
export function rescorePlan(input: PlanInput, plan: Plan): Plan {
  const byId = new Map(plan.choices.map((c) => [c.itemId, c.action]));
  const items = input.items.filter((it) => byId.has(it.id) || it.keep);
  const shape: Shape = {
    actions: items.map((it) => (it.keep ? "haul" : (byId.get(it.id) as ItemAction))),
    movers: plan.movers,
  };
  const today = input.now.toISOString().slice(0, 10);
  const seed = input.seed ?? `${input.moveId}:${today}`;
  const fresh = buildPlan(
    { ...input, items },
    shape,
    plan.label,
    plan.name,
    `${seed}:final`,
    input.runs ?? 2000,
  );
  return { ...fresh, id: plan.id };
}

/** "62%" */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Three budgets to offer, from what the move has cost so far: a little over, comfortable, generous. */
export function suggestBudgets(netNowCents: number): number[] {
  const base = Math.max(netNowCents, 0);
  if (!base) return [20000, 40000, 60000];
  const up = (f: number) => Math.max(10000, Math.ceil((base * f) / 5000) * 5000);
  return [...new Set([up(1.1), up(1.4), up(1.8)])];
}
