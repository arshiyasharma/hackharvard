/**
 * The Move Money dashboard: what the iMessage mini app card opens (via Spectrum, decision #53) and what the
 * Photon 2.0 reply links. One design system with the card images (ledger-card.ts), decision #64: warm neutrals,
 * ink with a single lime accent, Inter with tabular figures, hairline panels, no decoration that isn't data.
 *
 *   - A segmented control: Overview, Coming back, Activity.
 *   - Overview: the headline number (net cost so far) and where it lands, the projection chart and what's
 *     next, anything waiting for the owner's OK (Approve / Not now, decision #62), balances, who owes you, and
 *     what's held or due back.
 *   - Coming back: a what-if projection. Switch off anything you're not counting on, or assume everyone pays two
 *     weeks late, and the chart and numbers redraw. Nothing is saved; it's a calculator.
 *   - Activity: every tagged Nessie movement.
 *   - Plan (Move Plans, decision #66): the drafts to pick from, or the chosen plan's path with its pending,
 *     completed and cancelled records read live from Nessie.
 *   - Tapping a person, an expected payment or an activity row opens a bottom sheet with its details, including
 *     the Nessie record id.
 *
 * The card opens this page in the expanded view (nearly full screen, scrollable; spectrum.ts). The page reloads
 * every 30 seconds to pick up new Nessie records, unless a sheet is open or the what-if was changed.
 * Served by ledger-http.ts behind a signed link; Approve / Not now POST to its /decide route.
 */
import { fmtDate, fmtUsd } from "./amounts.ts";
import { capFirst, esc } from "./ledger-card.ts";
import { type LedgerView, ledgerSummaryLine } from "./ledger-view.ts";
import { type PlanColors, planGrid, planPath, planRace } from "./plan-chart.ts";
import { ASSUMPTIONS, pct as pctOf } from "./plans.ts";
import { ASSUMED_DAYS, netPhrase } from "./projection.ts";

// ---------- icons (thin line glyphs, drawn inline so the page has no external assets) ----------

const svg = (d: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICON = {
  chevronRight: svg('<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>', 16),
  arrowDown: svg('<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>', 14),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 14),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 14),
};

/** The Elves Ledger mark: a ledger page, three entries, the last one highlighted. */
const MARK = `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" class="mk-bg"/><rect x="6" y="7" width="12" height="2" rx="1" class="mk-ln"/><rect x="6" y="11" width="8" height="2" rx="1" class="mk-ln"/><rect x="6" y="15" width="10" height="2" rx="1" class="mk-hi"/></svg>`;

// ---------- the chart, shared by the server and (via its source) the browser's what-if ----------

/**
 * The projection as a step area against a dashed break-even line. Money comes back in jumps, so it steps rather
 * than curves; hollow dots are estimated dates. Self-contained on purpose: the page ships its source
 * (`String(stepChartSvg)`) so the what-if redraws exactly the same chart in the browser.
 */
