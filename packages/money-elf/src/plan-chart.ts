/**
 * Move Plans as pictures (decision #77):
 * - planRace: each plan's spread of possible final costs as a curve, with the budget line and the under-budget
 *   side shaded, so "which plan is likely to land under $X" reads at a glance.
 * - planGrid: what each plan does with each item, plus the truck and movers.
 * - planPath: the chosen plan's likely net cost by day with its 10–90% band, and the real net cost drawn on top.
 * The builders draw into a box with given colors, so the PNG card (fixed colors) and the live page (CSS
 * variables) share them, like projection-chart.ts.
 */
import { fmtDate, fmtUsd } from "./amounts.ts";
import type { PlanState } from "./ledger.ts";
import { C, clip, esc, renderSvgPng, text } from "./ledger-card.ts";
import { ASSUMPTIONS, type Plan, pct } from "./plans.ts";
import { netPhrase } from "./projection.ts";

export interface PlanColors {
  /** One per plan label A, B, C. */
  series: [string, string, string];
  grid: string;
  text: string;
  muted: string;
  bg: string;
  shade: string;
}

export interface Font {
  size: number;
  family: string;
}

/**
 * Card colors in the Elves Ledger system (decision #64): the plans are three ink tones, since green means money in,
 * amber means waiting and neon blue is kept for "projected". A function, not a constant: ledger-card.ts and this file
 * import each other.
 */
export function cardColors(): PlanColors {
  return {
    series: [C.ink, "#6B6C64", "#A9A89F"],
    grid: C.line,
    text: C.ink,
    muted: C.muted,
    bg: C.surface,
    shade: C.fill,
  };
}

const colorOf = (c: PlanColors, label: string) => c.series[Math.max(0, "ABC".indexOf(label))] ?? c.series[0];

function label(x: number, y: number, s: string, f: Font, fill: string, anchor = "start", weight = 400) {
  return `<text x="${x}" y="${y}" font-family="${esc(f.family)}" font-size="${f.size}" font-weight="${weight}" text-anchor="${anchor}" style="fill:${fill}">${esc(s)}</text>`;
}

/** Smoothed density of a plan's final cost from its percentiles, over [lo, hi] in n bins. */
function density(quantiles: number[], lo: number, hi: number, n: number): number[] {
  const bins = new Array(n).fill(0) as number[];
  const span = hi - lo || 1;
  for (const q of quantiles) {
    const i = Math.min(n - 1, Math.max(0, Math.floor(((q - lo) / span) * n)));
    bins[i] = (bins[i] ?? 0) + 1;
  }
  const k = [1, 3, 5, 3, 1];
  return bins.map((_, i) => k.reduce((a, w, j) => a + w * (bins[i + j - 2] ?? 0), 0));
}

export function planRace(
  plans: Plan[],
  budgetCents: number,
  box: { x: number; y: number; w: number; h: number },
  c: PlanColors,
  f: Font,
): string {
  if (!plans.length) return "";
  const all = plans.flatMap((p) => p.stats.quantiles).concat(budgetCents);
  const pad = Math.max(2000, (Math.max(...all) - Math.min(...all)) * 0.08);
  const lo = Math.min(...all) - pad;
  const hi = Math.max(...all) + pad;
  const axisY = box.y + box.h - f.size * 1.4;
  const top = box.y + f.size * 1.6;
  const X = (cents: number) => box.x + ((cents - lo) / (hi - lo)) * box.w;
  const parts: string[] = [];
  const bx = Math.min(box.x + box.w, Math.max(box.x, X(budgetCents)));
  // Under budget is to the left of the budget line.
  parts.push(
    `<rect x="${box.x}" y="${top}" width="${bx - box.x}" height="${axisY - top}" style="fill:${c.shade};opacity:0.55"/>`,
  );
  parts.push(
    `<line x1="${box.x}" y1="${axisY}" x2="${box.x + box.w}" y2="${axisY}" style="stroke:${c.grid};stroke-width:2"/>`,
  );
  parts.push(
    `<line x1="${bx}" y1="${top - f.size * 0.4}" x2="${bx}" y2="${axisY}" style="stroke:${c.text};stroke-width:2;stroke-dasharray:8 6"/>`,
  );
  parts.push(label(bx, top - f.size * 0.7, `budget ${fmtUsd(budgetCents)}`, f, c.text, "middle"));

  // One label row per plan across the top; the curves live below them.
  const n = 40;
  const labelsH = plans.length * f.size * 1.35;
  const h = axisY - top - labelsH - f.size * 0.6;
  plans.forEach((p, i) => {
    const color = colorOf(c, p.label);
    const x50 = X(p.stats.p50Cents);
    if (p.stats.p90Cents - p.stats.p10Cents < (hi - lo) / n) {
      // A plan with almost no uncertainty (donate everything) is a single line, not a curve.
      parts.push(
        `<line x1="${x50}" y1="${axisY}" x2="${x50}" y2="${axisY - h}" style="stroke:${color};stroke-width:3"/>`,
      );
    } else {
      const d = density(p.stats.quantiles, lo, hi, n);
      const max = Math.max(...d) || 1;
      const step = box.w / n;
      const pts = d.map((v, j) => `${box.x + (j + 0.5) * step},${axisY - (v / max) * h}`);
      parts.push(
        `<path d="M${box.x},${axisY} L${pts.join(" L")} L${box.x + box.w},${axisY}" style="fill:${color};fill-opacity:0.08;stroke:${color};stroke-width:3;stroke-linejoin:round"/>`,
      );
    }
    const ly = top + f.size * 1.1 + i * f.size * 1.35;
    const anchor = x50 > box.x + box.w * 0.7 ? "end" : x50 < box.x + box.w * 0.3 ? "start" : "middle";
    // Keep start/end labels a little off the dot so they don't sit on the budget line.
    const lx = anchor === "start" ? x50 + f.size * 0.4 : anchor === "end" ? x50 - f.size * 0.4 : x50;
    parts.push(
      label(
        lx,
        ly,
        `${p.label} · ${netPhrase(p.stats.p50Cents)} · ${pct(p.stats.chanceUnderBudget)}`,
        f,
        color,
        anchor,
        600,
      ),
    );
    parts.push(`<circle cx="${x50}" cy="${axisY}" r="${f.size / 3}" style="fill:${color}"/>`);
  });
  parts.push(label(box.x, box.y + box.h, fmtUsd(Math.max(0, Math.round(lo / 100) * 100)), f, c.muted));
  parts.push(label(box.x + box.w, box.y + box.h, fmtUsd(Math.round(hi / 100) * 100), f, c.muted, "end"));
  parts.push(label(box.x + box.w / 2, box.y + box.h, "final move cost", f, c.muted, "middle"));
  return parts.join("");
}

