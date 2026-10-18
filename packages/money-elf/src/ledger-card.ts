/**
 * The Ledger as pictures, drawn in the dashboard's design system (decision #64): warm neutrals, ink with one lime
 * accent, Inter, hairline panels.
 *
 *   - The card (`ledgerCardSvg`): a tall image sent inline in the Photon 2.0 thread when the owner asks for the
 *     Ledger. Photon 2.0 has no app cards (decision #32), so a picture is the native option that needs no tap.
 *   - The preview (`ledgerPreviewSvg`): a 3:2 image, the page's og:image, which is what the iMessage mini app
 *     card shows in the bubble before it's tapped open. A tall image would be cropped there.
 *
 * Drawn as SVG and rendered to PNG with resvg and a bundled Inter font, so the images look the same on a laptop
 * and in the Linux container (which has no system fonts).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fmtDate, fmtUsd } from "./amounts.ts";
import type { LedgerView } from "./ledger-view.ts";
import { cardColors, planPath } from "./plan-chart.ts";
import { pct } from "./plans.ts";
import { netPhrase } from "./projection.ts";
import { projectionChart } from "./projection-chart.ts";

export const C = {
  canvas: "#F3F2EE",
  surface: "#FFFFFF",
  ink: "#0E0F0C",
  muted: "#77786F",
  line: "#E4E3DD",
  fill: "#F3F2EE",
  lime: "#D4F26A",
  good: "#137A47",
  okInk: "#F6F6F2",
  okMuted: "#A3A49C",
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Shorten to n characters, breaking at a word boundary when one is near. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:·-]+$/, "")}…`;
}

export function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Weight = 400 | 500 | 600 | 700;

export function text(
  x: number,
  y: number,
  s: string,
  size: number,
  weight: Weight,
  fill: string,
  anchor = "start",
  tracking = 0,
) {
  const ls = tracking ? ` letter-spacing="${(tracking * size).toFixed(2)}"` : "";
  return `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls}>${esc(s)}</text>`;
}

/** Rough Inter advance width, for placing text after text (resvg can't measure for us). */
function width(s: string, size: number, weight: Weight): number {
  // Inter's figures are tabular and wider than its average letter.
  const figures = (s.match(/[0-9$]/g) ?? []).length;
  const per = weight >= 600 ? 0.53 : 0.5;
  return (figures * 0.64 + (s.length - figures) * per) * size;
}

/** The Elves Ledger mark at (x, y), `s` px square: a ledger page, three entries, the last one highlighted. */
function mark(x: number, y: number, s: number): string {
  const u = s / 24;
  const bar = (bx: number, by: number, w: number, fill: string, op = 1) =>
    `<rect x="${x + bx * u}" y="${y + by * u}" width="${w * u}" height="${2 * u}" rx="${u}" fill="${fill}" opacity="${op}"/>`;
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${6 * u}" fill="${C.ink}"/>${bar(6, 7, 12, C.canvas, 0.55)}${bar(6, 11, 8, C.canvas, 0.55)}${bar(6, 15, 10, C.lime)}`;
}

/** Mark plus "Elves Ledger", baseline-aligned at y. */
function wordmark(x: number, y: number, size: number): string {
  const s = size * 1.5;
  return `${mark(x, y - s * 0.78, s)}${text(x + s + size * 0.55, y, "Elves", size, 600, C.ink)}${text(x + s + size * 0.55 + width("Elves ", size, 600), y, "Ledger", size, 600, C.muted)}`;
}

/** A lime tag ("Projected") followed by text, baseline at y. Returns the SVG. */
function tag(x: number, y: number, label: string, size: number): { svg: string; w: number } {
  const w = width(label, size, 600) + size * 1.2;
  const h = size * 1.9;
  return {
    svg: `<rect x="${x}" y="${y - h * 0.7}" width="${w}" height="${h}" rx="${size * 0.5}" fill="${C.lime}"/>${text(x + size * 0.65, y, label, size, 600, C.ink)}`,
    w,
  };
}

function panel(x: number, y: number, w: number, h: number, r: number, fill = C.surface, stroke = C.line) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="2"` : ""}/>`;
}