export function stepChartSvg(input: {
  points: { date: string; netCents: number }[];
  estimated: string[];
  width: number;
  height: number;
}): string {
  const pts = input.points;
  if (pts.length < 2) return "";
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const W = input.width;
  const H = input.height;
  const top = 10;
  const bottom = H - 22;
  const left = 8;
  const right = W - 10;
  const d0 = day(pts[0]?.date ?? "");
  const d1 = Math.max(d0 + 1, day(pts[pts.length - 1]?.date ?? ""));
  const vals = pts.map((q) => q.netCents).concat([0]);
  const vMax = Math.max(...vals);
  const vMin = Math.min(...vals);
  const span = vMax - vMin || 1;
  const X = (d: string) => left + ((day(d) - d0) / (d1 - d0)) * (right - left);
  const Y = (c: number) => top + ((vMax - c) / span) * (bottom - top);
  let line = "";
  pts.forEach((q, i) => {
    line += i === 0 ? `M${X(q.date)},${Y(q.netCents)}` : `H${X(q.date)}V${Y(q.netCents)}`;
  });
  const est = new Set(input.estimated);
  let dots = "";
  for (const q of pts.slice(1, -1))
    dots += `<circle cx="${X(q.date)}" cy="${Y(q.netCents)}" r="3" class="${est.has(q.date) ? "dot est" : "dot"}"/>`;
  const last = pts[pts.length - 1];
  const y0 = Y(0);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected net cost over time">
<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="fill-a"/><stop offset="1" class="fill-b"/></linearGradient></defs>
<path d="${line}V${bottom}H${left}Z" fill="url(#fill)"/>
<line x1="${left}" y1="${y0}" x2="${right}" y2="${y0}" class="zero"/>
<text x="${left + 2}" y="${y0 - 6}" class="zl">Break even</text>
<path d="${line}" class="ln"/>${dots}${last ? `<circle cx="${X(last.date)}" cy="${Y(last.netCents)}" r="5" class="end"/>` : ""}
<text x="${left}" y="${H - 4}" class="ax">Today</text>
<text x="${right}" y="${H - 4}" text-anchor="end" class="ax">${last ? fmt(last.date) : ""}</text>
</svg>`;
}

// ---------- page ----------

function days(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000;
}

function relDays(isoDate: string, today: string): string {
  const n = Math.round(days(isoDate) - days(today));
  if (n <= 0) return "today";
  if (n === 1) return "tomorrow";
  if (n < 14) return `in ${n} days`;
  return `on ${fmtDate(isoDate)}`;
}

/** JSON for a <script type="application/json"> block: no "</script>" can break out of it. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, " ");
}

/** An amount with its cents set smaller, the way statements print it: $12<small>.50</small>. */
function money(cents: number, sign = ""): string {
  const [whole, frac] = fmtUsd(Math.abs(cents)).split(".");
  return `${sign}${whole}${frac ? `<small>.${frac}</small>` : ""}`;
}

/** First letter of a name, for the round monogram next to a person. */
function initial(name: string): string {
  return esc((name.trim()[0] ?? "?").toUpperCase());
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const PENDING_VERB: Record<string, string> = {
  send_split_requests: "Send requests",
  release_escrow: "Release",
  refund_escrow: "Refund",
  pay_person: "Pay",
  create_loan: "Set up plan",
};

export function ledgerPageHtml(
  v: LedgerView,
  opts: { imageUrl: string; pageUrl: string; decideUrl?: string },
): string {
  const p = v.projection;
  const today = v.asOf.slice(0, 10);
  const summary = ledgerSummaryLine(v);
  // Anything at all to show: money spent or expected back, or a balance anywhere.
  const hasMoney =
    p.outCents > 0 ||
    p.expectedCents > 0 ||
    v.fundCents > 0 ||
    v.owedCents > 0 ||
    v.escrowCents > 0 ||
    v.depositsOutCents > 0;
  const estimatedDates = p.expected.filter((e) => e.certainty === "estimated").map((e) => e.date);
  const chart = (id = "") =>
    `<div class="chart-wrap"${id ? ` id="${id}"` : ""}>${stepChartSvg({ points: p.points, estimated: estimatedDates, width: 340, height: 120 })}</div>`;

  // ----- Overview: the headline number and where it lands -----
  const ahead = p.netNowCents < 0;
  const landsAhead = p.projectedNetCents < 0;
  const landing = !hasMoney
    ? ""
    : p.expectedCents > 0
      ? `<div class="land"><span class="tag">${ICON.arrowDown}Projected</span><b>${esc(netPhrase(p.projectedNetCents))}</b><span>${landsAhead ? "once all is back" : "net"}, by ${esc(fmtDate(p.settledBy ?? today))}</span></div>`
      : v.pendingActions.length
        ? `<div class="land wait"><span class="tag">${ICON.clock}Waiting</span><b>${plural(v.pendingActions.length, "move")}</b><span>on your OK</span></div>`
        : `<div class="land done"><span class="tag">${ICON.check}Settled</span><span>Nothing else is due back.</span></div>`;
  const next = p.expected[0];
  const nextRow = next
    ? `<button class="next" data-go="back"><span class="k">Next</span><span class="grow">${esc(capFirst(next.label))}</span><span class="muted">${esc(relDays(next.date, today))}</span>${ICON.chevronRight}</button>`
    : "";
  const hero = `<section class="hero">
<div class="eyebrow">Net cost so far</div>
<div class="figure${ahead ? " good" : ""}">${money(p.netNowCents)}${ahead ? '<span class="unit">ahead</span>' : ""}</div>
<div class="flow"><span>${fmtUsd(p.outCents)} out</span><i></i><span>${fmtUsd(p.backCents)} back</span></div>
${landing}
</section>
${
  hasMoney && p.points.length > 1
    ? `<div class="panel chart-panel">${chart()}${nextRow}</div>`
    : hasMoney
      ? ""
      : `<div class="panel empty"><b>Nothing on the Ledger yet.</b><span>Text Elves a shared cost or a deposit, like “split the $240 truck with Sam”, and it shows up here.</span></div>`
}`;

  // ----- Overview: needs your OK -----
  const approvals = v.pendingActions.length
    ? `<section class="ok" aria-label="Needs your OK">
<div class="ok-head"><span>Needs your OK</span><span class="count">${v.pendingActions.length} waiting</span></div>
${v.pendingActions
  .map((a) => {
    const verb = esc(PENDING_VERB[a.kind] ?? "Approve");
    return `<div class="ok-item" data-pending="${esc(a.id)}"><p>${esc(capFirst(a.summary))}</p><div class="actions"><button class="btn ghost" data-decide="decline">Not now</button><button class="btn primary" data-decide="approve" data-verb="${verb}">${verb}</button></div></div>`;
  })
  .join("")}
</section>`
    : "";

  // ----- Overview: balances -----
  const nextDeposit = v.deposits
    .filter((d) => d.dueBackAt)
    .sort((a, b) => (a.dueBackAt ?? "").localeCompare(b.dueBackAt ?? ""))[0];
  const stat = (label: string, cents: number, sub: string) =>
    `<div class="stat"><div class="k">${label}</div><div class="v">${money(cents)}</div><div class="s">${esc(sub)}</div></div>`;
  const stats = hasMoney
    ? `<div class="sh"><h2>Balances</h2><span class="meta">From Nessie · ${esc(fmtDate(today))}</span></div>
<div class="panel">
<div class="stats">
${stat("Moving Fund", v.fundCents, "Shares paid in")}
${stat("Owed to you", v.owedCents, v.owes.length ? plural(v.owes.length, "person", "people") : "Nobody owes you")}
${stat("In escrow", v.escrowCents, v.escrow.length ? plural(v.escrow.length, "sale") : "No sales held")}
${stat("Deposits out", v.depositsOutCents, nextDeposit?.dueBackAt ? `Next back ${fmtDate(nextDeposit.dueBackAt)}` : v.deposits.length ? "No due-back date" : "None out")}
</div>
<div class="li static"><div class="grow">Spent on the move</div><div class="amt">${money(v.spentCents)}</div></div>
</div>`
    : "";

  const owes = v.owes.length
    ? `<div class="sh"><h2>Who owes you</h2><span class="meta">${money(v.owedCents)}</span></div>
<div class="panel">${v.owes
        .map((o, i) => {
          const pct = o.loan?.totalCents ? Math.round((100 * o.loan.paidCents) / o.loan.totalCents) : 0;
          const sub = o.loan
            ? `Payment plan · ${fmtUsd(o.loan.paidCents)} of ${fmtUsd(o.loan.totalCents)} paid`
            : `${plural(o.bills.length || 1, "request")} sent`;
          return `<div class="li" data-sheet="owe:${i}" role="button" tabindex="0"><span class="av">${initial(o.name)}</span><div class="grow"><div>${esc(o.name)}</div><div class="sub">${esc(sub)}</div>${o.loan ? `<div class="meter"><div style="width:${Math.max(pct, 3)}%"></div></div>` : ""}</div><div class="amt">${money(o.owedCents)}</div><span class="chev">${ICON.chevronRight}</span></div>`;
        })
        .join("")}</div>`
    : "";

  const held = [
    ...v.escrow.map(
      (e) =>
        `<div class="li static"><div class="grow"><div>${esc(capFirst(e.item))} sale</div><div class="sub">In escrow · paid by ${esc(e.buyer)}, released at pickup</div></div><div class="amt">${money(e.cents)}</div></div>`,
    ),
    ...v.deposits.map(
      (d) =>
        `<div class="li static"><div class="grow"><div>${esc(capFirst(d.what))} deposit</div><div class="sub">${d.dueBackAt ? `Due back ${esc(fmtDate(d.dueBackAt))}` : "No due-back date yet"}</div></div><div class="amt">${money(d.cents)}</div></div>`,
    ),
  ];
  const heldOut = held.length
    ? `<div class="sh"><h2>Held and due back</h2><span class="meta">${money(v.escrowCents + v.depositsOutCents)}</span></div><div class="panel">${held.join("")}</div>`
    : "";

  // ----- Coming back: what-if -----
  const backTotal = p.backCents + p.expectedCents;
  const pct = backTotal ? Math.round((100 * p.backCents) / backTotal) : 0;
  const comingBack = p.expected.length
    ? `<section class="hero compact">
<div class="eyebrow">Projected net cost</div>
<div class="figure" id="wi-net">${esc(netPhrase(p.projectedNetCents))}</div>
<div class="flow" id="wi-sub">once ${fmtUsd(p.expectedCents)} is back · ${esc(fmtDate(p.settledBy ?? today))}</div>
</section>
<div class="panel chart-panel">${chart("wi-chart")}
<label class="toggle"><span class="grow">What if everyone pays two weeks late?</span><input type="checkbox" id="wi-late"><span class="switch"></span></label>
</div>
<div class="sh"><h2>Coming back</h2><span class="meta">${fmtUsd(p.backCents)} of ${fmtUsd(backTotal)} back</span></div>
<div class="progress" role="img" aria-label="${pct}% back"><div style="width:${Math.max(pct, 2)}%"></div></div>
<div class="panel">${p.expected
        .map(
          (x, i) =>
            `<div class="li"><div class="grow" data-sheet="expected:${i}" role="button" tabindex="0"><div>${esc(capFirst(x.label))}</div><div class="sub"><span class="cert ${x.certainty}"></span>${esc(fmtDate(x.date))} · ${x.certainty}</div></div><div class="amt good">${money(x.cents, "+")}</div><label class="toggle-mini" title="Counting on it"><input type="checkbox" checked data-count="${i}" aria-label="Count ${esc(x.label)}"><span class="switch"></span></label></div>`,
        )
        .join("")}</div>
<p class="note">Switch off anything you're not counting on; the chart and number redraw, and nothing is saved. <span class="cert scheduled"></span>Scheduled is a date someone agreed to. ${p.hasEstimates ? `<span class="cert estimated"></span>Estimated assumes a requested share is paid within ${ASSUMED_DAYS.share} days, a sale clears within ${ASSUMED_DAYS.sale} days, and a deposit with no due-back date returns within ${ASSUMED_DAYS.deposit} days.` : ""}</p>`
    : `<div class="panel empty"><b>Nothing is expected back.</b><span>Shares, sales and deposits you're owed show up here with the date they should land.</span></div>`;

  // ----- Activity -----
  const WHERE = { you: "Your account", fund: "Moving Fund", escrow: "Escrow" } as const;
  const activity = v.recent.length
    ? `<div class="sh first"><h2>Activity</h2><span class="meta">${plural(v.records, "Nessie record")}</span></div><div class="panel">${v.recent
        .map(
          (a, i) =>
            `<div class="li" data-sheet="activity:${i}" role="button" tabindex="0"><span class="date">${esc(fmtDate(a.date))}</span><div class="grow"><div>${esc(capFirst(a.label))}</div><div class="sub">${WHERE[a.account]}</div></div><div class="amt${a.direction === "in" ? " good" : ""}">${money(a.amountCents, a.direction === "in" ? "+" : "−")}</div><span class="chev">${ICON.chevronRight}</span></div>`,
        )
        .join("")}</div>`
    : `<div class="panel empty"><b>No money has moved yet.</b><span>Every payment, deposit and sale Elves records in Nessie is listed here.</span></div>`;

  // Data for sheets and the what-if, read by the script below.
  const data = {
    today,
    decideUrl: opts.decideUrl ?? null,
    netNowCents: p.netNowCents,
    expected: p.expected,
    owes: v.owes,
    recent: v.recent,
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Elves Ledger</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#F3F2EE">
<meta property="og:site_name" content="Elves Ledger">
<meta property="og:title" content="${esc(`${v.ownerName} Move Money`)}">
<meta property="og:description" content="${esc(summary)}">
<meta property="og:image" content="${esc(opts.imageUrl)}">
<meta property="og:url" content="${esc(opts.pageUrl)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{--canvas:#F3F2EE;--surface:#FFFFFF;--ink:#0E0F0C;--ink-2:#3B3C37;--muted:#77786F;--line:#E4E3DD;--fill:#F3F2EE;--lime:#D4F26A;--lime-ink:#0E0F0C;--good:#137A47;--wait:#8F5B00;--wait-soft:#FBF0D9;--ok-bg:#0E0F0C;--ok-ink:#F6F6F2;--ok-muted:#A3A49C;--ok-line:#2A2B27;--on:#0E0F0C;--knob-on:#D4F26A}
@media (prefers-color-scheme:dark){:root{--canvas:#0B0C0A;--surface:#161714;--ink:#F2F2EE;--ink-2:#CFCFC8;--muted:#8E8F87;--line:#272824;--fill:#1F201C;--lime:#D4F26A;--lime-ink:#0E0F0C;--good:#55D08D;--wait:#F1B54A;--wait-soft:#2E2412;--ok-bg:#1F201C;--ok-ink:#F2F2EE;--ok-muted:#9C9D95;--ok-line:#2F302B;--on:#D4F26A;--knob-on:#0E0F0C}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--canvas);color:var(--ink);font:15px/1.4 Inter,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-feature-settings:"tnum" 1,"cv11" 1,"ss01" 1;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
button{font:inherit;color:inherit;background:none;border:0;padding:0;text-align:left;cursor:pointer}
small{font-size:.62em;font-weight:inherit;color:var(--muted);vertical-align:.32em;margin-left:.02em}
main{max-width:520px;margin:0 auto;padding:0 16px 48px}
.top{display:flex;align-items:center;justify-content:space-between;padding:14px 0 10px}
.brand{display:flex;align-items:center;gap:9px;font-weight:600;font-size:15px;letter-spacing:-.01em}.brand b{font-weight:600;color:var(--muted)}
.mk-bg{fill:var(--ink)}.mk-ln{fill:var(--canvas);opacity:.55}.mk-hi{fill:var(--lime)}
.live{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);font-weight:500}
.live i{width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 18%,transparent)}
.seg-wrap{position:sticky;top:0;z-index:5;margin:0 -16px;padding:4px 16px 8px;background:var(--canvas)}
.seg{display:flex;gap:2px;padding:3px;border-radius:11px;background:var(--fill);border:1px solid var(--line)}
.seg button{flex:1;text-align:center;font-size:13px;font-weight:500;padding:7px 0;border-radius:8px;color:var(--muted)}
.seg button.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 1px var(--line)}
.tab{display:none;padding-top:6px}.tab.on{display:block}
.hero{padding:22px 2px 16px}.hero.compact{padding-top:18px}
.eyebrow{font-size:12.5px;font-weight:500;color:var(--muted)}
.figure{font-size:52px;line-height:1.02;font-weight:600;letter-spacing:-.045em;margin-top:6px}
.figure.good{color:var(--good)}.figure .unit{font-size:16px;letter-spacing:0;font-weight:500;margin-left:8px;color:var(--good)}
.hero.compact .figure{font-size:40px}
.flow{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--muted)}.flow i{width:3px;height:3px;border-radius:50%;background:currentColor}
.land{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:16px;font-size:13.5px;color:var(--muted)}
.land b{color:var(--ink);font-weight:600}
.tag{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px 0 6px;border-radius:6px;background:var(--lime);color:var(--lime-ink);font-size:11.5px;font-weight:600;letter-spacing:.01em}
.land.wait .tag{background:var(--wait-soft);color:var(--wait)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.chart-panel{padding-top:10px}
.chart{display:block;width:100%;height:auto;padding:0 10px}
.chart .fill-a{stop-color:var(--ink);stop-opacity:.07}.chart .fill-b{stop-color:var(--ink);stop-opacity:0}
.chart .ln{fill:none;stroke:var(--ink);stroke-width:1.8;stroke-linejoin:round}
.chart .zero{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 4;opacity:.8}
.chart .zl{fill:var(--muted);font-size:9.5px;font-weight:500}
.chart .ax{fill:var(--muted);font-size:9.5px;font-weight:500}
.chart .dot{fill:var(--ink)}.chart .dot.est{fill:var(--surface);stroke:var(--ink);stroke-width:1.4}
.chart .end{fill:var(--lime);stroke:var(--ink);stroke-width:1.8}
.next{display:flex;width:100%;align-items:center;gap:10px;padding:13px 14px;border-top:1px solid var(--line);font-size:14px;color:var(--ink)}
.next .k{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.next svg{color:var(--muted)}
.grow{flex:1;min-width:0}.muted{color:var(--muted)}
.empty{display:flex;flex-direction:column;gap:4px;padding:18px 16px;font-size:14px;color:var(--muted)}.empty b{color:var(--ink);font-weight:600}
.ok{margin-top:14px;background:var(--ok-bg);color:var(--ok-ink);border-radius:16px;padding:4px 0}
.ok-head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px 4px;font-size:12px;font-weight:600;letter-spacing:.02em}
.ok-head span:first-child{display:inline-flex;align-items:center;gap:7px}.ok-head span:first-child::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--lime)}
.ok-head .count{color:var(--ok-muted);font-weight:500}
.ok-item{padding:8px 16px 14px}.ok-item+.ok-item{border-top:1px solid var(--ok-line);padding-top:14px}
.ok-item p{margin:0 0 12px;font-size:15px;line-height:1.38;text-wrap:pretty}
.actions{display:flex;gap:8px}
.btn{flex:1;text-align:center;border-radius:10px;padding:10px 12px;font-weight:600;font-size:14px}
.btn.primary{background:var(--lime);color:var(--lime-ink)}.btn.ghost{background:rgba(255,255,255,.09);color:var(--ok-ink)}
.btn.confirm{background:#fff;color:#0E0F0C}.btn[disabled]{opacity:.45}
.sh{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:26px 2px 9px}.sh.first{margin-top:16px}
h2{margin:0;font-size:13px;font-weight:600;letter-spacing:-.005em}
.meta{color:var(--muted);font-size:12px;text-align:right}.meta small{color:inherit}
.stats{display:grid;grid-template-columns:1fr 1fr}
.stat{padding:14px 14px 13px;border-bottom:1px solid var(--line)}.stat:nth-child(odd){border-right:1px solid var(--line)}
.stat .k{font-size:12px;color:var(--muted);font-weight:500}.stat .v{font-size:24px;font-weight:600;letter-spacing:-.03em;margin-top:3px}.stat .s{font-size:11.5px;color:var(--muted);margin-top:1px}
.li{display:flex;align-items:center;gap:12px;padding:12px 14px;font-size:14.5px}.li+.li{border-top:1px solid var(--line)}
.stats+.li{border-top:0}
.li .sub{font-size:12.5px;color:var(--muted);margin-top:1px;display:flex;align-items:center;gap:6px}
.amt{font-weight:600;white-space:nowrap;letter-spacing:-.01em}.amt.good{color:var(--good)}.amt.good small{color:inherit;opacity:.7}
.chev{color:var(--muted);display:inline-flex;margin-right:-4px}
.av{flex:none;width:32px;height:32px;border-radius:50%;background:var(--fill);border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600}
.date{flex:none;width:44px;font-size:12px;color:var(--muted);font-weight:500}
.meter{height:4px;border-radius:2px;background:var(--fill);margin-top:7px;overflow:hidden}.meter>div{height:100%;background:var(--ink)}
[role=button]{cursor:pointer}
.progress{height:6px;border-radius:3px;background:var(--line);margin:0 2px 10px;overflow:hidden}.progress>div{height:100%;background:var(--ink)}
.cert{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:0;border:1.5px solid var(--ink)}.cert.scheduled{background:var(--ink)}
.note{color:var(--muted);font-size:12px;line-height:1.5;margin:12px 2px 0}.note .cert{margin-left:2px}
.toggle{display:flex;align-items:center;gap:12px;padding:12px 14px;border-top:1px solid var(--line);font-size:14px;cursor:pointer}
.toggle input,.toggle-mini input{position:absolute;opacity:0;pointer-events:none}
.switch{flex:none;width:40px;height:24px;border-radius:12px;background:var(--line);position:relative;transition:background .2s}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}
input:checked+.switch{background:var(--on)}input:checked+.switch::after{transform:translateX(16px);background:var(--knob-on)}
input:focus-visible+.switch{outline:2px solid var(--ink);outline-offset:2px}
.toggle-mini{cursor:pointer;display:inline-flex}
.foot{color:var(--muted);font-size:11.5px;text-align:center;margin-top:24px}
.sheet-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:opacity .2s;z-index:9}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:10;max-width:560px;margin:0 auto;background:var(--surface);border-radius:18px 18px 0 0;padding:8px 18px calc(22px + env(safe-area-inset-bottom));transform:translateY(105%);transition:transform .25s ease;max-height:80vh;overflow:auto}
.sheet.on{transform:none}.sheet-bg.on{opacity:1;pointer-events:auto}
.grab{width:36px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 14px}
.sheet h3{margin:0 0 2px;font-size:19px;font-weight:600;letter-spacing:-.015em}.sheet .lead{font-size:13px;color:var(--muted);margin-bottom:12px}
.sheet .kv{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line);font-size:14px}.sheet .kv span:last-child{text-align:right;font-weight:600;word-break:break-all}
.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:11;background:var(--ink);color:var(--canvas);font-size:13.5px;font-weight:500;padding:10px 14px;border-radius:10px;max-width:88vw;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.on{opacity:1}
.plan-svg{display:block;width:100%;height:auto;padding:8px 10px 4px}
.chip{display:inline-block;font-size:11px;font-weight:600;border-radius:6px;padding:1px 7px;background:var(--fill);color:var(--muted);border:1px solid var(--line)}
.chip.pending{background:var(--wait-soft);color:var(--wait);border-color:transparent}.chip.completed{color:var(--good)}.chip.cancelled{text-decoration:line-through}
details.how{margin:12px 2px 0}details.how summary{cursor:pointer;color:var(--muted);font-size:12px;font-weight:500}
</style></head>
<body>
<main>
<header class="top"><div class="brand">${MARK}<span>Elves <b>Ledger</b></span></div><div class="live"><i></i>Live from Nessie</div></header>
<div class="seg-wrap"><nav class="seg" aria-label="Sections">
<button class="on" data-tab="overview">Overview</button>
<button data-tab="back">Coming back</button>
<button data-tab="activity">Activity</button>
<button data-tab="plan">Plan</button>
</nav></div>
<section class="tab on" id="tab-overview">
<div class="fold">${hero}</div>
${planLink(v)}
${approvals}
${stats}
${owes}
${heldOut}
</section>
<section class="tab" id="tab-back">${comingBack}</section>
<section class="tab" id="tab-activity">${activity}</section>
<section class="tab" id="tab-plan">${planTab(v)}</section>
<div class="foot">Read live from ${plural(v.records, "Nessie record")} · refreshes every 30 seconds</div>
</main>
<div class="sheet-bg" id="sheet-bg"></div>
<div class="sheet" id="sheet" role="dialog" aria-modal="true"><div class="grab"></div><div id="sheet-body"></div></div>
<div class="toast" id="toast" role="status"></div>
<script type="application/json" id="data">${scriptJson(data)}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById("data").textContent);
var stepChartSvg=${String(stepChartSvg)};
var $=function(s){return document.querySelector(s)};
function usd(c){var a=Math.abs(c);return "$"+(a/100).toFixed(a%100===0?0:2)}
function net(c){return c<0?usd(c)+" ahead":usd(c)}
function fmt(d){return new Date(d+"T00:00:00Z").toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
var busy=false;
// Tabs
function show(t){document.querySelectorAll(".tab").forEach(function(el){el.classList.toggle("on",el.id==="tab-"+t)});document.querySelectorAll(".seg button").forEach(function(b){b.classList.toggle("on",b.dataset.tab===t)});try{history.replaceState(null,"","#"+t)}catch(e){}window.scrollTo(0,0)}
document.querySelectorAll("[data-tab]").forEach(function(b){b.addEventListener("click",function(){show(b.dataset.tab)})});
document.querySelectorAll("[data-go]").forEach(function(b){b.addEventListener("click",function(){show(b.dataset.go)})});
var h=(location.hash||"").slice(1);if(h==="back"||h==="activity"||h==="plan")show(h);
// Sheets
function kv(k,v){return '<div class="kv"><span class="muted">'+esc(k)+'</span><span>'+esc(v)+'</span></div>'}
function openSheet(html){$("#sheet-body").innerHTML=html;$("#sheet").classList.add("on");$("#sheet-bg").classList.add("on");busy=true}
function closeSheet(){$("#sheet").classList.remove("on");$("#sheet-bg").classList.remove("on");busy=false}
$("#sheet-bg").addEventListener("click",closeSheet);
document.addEventListener("keydown",function(e){if(e.key==="Escape")closeSheet()});
var WHERE={you:"Your account",fund:"Moving Fund",escrow:"Escrow"};
var KIND={expense:"Shared cost you paid",deposit_out:"Deposit you paid",deposit_back:"Deposit returned",share_paid:"Share paid into the Moving Fund",share_paid_outside:"Share paid outside Elves",loan_payment:"Payment-plan payment",escrow_in:"Buyer paid into escrow",escrow_release:"Released from escrow",escrow_refund:"Refunded to the buyer",payment:"Payment you sent"};
function sheetFor(key){var p=key.split(":"),i=+p[1],x;
if(p[0]==="activity"){x=D.recent[i];if(!x)return;openSheet('<h3>'+esc(x.label)+'</h3><div class="lead">'+esc(KIND[x.tag]||x.tag)+'</div>'+kv("Amount",(x.direction==="in"?"+":"−")+usd(x.amountCents))+kv("Account",WHERE[x.account]||x.account)+kv("Date",fmt(x.date))+kv("Nessie "+x.kind,x.recordId))}
if(p[0]==="expected"){x=D.expected[i];if(!x)return;openSheet('<h3>'+esc(x.label)+'</h3><div class="lead">'+(x.certainty==="scheduled"?"A date someone agreed to.":"No date was agreed, so this is an estimate.")+'</div>'+kv("Amount","+"+usd(x.cents))+kv("Expected",fmt(x.date))+kv("Certainty",x.certainty))}
if(p[0]==="owe"){x=D.owes[i];if(!x)return;var b=(x.bills||[]).map(function(y){return kv(y.nickname,usd(y.amountCents))}).join("");var l=x.loan?kv("Payment plan",usd(x.loan.paidCents)+" of "+usd(x.loan.totalCents)+" paid")+kv("Monthly",usd(x.loan.monthlyCents)):"";openSheet('<h3>'+esc(x.name)+'</h3><div class="lead">Owes you '+usd(x.owedCents)+'</div>'+b+l)}}
document.querySelectorAll("[data-sheet]").forEach(function(el){el.addEventListener("click",function(e){e.preventDefault();sheetFor(el.dataset.sheet)});el.addEventListener("keydown",function(e){if(e.key==="Enter")sheetFor(el.dataset.sheet)})});
// What-if: recompute the projection in the browser; nothing is saved.
var touched=false;
function addDays(d,n){var t=new Date(d+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10)}
function whatIf(){var late=$("#wi-late")&&$("#wi-late").checked;var xs=[];document.querySelectorAll("[data-count]").forEach(function(c){if(c.checked){var x=D.expected[+c.dataset.count];xs.push({date:late?addDays(x.date,14):x.date,cents:x.cents,certainty:x.certainty})}});
xs.sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0});var pts=[{date:D.today,netCents:D.netNowCents}],run=D.netNowCents,tot=0;
xs.forEach(function(x){run-=x.cents;tot+=x.cents;var l=pts[pts.length-1];if(l.date===x.date)l.netCents=run;else pts.push({date:x.date,netCents:run})});
var est=xs.filter(function(x){return x.certainty==="estimated"}).map(function(x){return x.date});
$("#wi-net").textContent=net(run);$("#wi-sub").textContent=xs.length?"once "+usd(tot)+" is back · "+fmt(xs[xs.length-1].date):"if nothing else comes back";
$("#wi-chart").innerHTML=stepChartSvg({points:pts,estimated:est,width:340,height:120})||'<div class="empty">Nothing counted; your net cost stays '+net(D.netNowCents)+'.</div>'}
document.querySelectorAll("#wi-late,[data-count]").forEach(function(c){c.addEventListener("change",function(){touched=true;whatIf()})});
// Approve / Not now: Approve asks for a second tap, then posts the decision.
function toast(m){var t=$("#toast");t.textContent=m;t.classList.add("on");setTimeout(function(){t.classList.remove("on")},3200)}
document.querySelectorAll("[data-decide]").forEach(function(btn){btn.addEventListener("click",function(){
var card=btn.closest("[data-pending]"),choice=btn.dataset.decide;if(!D.decideUrl){toast("Reply yes in Messages to approve.");return}
if(choice==="approve"&&!btn.classList.contains("confirm")){btn.classList.add("confirm");btn.textContent="Tap to confirm";busy=true;setTimeout(function(){if(btn.isConnected&&!btn.disabled){btn.classList.remove("confirm");btn.textContent=btn.dataset.verb;busy=false}},4000);return}
card.querySelectorAll("button").forEach(function(b){b.disabled=true});
fetch(D.decideUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pendingId:card.dataset.pending,choice:choice})}).then(function(r){return r.json()}).then(function(r){toast(r.message||(r.ok?"Done.":"That didn't work."));setTimeout(function(){location.reload()},1400)}).catch(function(){toast("Couldn't reach Elves. Try again.");card.querySelectorAll("button").forEach(function(b){b.disabled=false})})})});
// Pick up new Nessie records every 30 seconds, unless the owner is in the middle of something.
setInterval(function(){if(!busy&&!touched&&document.visibilityState==="visible")location.reload()},30000);
})();
</script>
</body></html>`;
}

// ---------- Move Plans (decision #66) ----------

const PLAN_COLORS: PlanColors = {
  series: ["var(--ink)", "var(--ink-2)", "var(--muted)"],
  grid: "var(--line)",
  text: "var(--ink)",
  muted: "var(--muted)",
  bg: "var(--surface)",
  shade: "var(--fill)",
};
const PLAN_FONT = { size: 11, family: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" };

/** One row on Overview that opens the Plan tab. */
function planLink(v: LedgerView): string {
  const ps = v.plans;
  if (!ps || (!ps.chosen && !ps.drafts.length)) return "";
  const text = ps.chosen
    ? `Plan ${ps.chosen.label} · ${netPhrase(ps.chosen.stats.p50Cents)} likely · ${pctOf(ps.chosen.stats.chanceUnderBudget)} under ${fmtUsd(ps.budgetCents)}`
    : `${ps.drafts.length} plans under ${fmtUsd(ps.budgetCents)} · pick one`;
  return `<div class="panel" style="margin-top:14px"><button class="next" data-go="plan" style="border-top:0"><span class="k">Plan</span><span class="grow">${esc(text)}</span>${ICON.chevronRight}</button></div>`;
}

/** The written-out assumptions behind every plan percentage. */
function assumptionsHtml(): string {
  const a = ASSUMPTIONS;
  const rates = Object.entries(a.saleRatePerDay)
    .map(([k, r]) => `${k} ${pctOf(r)}/day`)
    .join(", ");
  return `<details class="how"><summary>How the odds are estimated</summary><p class="note">Each plan is run 2,000 times. An item at its list price sells on a given day with these chances: ${esc(rates)}; a lower price raises that by (list ÷ price)<sup>${a.priceElasticity}</sup>. Last Call drops the price to ${pctOf(a.lastCallDrop)} of list two days before move-out and relists it free the day before; anything left is hauled away for ${fmtUsd(a.dumpCents)}. Trucks: ${esc(a.trucks.map((t) => `${t.size} ${fmtUsd(t.cents)} (up to ${t.capacityLb} lb)`).join(", "))}, sized for ${a.baseLoadLb} lb of boxes plus what you haul. Movers: ${fmtUsd(a.moversCents)}. Estimates, not quotes.</p></details>`;
}

function planTab(v: LedgerView): string {
  const ps = v.plans;
  const empty = `<div class="panel empty" style="margin-top:16px"><b>No plan yet.</b><span>Text Elves “plan my move under $300” (your budget) and you get three plans, each with the chance it finishes under budget.</span></div>`;
  if (!ps) return empty;
  const p = ps.chosen;
  if (p) {
    const path = planPath(
      p,
      ps.budgetCents,
      ps.history,
      ps.moveOutDate,
      { x: 4, y: 0, w: 332, h: 150 },
      PLAN_COLORS,
      PLAN_FONT,
    );
    const records = ps.records
      .map(
        (r) =>
          `<div class="li static"><span class="date">${esc(fmtDate(r.date))}</span><div class="grow"><div>${esc(capFirst(r.label.replace(/^Plan [ABC]: /, "")))}</div><div class="sub"><span class="chip ${esc(r.status)}">${esc(r.status)}</span>${r.tag === "plan_in" ? "Moving Fund" : "Your account"}</div></div><div class="amt${r.tag === "plan_in" ? " good" : ""}">${money(r.cents, r.tag === "plan_in" ? "+" : "−")}</div></div>`,
      )
      .join("");
    return `<section class="hero compact">
