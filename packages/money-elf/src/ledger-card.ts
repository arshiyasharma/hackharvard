/**
 * The Ledger card: an image sent inline in iMessage when the owner asks to see the Ledger.
 * Photon 2.0 has no app cards (decision #32), so a picture is the native-looking option that needs no tap.
 *
 * Drawn as SVG at phone width (2x), rendered to PNG with resvg and a bundled Inter font, so the card looks
 * the same on a laptop and in the Linux container (which has no system fonts).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fmtDate, fmtUsd } from "./amounts.ts";
import type { LedgerView } from "./ledger-view.ts";

const W = 1080;
const PAD = 64;
const C = {
  bg: "#F5F2EB",
  card: "#FFFFFF",
  ink: "#1D1B18",
  muted: "#6F6A61",
  line: "#E7E2D8",
  fund: "#1F7A4D",
  fundBg: "#E5F3EA",
  owed: "#A05A00",
  owedBg: "#FBEEDC",
  escrow: "#2457A6",
  escrowBg: "#E4ECF8",
  bar: "#E7E2D8",
  wait: "#FFF6D6",
  waitLine: "#E9C95A",
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function text(
  x: number,
  y: number,
  s: string,
  size: number,
  weight: 400 | 600 | 700,
  fill: string,
  anchor = "start",
) {
  return `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

/** The card as SVG. Height grows with the number of rows. */
export function ledgerCardSvg(v: LedgerView): string {
  const parts: string[] = [];
  let y = PAD + 40;
  parts.push(text(PAD, y + 24, "Moving Ledger", 60, 700, C.ink));
  y += 72;
  parts.push(
    text(
      PAD,
      y + 12,
      `${v.ownerName} move · ${fmtDate(v.asOf.slice(0, 10))} · live from Nessie`,
      30,
      400,
      C.muted,
    ),
  );
  y += 56;

  // Three headline tiles.
  const tiles = [
    { label: "Moving Fund", cents: v.fundCents, fg: C.fund, bg: C.fundBg },
    { label: "Owed to you", cents: v.owedCents, fg: C.owed, bg: C.owedBg },
    { label: "In escrow", cents: v.escrowCents, fg: C.escrow, bg: C.escrowBg },
  ];
  const gap = 24;
  const tw = (W - 2 * PAD - 2 * gap) / 3;
  tiles.forEach((t, i) => {
    const x = PAD + i * (tw + gap);
    parts.push(`<rect x="${x}" y="${y}" width="${tw}" height="168" rx="28" fill="${t.bg}"/>`);
    parts.push(text(x + 28, y + 58, t.label, 28, 600, t.fg));
    parts.push(text(x + 28, y + 132, fmtUsd(t.cents), 56, 700, t.fg));
  });
  y += 168 + 56;

  const section = (title: string) => {
    parts.push(text(PAD, y, title.toUpperCase(), 26, 700, C.muted));
    y += 24;
  };
  const row = (left: string, right: string, sub?: string, rightFill: string = C.ink) => {
    parts.push(text(PAD, y + 40, clip(capFirst(left), 34), 36, 600, C.ink));
    parts.push(text(W - PAD, y + 40, right, 36, 700, rightFill, "end"));
    if (sub) parts.push(text(PAD, y + 82, clip(sub, 52), 28, 400, C.muted));
    y += sub ? 104 : 68;
  };
  const rule = () => {
    parts.push(`<rect x="${PAD}" y="${y + 8}" width="${W - 2 * PAD}" height="2" fill="${C.line}"/>`);
    y += 40;
  };

  if (v.pending[0]) {
    const msg = clip(`Waiting on your OK: ${v.pending[0]}`, 64);
    parts.push(
      `<rect x="${PAD}" y="${y}" width="${W - 2 * PAD}" height="92" rx="22" fill="${C.wait}" stroke="${C.waitLine}" stroke-width="2"/>`,
    );
    parts.push(text(PAD + 28, y + 57, msg, 29, 600, C.ink));
    y += 92 + 44;
  }

  if (v.owes.length) {
    section("Who owes you");
    for (const o of v.owes.slice(0, 5)) {
      if (o.loan) {
        const pct = o.loan.totalCents ? o.loan.paidCents / o.loan.totalCents : 0;
        row(o.name, fmtUsd(o.owedCents), undefined, C.owed);
        const bw = W - 2 * PAD;
        parts.push(`<rect x="${PAD}" y="${y - 6}" width="${bw}" height="18" rx="9" fill="${C.bar}"/>`);
        parts.push(
          `<rect x="${PAD}" y="${y - 6}" width="${Math.max(18, Math.round(bw * pct))}" height="18" rx="9" fill="${C.fund}"/>`,
        );
        parts.push(
          text(
            PAD,
            y + 52,
            `Loan: ${fmtUsd(o.loan.paidCents)} of ${fmtUsd(o.loan.totalCents)} paid · ${fmtUsd(o.loan.monthlyCents)}/month`,
            28,
            400,
            C.muted,
          ),
        );
        y += 84;
      } else {
        row(o.name, fmtUsd(o.owedCents), "Payment request sent", C.owed);
      }
    }
    rule();
  }

  if (v.escrow.length) {
    section("Held in escrow");
    for (const e of v.escrow.slice(0, 3))
      row(e.item, fmtUsd(e.cents), `Paid by ${e.buyer}; released when pickup's confirmed`, C.escrow);
    rule();
  }

  if (v.deposits.length) {
    section("Deposits out");
    for (const d of v.deposits.slice(0, 3))
      row(
        d.what,
        fmtUsd(d.cents),
        d.dueBackAt ? `Due back ${fmtDate(d.dueBackAt)}` : "Due-back date not set",
      );
    rule();
  }

  if (v.recent.length) {
    section("Recent");
    for (const a of v.recent.slice(0, 5)) {
      const sign = a.direction === "in" ? "+" : "-";
      const where = a.account === "fund" ? "Moving Fund" : a.account === "escrow" ? "Escrow" : "You";
      row(
        a.label,
        `${sign}${fmtUsd(a.amountCents)}`,
        `${where} · ${fmtDate(a.date)}`,
        a.direction === "in" ? C.fund : C.ink,
      );
    }
  }

  if (!v.owes.length && !v.escrow.length && !v.deposits.length && !v.recent.length) {
    parts.push(text(PAD, y + 40, "Nothing on the Ledger yet.", 36, 600, C.muted));
    y += 80;
  }

  y += 24;
  parts.push(
    text(PAD, y + 20, `${v.records} Nessie records · tap the link for the live Ledger`, 26, 400, C.muted),
  );
  const H = Math.round(y + 20 + PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/><rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="44" fill="${C.card}"/>${parts.join("")}</svg>`;
}

let fontFiles: string[] | null = null;
function fonts(): string[] {
  if (fontFiles) return fontFiles;
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("@expo-google-fonts/inter/package.json"));
  fontFiles = [
    "400Regular/Inter_400Regular.ttf",
    "600SemiBold/Inter_600SemiBold.ttf",
    "700Bold/Inter_700Bold.ttf",
  ].map((f) => join(root, f));
  return fontFiles;
}

/** The card as PNG bytes, ready to upload as a Photon attachment. */
export async function renderLedgerPng(v: LedgerView): Promise<Uint8Array<ArrayBuffer>> {
  const { Resvg } = await import("@resvg/resvg-js");
  const r = new Resvg(ledgerCardSvg(v), {
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: W },
  });
  return new Uint8Array(r.render().asPng());
}