/** Where the projection lands, as the line after the lime tag. */
function landing(v: LedgerView): { tag: string; rest: string; bold: string } | null {
  const p = v.projection;
  if (p.expectedCents > 0)
    return {
      tag: "Projected",
      bold: netPhrase(p.projectedNetCents),
      rest: `${p.projectedNetCents < 0 ? "once all is back" : "net"}, by ${fmtDate(p.settledBy ?? v.asOf.slice(0, 10))}`,
    };
  if (v.pendingActions.length)
    return { tag: "Waiting", bold: `${v.pendingActions.length} on your OK`, rest: "" };
  return null;
}

// ---------- the tall card (Photon 2.0 thread) ----------

const W = 1080;
const PAD = 56;

/** The card as SVG. Height grows with the number of rows. */
export function ledgerCardSvg(v: LedgerView): string {
  const parts: string[] = [];
  const p = v.projection;
  const inner = W - 2 * PAD;
  let y = PAD + 44;

  parts.push(wordmark(PAD, y, 32));
  parts.push(
    `<circle cx="${W - PAD - width("Live from Nessie", 24, 500) - 18}" cy="${y - 8}" r="7" fill="${C.good}"/>`,
  );
  parts.push(text(W - PAD, y, "Live from Nessie", 24, 500, C.muted, "end"));
  y += 92;

  // The headline number and where it lands.
  parts.push(text(PAD, y, "Net cost so far", 28, 500, C.muted));
  y += 112;
  const ahead = p.netNowCents < 0;
  parts.push(
    text(PAD - 4, y, fmtUsd(Math.abs(p.netNowCents)), 120, 600, ahead ? C.good : C.ink, "start", -0.045),
  );
  if (ahead)
    parts.push(
      text(PAD + width(fmtUsd(Math.abs(p.netNowCents)), 120, 600) - 10, y, "ahead", 34, 500, C.good),
    );
  y += 58;
  parts.push(text(PAD, y, `${fmtUsd(p.outCents)} out  ·  ${fmtUsd(p.backCents)} back`, 28, 400, C.muted));
  const land = landing(v);
  if (land) {
    y += 70;
    const t = tag(PAD, y, land.tag, 24);
    parts.push(t.svg);
    let x = PAD + t.w + 18;
    parts.push(text(x, y, land.bold, 30, 600, C.ink));
    x += width(land.bold, 30, 600) + 12;
    if (land.rest) parts.push(text(x, y, land.rest, 28, 400, C.muted));
  }
  y += 44;

  // The projection chart.
  if (p.expectedCents > 0) {
    const h = 300;
    parts.push(panel(PAD, y, inner, h, 32));
    parts.push(
      projectionChart(
        p,
        { x: PAD + 36, y: y + 28, w: inner - 72, h: h - 56 },
        { line: C.ink, grid: C.muted, text: C.ink, muted: C.muted, bg: C.surface },
        { size: 24, family: "Inter" },
      ),
    );
    y += h + 28;
  }

  // Move Plans (decision #77): the chosen plan's likely cost, its odds, and its path with the real net cost on top.
  const plan = v.plans?.chosen;
  if (v.plans && plan) {
    const h = 400;
    parts.push(panel(PAD, y, inner, h, 32));
    parts.push(text(PAD + 36, y + 58, `Plan ${plan.label} · ${plan.name}`, 24, 500, C.muted));
    parts.push(
      text(
        PAD + 36,
        y + 106,
        `${netPhrase(plan.stats.p50Cents)} likely · ${pct(plan.stats.chanceUnderBudget)} under ${fmtUsd(v.plans.budgetCents)}`,
        34,
        600,
        C.ink,
      ),
    );
    parts.push(
      planPath(
        plan,
        v.plans.budgetCents,
        v.plans.history,
        v.plans.moveOutDate,
        { x: PAD + 36, y: y + 130, w: inner - 72, h: h - 158 },
        cardColors(),
        { size: 24, family: "Inter" },
      ),
    );
    y += h + 28;
  }

  // Anything waiting for the owner's OK: the one inverted panel.
  if (v.pending[0]) {
    const h = 150;
    parts.push(panel(PAD, y, inner, h, 32, C.ink, ""));
    parts.push(`<circle cx="${PAD + 42}" cy="${y + 47}" r="7" fill="${C.lime}"/>`);
    parts.push(text(PAD + 60, y + 56, "Needs your OK", 24, 600, C.okInk));
    parts.push(text(W - PAD - 34, y + 56, `${v.pendingActions.length} waiting`, 24, 500, C.okMuted, "end"));
    parts.push(text(PAD + 34, y + 110, clip(capFirst(v.pending[0]), 52), 30, 500, C.okInk));
    y += h + 28;
  }

  // Balances, 2 x 2.
  const cell = inner / 2;
  const stats = [
    ["Moving Fund", v.fundCents],
    ["Owed to you", v.owedCents],
    ["In escrow", v.escrowCents],
    ["Deposits out", v.depositsOutCents],
  ] as const;
  const sh = 140;
  parts.push(panel(PAD, y, inner, sh * 2, 32));
  parts.push(`<rect x="${PAD + cell}" y="${y}" width="2" height="${sh * 2}" fill="${C.line}"/>`);
  parts.push(`<rect x="${PAD}" y="${y + sh}" width="${inner}" height="2" fill="${C.line}"/>`);
  stats.forEach(([label, cents], i) => {
    const x = PAD + (i % 2) * cell + 32;
    const top = y + Math.floor(i / 2) * sh;
    parts.push(text(x, top + 50, label, 24, 500, C.muted));
    parts.push(text(x, top + 108, fmtUsd(cents), 48, 600, C.ink, "start", -0.03));
  });
  y += sh * 2 + 52;

  // Lists: each a hairline panel of rows.
  const list = (title: string, rows: { left: string; sub?: string; right: string; good?: boolean }[]) => {
    if (!rows.length) return;
    parts.push(text(PAD + 4, y, title, 26, 600, C.ink));
    y += 24;
    const rh = 100;
    parts.push(panel(PAD, y, inner, rh * rows.length, 32));
    rows.forEach((r, i) => {
      const top = y + i * rh;
      if (i)
        parts.push(`<rect x="${PAD + 32}" y="${top}" width="${inner - 64}" height="2" fill="${C.line}"/>`);
      parts.push(text(PAD + 32, top + (r.sub ? 46 : 62), clip(capFirst(r.left), 36), 30, 500, C.ink));
      if (r.sub) parts.push(text(PAD + 32, top + 82, clip(r.sub, 48), 24, 400, C.muted));
      parts.push(text(W - PAD - 32, top + 62, r.right, 30, 600, r.good ? C.good : C.ink, "end"));
    });
    y += rh * rows.length + 56;
  };

  // Short on purpose: a name, one few-word note, the amount. The dashboard link has everything else.
  list(
    "Who owes you",
    v.owes.slice(0, 3).map((o) => ({
      left: o.name,
      sub: o.loan ? `${fmtUsd(o.loan.paidCents)} of ${fmtUsd(o.loan.totalCents)} paid` : "Waiting on them",
      right: fmtUsd(o.owedCents),
    })),
  );
  list("Held and due back", [
    ...v.escrow.slice(0, 2).map((e) => ({ left: e.item, sub: "In escrow", right: fmtUsd(e.cents) })),
    ...v.deposits.slice(0, 1).map((d) => ({
      left: `${d.what} deposit`,
      sub: d.dueBackAt ? `Back ${fmtDate(d.dueBackAt)}` : "Date not set",
      right: fmtUsd(d.cents),
    })),
  ]);

  if (!v.owes.length && !v.escrow.length && !v.deposits.length) {
    parts.push(text(PAD, y + 10, "Nothing on the Ledger yet.", 32, 600, C.ink));
    y += 70;
  }

  parts.push(
    text(
      W / 2,
      y + 4,
      "Everything else is in your dashboard link",
      24,
      400,
      C.muted,
      "middle",
    ),
  );
  const H = Math.round(y + 4 + PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.canvas}"/>${parts.join("")}</svg>`;
}