<div class="eyebrow">Plan ${p.label} · ${esc(p.name)}</div>
<div class="figure">${esc(netPhrase(p.stats.p50Cents))}</div>
<div class="flow"><span>likely final cost</span><i></i><span>${esc(netPhrase(p.stats.p10Cents))}–${esc(netPhrase(p.stats.p90Cents))}</span></div>
<div class="land"><span class="tag">${ICON.arrowDown}Projected</span><b>${pctOf(p.stats.chanceUnderBudget)}</b><span>chance under ${fmtUsd(ps.budgetCents)}, move-out ${esc(fmtDate(ps.moveOutDate))}</span></div>
</section>
${path ? `<div class="panel chart-panel"><svg class="plan-svg" viewBox="0 0 340 162" role="img" aria-label="${esc(`Plan ${p.label}: likely ${netPhrase(p.stats.p50Cents)} by move-out`)}">${path}</svg></div>` : ""}
<p class="note">Shaded: 10–90% of simulated moves. Dots: your real net cost, day by day. ${p.truck.size} truck${p.movers ? " and movers" : ""}.</p>
${records ? `<div class="sh"><h2>In Nessie</h2><span class="meta">${plural(ps.records.length, "record")}</span></div><div class="panel">${records}</div>` : ""}
${assumptionsHtml()}`;
  }
  if (!ps.drafts.length) return empty;
  const race = planRace(ps.drafts, ps.budgetCents, { x: 4, y: 0, w: 332, h: 190 }, PLAN_COLORS, PLAN_FONT);
  const grid = planGrid(ps.drafts, { x: 4, y: 0, w: 332 }, PLAN_COLORS, PLAN_FONT);
  return `<section class="hero compact">
<div class="eyebrow">Move plans under ${fmtUsd(ps.budgetCents)}</div>
<div class="figure">${ps.drafts.length} plans</div>
<div class="flow"><span>Reply A, B or C in Messages</span></div>
</section>
<div class="panel chart-panel"><svg class="plan-svg" viewBox="0 0 340 190" role="img" aria-label="${esc(ps.drafts.map((d) => `Plan ${d.label}: ${netPhrase(d.stats.p50Cents)}, ${pctOf(d.stats.chanceUnderBudget)} under budget`).join("; "))}">${race}</svg></div>
<div class="sh"><h2>What each plan does</h2></div>
<div class="panel"><svg class="plan-svg" viewBox="0 0 340 ${Math.ceil(grid.h + 8)}" role="img" aria-label="What each plan does with each item">${grid.svg}</svg></div>
${assumptionsHtml()}`;
}