function cellWords(p: Plan, itemId: string): string {
  const ch = p.choices.find((x) => x.itemId === itemId);
  if (!ch) return "—";
  switch (ch.action) {
    case "sell":
      return `sell ${fmtUsd(ch.askCents)}`;
    case "sell_early":
      return `drop to ${fmtUsd(ch.askCents)}`;
    case "donate":
      return "donate";
    default:
      return "haul";
  }
}

/** Items down the side, plans across. Returns the SVG and the height it used. */
export function planGrid(
  plans: Plan[],
  box: { x: number; y: number; w: number },
  c: PlanColors,
  f: Font,
): { svg: string; h: number } {
  const first = plans[0];
  if (!first) return { svg: "", h: 0 };
  const rowH = f.size * 2;
  const nameW = box.w * 0.28;
  const colW = (box.w - nameW) / plans.length;
  const parts: string[] = [];
  let y = box.y + f.size;
  plans.forEach((p, i) => {
    parts.push(
      label(box.x + nameW + i * colW, y, `${p.label} · ${p.name}`, f, colorOf(c, p.label), "start", 600),
    );
  });
  y += rowH * 0.6;
  const rows: { name: string; cells: string[] }[] = [
    ...first.choices.map((ch) => ({ name: ch.name, cells: plans.map((p) => cellWords(p, ch.itemId)) })),
    { name: "truck", cells: plans.map((p) => p.truck.size) },
    { name: "movers", cells: plans.map((p) => (p.movers ? "yes" : "no")) },
  ];
  for (const r of rows) {
    parts.push(
      `<line x1="${box.x}" y1="${y}" x2="${box.x + box.w}" y2="${y}" style="stroke:${c.grid};stroke-width:2"/>`,
    );
    y += rowH * 0.72;
    parts.push(label(box.x, y, clip(r.name, 16), f, c.muted));
    r.cells.forEach((cell, i) => {
      parts.push(label(box.x + nameW + i * colW, y, cell, f, c.text));
    });
    y += rowH * 0.28;
  }
  return { svg: parts.join(""), h: y - box.y };
}