// ---------- the bubble preview (the mini app card's og:image) ----------

const PW = 1200;
const PH = 800;

/** The 3:2 preview: the headline number, where it lands, three balances and the chart. */
export function ledgerPreviewSvg(v: LedgerView): string {
  const p = v.projection;
  const X = 72;
  const parts: string[] = [];
  parts.push(wordmark(X, 112, 36));
  parts.push(text(PW - X, 112, `Live · ${fmtDate(v.asOf.slice(0, 10))}`, 28, 500, C.muted, "end"));

  // Left: the number.
  parts.push(text(X, 232, "Net cost so far", 32, 500, C.muted));
  const ahead = p.netNowCents < 0;
  parts.push(
    text(X - 6, 380, fmtUsd(Math.abs(p.netNowCents)), 156, 600, ahead ? C.good : C.ink, "start", -0.045),
  );
  const land = landing(v);
  if (land) {
    const t = tag(X, 462, land.tag, 28);
    parts.push(t.svg);
    parts.push(text(X + t.w + 20, 462, land.bold, 36, 600, C.ink));
    if (land.rest)
      parts.push(
        text(
          X + t.w + 34 + width(land.bold, 36, 600),
          462,
          land.rest.replace(/^net, /, ""),
          30,
          400,
          C.muted,
        ),
      );
  } else {
    parts.push(
      text(X, 462, ahead ? "ahead, and nothing else due back" : "Nothing else is due back", 32, 500, C.muted),
    );
  }

  // Right: three balances, hairline-separated.
  const rx = 760;
  const rows = [
    ["Moving Fund", v.fundCents],
    ["Owed to you", v.owedCents],
    ["Held and due back", v.escrowCents + v.depositsOutCents],
  ] as const;
  rows.forEach(([label, cents], i) => {
    const top = 196 + i * 96;
    if (i) parts.push(`<rect x="${rx}" y="${top - 18}" width="${PW - X - rx}" height="2" fill="${C.line}"/>`);
    parts.push(text(rx, top + 26, label, 26, 500, C.muted));
    parts.push(text(PW - X, top + 30, fmtUsd(cents), 38, 600, C.ink, "end", -0.02));
  });

  // Bottom: the chart in a panel.
  const top = 520;
  const h = PH - top - 56;
  parts.push(panel(X, top, PW - 2 * X, h, 28));
  const chart =
    p.expectedCents > 0
      ? projectionChart(
          p,
          { x: X + 32, y: top + 18, w: PW - 2 * X - 64, h: h - 36 },
          { line: C.ink, grid: C.muted, text: C.ink, muted: C.muted, bg: C.surface },
          { size: 22, family: "Inter" },
        )
      : "";
  parts.push(
    chart ||
      text(
        X + 36,
        top + h / 2 + 12,
        v.records ? "Nothing else is expected back." : "Nothing on the Ledger yet.",
        30,
        500,
        C.muted,
      ),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}"><rect width="${PW}" height="${PH}" fill="${C.canvas}"/>${parts.join("")}</svg>`;
}

