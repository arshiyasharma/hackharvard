import type { Deal, Item, ItemOutcome } from "@elves/shared";
import type { Category } from "./facts.ts";
import { fmtUsd } from "./intake.ts";

/**
 * Avoided emissions per pound when an item is reused instead of landfilled, from EPA WARM source-reduction
 * factors (WARM v13 material documents, MTCO2E per short ton; 1 MTCO2E/short ton = 0.5 kg CO2e per lb).
 * WARM has no furniture or mattress category, so each category maps to the closest WARM material (the proxy).
 * Approximate, labeled as such in the report; recheck against the WARM v16 spreadsheet before quoting numbers.
 */
export const IMPACT_FACTORS: Record<
  Category,
  { kgCo2ePerLb: number; warmMaterial: string; mtco2ePerShortTon: number }
> = {
  couch: { kgCo2ePerLb: 1.915, warmMaterial: "Carpet (textile and foam proxy)", mtco2ePerShortTon: 3.83 },
  mattress: { kgCo2ePerLb: 1.915, warmMaterial: "Carpet (textile and foam proxy)", mtco2ePerShortTon: 3.83 },
  chair: { kgCo2ePerLb: 1.915, warmMaterial: "Carpet (textile and foam proxy)", mtco2ePerShortTon: 3.83 },
  desk_table: { kgCo2ePerLb: 1.115, warmMaterial: "Medium-density fiberboard", mtco2ePerShortTon: 2.23 },
  bookshelf_dresser: {
    kgCo2ePerLb: 1.115,
    warmMaterial: "Medium-density fiberboard",
    mtco2ePerShortTon: 2.23,
  },
  small: {
    kgCo2ePerLb: 1.01,
    warmMaterial: "Dimensional lumber (conservative proxy)",
    mtco2ePerShortTon: 2.02,
  },
  other: {
    kgCo2ePerLb: 1.01,
    warmMaterial: "Dimensional lumber (conservative proxy)",
    mtco2ePerShortTon: 2.02,
  },
};

export const IMPACT_SOURCE =
  "EPA Waste Reduction Model (WARM) v13 source-reduction factors, per material; category-to-material mapping is approximate";

const DIVERTED: readonly ItemOutcome[] = ["sold", "given", "donated"];

export interface MoveReport {
  byOutcome: Record<ItemOutcome, number>;
  lbDiverted: number;
  lbDumped: number;
  kgCo2eAvoided: number;
  /** From the agreed sale prices the Deal Engine reported, else the list price of sold items. */
  dollarsRecoveredCents: number;
  /** Items still without an outcome (the move isn't over, or Last Call hasn't closed them). */
  open: number;
  lines: { name: string; outcome: ItemOutcome; weightLb: number; kgCo2e: number }[];
  source: string;
  approximate: true;
}

/** Pure: the Move Report from items and their deals, so the numbers can be rebuilt at any time. */
export function moveReport(items: Item[], deals: Deal[] = []): MoveReport {
  const byOutcome: Record<ItemOutcome, number> = {
    listed: 0,
    sold: 0,
    given: 0,
    donated: 0,
    dumped: 0,
  };
  const agreed = new Map<string, number>();
  for (const d of deals)
    if (d.mode === "sell_item" && d.subjectId && d.agreedCents != null)
      agreed.set(d.subjectId, d.agreedCents);
  let lbDiverted = 0;
  let lbDumped = 0;
  let kg = 0;
  let dollars = 0;
  const lines: MoveReport["lines"] = [];
  for (const it of items) {
    byOutcome[it.outcome]++;
    const factor =
      IMPACT_FACTORS[(it.category as Category) in IMPACT_FACTORS ? (it.category as Category) : "other"];
    let itemKg = 0;
    if (DIVERTED.includes(it.outcome)) {
      lbDiverted += it.weightLb;
      itemKg = it.weightLb * factor.kgCo2ePerLb;
      kg += itemKg;
    }
    if (it.outcome === "dumped") lbDumped += it.weightLb;
    if (it.outcome === "sold") dollars += agreed.get(it.id) ?? it.listPriceCents ?? 0;
    lines.push({ name: it.name, outcome: it.outcome, weightLb: it.weightLb, kgCo2e: Math.round(itemKg) });
  }
  return {
    byOutcome,
    lbDiverted,
    lbDumped,
    kgCo2eAvoided: Math.round(kg),
    dollarsRecoveredCents: dollars,
    open: byOutcome.listed,
    lines,
    source: IMPACT_SOURCE,
    approximate: true,
  };
}

/** The report as a 2-4 line text. */
export function reportText(r: MoveReport): string {
  const parts: string[] = [];
  for (const k of ["sold", "given", "donated", "dumped"] as const)
    if (r.byOutcome[k]) parts.push(`${r.byOutcome[k]} ${k}`);
  const lines: string[] = [];
  if (r.lbDiverted > 0)
    lines.push(
      `Your move kept about ${r.lbDiverted} lb off the curb, roughly ${r.kgCo2eAvoided} kg CO2e avoided (EPA WARM, approximate).`,
    );
  else lines.push("Nothing has left the apartment yet, so no pounds diverted so far.");
  if (parts.length) lines.push(`So far: ${parts.join(", ")}${r.open ? `, ${r.open} still open` : ""}.`);
  else if (r.open) lines.push(`${r.open} item${r.open === 1 ? "" : "s"} still open.`);
  if (r.dollarsRecoveredCents > 0) lines.push(`Recovered ${fmtUsd(r.dollarsRecoveredCents)} from sales.`);
  if (r.lbDumped > 0) lines.push(`${r.lbDumped} lb went to the dump, and that counts against the total.`);
  return lines.join("\n");
}