export function planPath(
  plan: Plan,
  budgetCents: number,
  history: { date: string; netCents: number }[],
  moveOutDate: string,
  box: { x: number; y: number; w: number; h: number },
  c: PlanColors,
  f: Font,
): string {
  const band = plan.stats.band;
  if (band.length < 2) return "";
  const color = colorOf(c, plan.label);
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  const dates = [...band.map((b) => b.date), ...history.map((h) => h.date)].sort();
  const d0 = day(dates[0] as string);
  const d1 = Math.max(d0 + 1, day(dates.at(-1) as string));
  const vals = [...band.flatMap((b) => [b.p10, b.p90]), ...history.map((h) => h.netCents), budgetCents, 0];
  const vMax = Math.max(...vals);
  const vMin = Math.min(...vals);
  const top = box.y + f.size * 1.6;
  const bottom = box.y + box.h - f.size * 1.6;
  const X = (iso: string) => box.x + ((day(iso) - d0) / (d1 - d0)) * box.w;
  const Y = (v: number) => top + ((vMax - v) / (vMax - vMin || 1)) * (bottom - top);
  const parts: string[] = [];
  const upper = band.map((b) => `${X(b.date)},${Y(b.p90)}`);
  const lower = [...band].reverse().map((b) => `${X(b.date)},${Y(b.p10)}`);
  parts.push(
    `<path d="M${upper.join(" L")} L${lower.join(" L")} Z" style="fill:${color};fill-opacity:0.12;stroke:none"/>`,
  );
  parts.push(
    `<path d="M${band.map((b) => `${X(b.date)},${Y(b.p50)}`).join(" L")}" style="fill:none;stroke:${color};stroke-width:3;stroke-linejoin:round"/>`,
  );
  const yb = Y(budgetCents);
  parts.push(
    `<line x1="${box.x}" y1="${yb}" x2="${box.x + box.w}" y2="${yb}" style="stroke:${c.text};stroke-width:2;stroke-dasharray:8 6"/>`,
  );
  parts.push(label(box.x + box.w, yb - f.size * 0.5, `budget ${fmtUsd(budgetCents)}`, f, c.text, "end"));
  const xo = X(moveOutDate);
  if (xo >= box.x && xo <= box.x + box.w) {
    parts.push(
      `<line x1="${xo}" y1="${top}" x2="${xo}" y2="${bottom}" style="stroke:${c.grid};stroke-width:2"/>`,
    );
    // Near the right edge the label hangs left of the line, so it never runs off the card.
    const anchor = xo > box.x + box.w * 0.85 ? "end" : "middle";
    parts.push(label(xo, top - f.size * 0.5, "move-out", f, c.muted, anchor));
  }
  // The real net cost, one dot per day it was checked.
  if (history.length > 1)
    parts.push(
      `<path d="M${history.map((h) => `${X(h.date)},${Y(h.netCents)}`).join(" L")}" style="fill:none;stroke:${c.text};stroke-width:2"/>`,
    );
  for (const h of history)
    parts.push(
      `<circle cx="${X(h.date)}" cy="${Y(h.netCents)}" r="${f.size / 3.2}" style="fill:${c.text}"/>`,
    );
  parts.push(label(box.x, box.y + box.h, fmtDate(dates[0] as string), f, c.muted));
  parts.push(label(box.x + box.w, box.y + box.h, fmtDate(dates.at(-1) as string), f, c.muted, "end"));
  return parts.join("");
}

const W = 1080;
const PAD = 56;

function panelRect(x: number, y: number, w: number, h: number) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="32" fill="${C.surface}" stroke="${C.line}" stroke-width="2"/>`;
}

/** The picture sent with the draft, in the Elves Ledger system: the race between the plans, then the grid. */
export function plansCardSvg(state: PlanState): string {
  const parts: string[] = [];
  const inner = W - 2 * PAD;
  const colors = cardColors();
  const f = { size: 24, family: "Inter" };
  let y = PAD + 44;
  parts.push(text(PAD, y, "Move Plans", 32, 600, C.ink));
  parts.push(text(W - PAD, y, "estimates, not quotes", 24, 500, C.muted, "end"));
  y += 70;
  parts.push(
    text(
      PAD,
      y,
      `Under ${fmtUsd(state.budgetCents)} · move-out ${fmtDate(state.moveOutDate)}`,
      28,
      500,
      C.muted,
    ),
  );
  y += 36;

  const raceH = 440;
  parts.push(panelRect(PAD, y, inner, raceH));
  parts.push(
    planRace(
      state.drafts,
      state.budgetCents,
      { x: PAD + 36, y: y + 28, w: inner - 72, h: raceH - 56 },
      colors,
      f,
    ),
  );
  y += raceH + 56;

  parts.push(text(PAD + 4, y, "What each plan does", 26, 600, C.ink));
  y += 24;
  const grid = planGrid(state.drafts, { x: PAD + 36, y: y + 16, w: inner - 72 }, colors, f);
  parts.push(panelRect(PAD, y, inner, grid.h + 48));
  parts.push(grid.svg);
  y += grid.h + 48 + 52;
  parts.push(
    text(
      W / 2,
      y,
      `% = chance of finishing under budget, from 2,000 simulated moves per plan`,
      22,
      400,
      C.muted,
      "middle",
    ),
  );
  y += 34;
  parts.push(
    text(
      W / 2,
      y,
      `Trucks from a rate table: ${ASSUMPTIONS.trucks.map((t) => `${t.size} ${fmtUsd(t.cents)}`).join(" · ")}`,
      22,
      400,
      C.muted,
      "middle",
    ),
  );
  const H = Math.round(y + PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.canvas}"/>${parts.join("")}</svg>`;
}

export function renderPlansPng(state: PlanState): Promise<Uint8Array<ArrayBuffer>> {
  return renderSvgPng(plansCardSvg(state));
}