// ---------- rendering ----------

let fontFiles: string[] | null = null;
function fonts(): string[] {
  if (fontFiles) return fontFiles;
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("@expo-google-fonts/inter/package.json"));
  fontFiles = [
    "400Regular/Inter_400Regular.ttf",
    "500Medium/Inter_500Medium.ttf",
    "600SemiBold/Inter_600SemiBold.ttf",
    "700Bold/Inter_700Bold.ttf",
  ].map((f) => join(root, f));
  return fontFiles;
}

/** Any card SVG as PNG bytes, with the bundled Inter font (Move Plans renders its own card with this too). */
export async function renderSvgPng(svgSource: string, w = W): Promise<Uint8Array<ArrayBuffer>> {
  const { Resvg } = await import("@resvg/resvg-js");
  const r = new Resvg(svgSource, {
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: w },
  });
  return new Uint8Array(r.render().asPng());
}

/** The card as PNG bytes, ready to upload as a Photon attachment. */
export function renderLedgerPng(v: LedgerView): Promise<Uint8Array<ArrayBuffer>> {
  return renderSvgPng(ledgerCardSvg(v), W);
}

/** The 3:2 bubble preview as PNG bytes (the dashboard's og:image). */
export function renderLedgerPreviewPng(v: LedgerView): Promise<Uint8Array<ArrayBuffer>> {
  return renderSvgPng(ledgerPreviewSvg(v), PW);
}
