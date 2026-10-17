/**
 * The projection as an SVG step chart: the owner's net cost of the move over time. Money comes back in jumps
 * (a deposit, a loan payment), so the line steps down at each expected date. Hollow dots are estimated dates;
 * solid dots are scheduled ones. Shared by the live page (theme colors via CSS variables) and the PNG card
 * (fixed colors).
 */
import { fmtDate } from "./amounts.ts";
import { netPhrase, type Projection } from "./projection.ts";

export interface ChartColors {
  line: string;
  grid: string;
  text: string;
  muted: string;
  bg: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function days(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000;
}

/**
 * The chart's inner SVG elements, drawn into the box (x, y, w, h). Returns "" when there is nothing to chart
 * (no money expected back), so callers can skip the section.
 */
export function projectionChart(
  p: Projection,
  box: { x: number; y: number; w: number; h: number },
  c: ChartColors,
  font: { size: number; family: string },
): string {
  if (p.points.length < 2) return "";
  const pts = p.points;
  const d0 = days(pts[0]?.date ?? "");
  const d1 = Math.max(d0 + 1, days(pts.at(-1)?.date ?? ""));
  const values = [...pts.map((q) => q.netCents), 0];
  const vMax = Math.max(...values);
  const vMin = Math.min(...values);
  const span = vMax - vMin || 1;
  const labelH = font.size * 1.6;
  const top = box.y + labelH;
  const bottom = box.y + box.h - labelH;
  const left = box.x;
  const right = box.x + box.w;
  const X = (date: string) => left + ((days(date) - d0) / (d1 - d0)) * (right - left);
  const Y = (cents: number) => top + ((vMax - cents) / span) * (bottom - top);

  const estimatedDates = new Set(p.expected.filter((e) => e.certainty === "estimated").map((e) => e.date));
  const parts: string[] = [];
  // Zero line: below it, the move has paid for itself.
  const y0 = Y(0);
  parts.push(
    `<line x1="${left}" y1="${y0}" x2="${right}" y2="${y0}" style="stroke:${c.grid};stroke-width:${font.size / 8};stroke-dasharray:${font.size / 2} ${font.size / 3}"/>`,
  );
  // Step path.
  let d = "";
  pts.forEach((q, i) => {
    const x = X(q.date);
    const y = Y(q.netCents);
    if (i === 0) d += `M${x},${y}`;
    else d += `H${x}V${y}`;
  });
  parts.push(
    `<path d="${d}" style="fill:none;stroke:${c.line};stroke-width:${font.size / 4};stroke-linejoin:round"/>`,
  );
  // Dots: solid = scheduled, hollow = estimated.
  const r = font.size / 3;
  pts.forEach((q, i) => {
    const hollow = i > 0 && estimatedDates.has(q.date);
    parts.push(
      `<circle cx="${X(q.date)}" cy="${Y(q.netCents)}" r="${r}" style="fill:${hollow ? c.bg : c.line};stroke:${c.line};stroke-width:${font.size / 8}"/>`,
    );
  });
  const label = (x: number, y: number, s: string, anchor: string, fill: string, weight = 600) =>
    `<text x="${x}" y="${y}" font-family="${esc(font.family)}" font-size="${font.size}" font-weight="${weight}" text-anchor="${anchor}" style="fill:${fill}">${esc(s)}</text>`;
  const first = pts[0];
  const last = pts.at(-1);
  if (first)
    parts.push(
      label(left, Y(first.netCents) - font.size * 0.6, `Today ${netPhrase(first.netCents)}`, "start", c.text),
    );
  if (last && last !== first)
    parts.push(
      label(
        right - font.size,
        Y(last.netCents) - font.size * 0.6,
        `Projected ${netPhrase(last.netCents)}`,
        "end",
        c.text,
      ),
    );
  parts.push(label(left, box.y + box.h, fmtDate(first?.date ?? ""), "start", c.muted, 400));
  if (last) parts.push(label(right, box.y + box.h, fmtDate(last.date), "end", c.muted, 400));
  return parts.join("");
}
