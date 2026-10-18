/**
 * The live Ledger page: the link the Money Elf sends under the Ledger card. Phone-sized, refreshes itself,
 * and carries Open Graph tags so iMessage unfurls it into a preview using the same card image.
 * Served by ledger-http.ts behind a signed link.
 */
import { fmtDate, fmtUsd } from "./amounts.ts";
import { capFirst, esc } from "./ledger-card.ts";
import { type LedgerView, ledgerSummaryLine } from "./ledger-view.ts";
import { type PlanColors, planGrid, planPath, planRace } from "./plan-chart.ts";
import { ASSUMPTIONS, pct } from "./plans.ts";
import { ASSUMED_DAYS, netPhrase } from "./projection.ts";
import { projectionChart } from "./projection-chart.ts";

export function ledgerPageHtml(v: LedgerView, opts: { imageUrl: string; pageUrl: string }): string {
  const tile = (label: string, cents: number, cls: string) =>
    `<div class="tile ${cls}"><div class="tl">${label}</div><div class="tv">${fmtUsd(cents)}</div></div>`;
  const row = (left: string, right: string, sub: string, cls = "") =>
    `<div class="row"><div><div class="rl">${esc(capFirst(left))}</div>${sub ? `<div class="rs">${esc(sub)}</div>` : ""}</div><div class="rv ${cls}">${esc(right)}</div></div>`;
  const section = (title: string, rows: string[]) =>
    rows.length ? `<section><h2>${title}</h2>${rows.join("")}</section>` : "";

  const owes = v.owes.map((o) => {
    if (!o.loan) return row(o.name, fmtUsd(o.owedCents), "Payment request sent", "owed");
    const pct = o.loan.totalCents ? Math.round((100 * o.loan.paidCents) / o.loan.totalCents) : 0;
    return `${row(o.name, fmtUsd(o.owedCents), `Loan: ${fmtUsd(o.loan.paidCents)} of ${fmtUsd(o.loan.totalCents)} paid · ${fmtUsd(o.loan.monthlyCents)}/month`, "owed")}<div class="bar"><div style="width:${pct}%"></div></div>`;
  });
  const recent = v.recent.map((a) =>
    row(
      a.label,
      `${a.direction === "in" ? "+" : "-"}${fmtUsd(a.amountCents)}`,
      `${a.account === "fund" ? "Moving Fund" : a.account === "escrow" ? "Escrow" : "You"} · ${fmtDate(a.date)}`,
      a.direction === "in" ? "in" : "",
    ),
  );
  const summary = ledgerSummaryLine(v);
  const p = v.projection;
  const chart = projectionChart(
    p,
    { x: 6, y: 0, w: 508, h: 230 },
    {
      line: "var(--fund)",
      grid: "var(--muted)",
      text: "var(--ink)",
      muted: "var(--muted)",
      bg: "var(--card)",
    },
    { size: 19, family: "-apple-system, BlinkMacSystemFont, Inter, sans-serif" },
  );
  const projection =
    p.outCents || p.expectedCents
      ? `<section class="proj"><h2>Move cost projection</h2>
<div class="kpis"><div><div class="kl">Net cost so far</div><div class="kv">${netPhrase(p.netNowCents)}</div><div class="ks">${fmtUsd(p.outCents)} out · ${fmtUsd(p.backCents)} back</div></div>
<div><div class="kl">${p.projectedNetCents < 0 ? "Projected: you come out" : "Projected net cost"}</div><div class="kv fundc">${netPhrase(p.projectedNetCents)}</div><div class="ks">${p.settledBy ? `once ${fmtUsd(p.expectedCents)} comes back by ${esc(fmtDate(p.settledBy))}` : "nothing else expected back"}</div></div></div>
${chart ? `<svg class="chart" viewBox="0 0 520 230" role="img" aria-label="${esc(`Net cost of the move from ${netPhrase(p.netNowCents)} today to ${netPhrase(p.projectedNetCents)} projected`)}">${chart}</svg>` : ""}
${p.expected
  .map((x) =>
    row(
      x.label,
      `+${fmtUsd(x.cents)}`,
      `${fmtDate(x.date)} · ${x.certainty === "scheduled" ? "scheduled" : "estimated"}`,
      "in",
    ),
  )
  .join("")}
${p.hasEstimates ? `<div class="rs note">Estimated dates assume a requested share is paid within ${ASSUMED_DAYS.share} days, a sale clears within ${ASSUMED_DAYS.sale} days of now, and a deposit with no due-back date returns within ${ASSUMED_DAYS.deposit} days. Solid dots are scheduled; hollow dots are estimates.</div>` : ""}
</section>`
      : "";

  const planSection = plansHtml(v, row);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Moving Ledger</title>
<meta name="robots" content="noindex">
<meta property="og:title" content="${esc(`${v.ownerName} Moving Ledger`)}">
<meta property="og:description" content="${esc(summary)}">
<meta property="og:image" content="${esc(opts.imageUrl)}">
<meta property="og:url" content="${esc(opts.pageUrl)}">
<style>
:root{--bg:#F5F2EB;--card:#fff;--ink:#1D1B18;--muted:#6F6A61;--line:#E7E2D8;--fund:#1F7A4D;--fundbg:#E5F3EA;--owed:#A05A00;--owedbg:#FBEEDC;--esc:#2457A6;--escbg:#E4ECF8;--wait:#FFF6D6;--waitline:#E9C95A}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--card:#1E1C19;--ink:#F2EEE6;--muted:#A39D92;--line:#33302B;--fund:#5FCB92;--fundbg:#1B3326;--owed:#F0A64A;--owedbg:#3A2A14;--esc:#7FA8EE;--escbg:#1A2740;--wait:#3A3216;--waitline:#8A7426}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:16px}.card{background:var(--card);border-radius:22px;padding:22px 18px}
h1{font-size:28px;margin:0}.sub{color:var(--muted);font-size:14px;margin:4px 0 18px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.tile{border-radius:14px;padding:12px}.tl{font-size:12px;font-weight:600}.tv{font-size:22px;font-weight:700;margin-top:4px}
.fund{background:var(--fundbg);color:var(--fund)}.owedt{background:var(--owedbg);color:var(--owed)}.esct{background:var(--escbg);color:var(--esc)}
.wait{background:var(--wait);border:1px solid var(--waitline);border-radius:12px;padding:12px;margin-top:16px;font-weight:600;font-size:14px}
section{border-top:1px solid var(--line);margin-top:18px;padding-top:12px}h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 4px}
.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0}.rl{font-weight:600}.rs{color:var(--muted);font-size:13px}.rv{font-weight:700;white-space:nowrap}
.rv.owed{color:var(--owed)}.rv.in{color:var(--fund)}.rv.esc{color:var(--esc)}
.bar{height:8px;border-radius:4px;background:var(--line);margin:0 0 8px}.bar>div{height:100%;border-radius:4px;background:var(--fund)}
.foot{color:var(--muted);font-size:12px;margin-top:18px}
.kpis{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:6px 0 4px}.kl{font-size:12px;color:var(--muted);font-weight:600}.kv{font-size:24px;font-weight:700}.ks{font-size:12px;color:var(--muted)}.fundc{color:var(--fund)}
.chart{width:100%;height:auto;display:block;margin:10px 0 4px}.note{margin-top:8px}
.chip{display:inline-block;font-size:11px;font-weight:600;border-radius:8px;padding:1px 7px;margin-right:6px;background:var(--line);color:var(--muted)}
.chip.completed{background:var(--fundbg);color:var(--fund)}.chip.pending{background:var(--escbg);color:var(--esc)}.chip.cancelled{text-decoration:line-through}
details{margin-top:10px}summary{cursor:pointer;color:var(--muted);font-size:13px}
</style></head>
<body><main><div class="card">
<h1>Moving Ledger</h1>
<div class="sub">${esc(v.ownerName)} move · updated ${esc(fmtDate(v.asOf.slice(0, 10)))} · live from Nessie</div>
<div class="tiles">${tile("Moving Fund", v.fundCents, "fund")}${tile("Owed to you", v.owedCents, "owedt")}${tile("In escrow", v.escrowCents, "esct")}</div>
${v.pending[0] ? `<div class="wait">Waiting on your OK: ${esc(v.pending[0])}. Reply yes in Messages, or tap the poll.</div>` : ""}
${planSection}
${projection}
${section("Who owes you", owes)}
${section(
  "Held in escrow",
  v.escrow.map((e) =>
    row(e.item, fmtUsd(e.cents), `Paid by ${e.buyer}; released when pickup's confirmed`, "esc"),
  ),
)}
${section(
  "Deposits out",
  v.deposits.map((d) =>
    row(d.what, fmtUsd(d.cents), d.dueBackAt ? `Due back ${fmtDate(d.dueBackAt)}` : "Due-back date not set"),
  ),
)}
${section("Recent", recent)}
${!v.owes.length && !v.escrow.length && !v.deposits.length && !v.recent.length ? `<section><div class="rs">Nothing on the Ledger yet. Text the Money Elf a shared cost or a deposit.</div></section>` : ""}
<div class="foot">Read live from ${v.records} Nessie records. Refreshes every 30 seconds.</div>
</div></main></body></html>`;
}

const PAGE_COLORS: PlanColors = {
  series: ["var(--fund)", "var(--esc)", "var(--owed)"],
  grid: "var(--line)",
  text: "var(--ink)",
  muted: "var(--muted)",
  bg: "var(--card)",
  shade: "var(--fundbg)",
};
const PAGE_FONT = { size: 17, family: "-apple-system, BlinkMacSystemFont, Inter, sans-serif" };

/** The written-out assumptions behind every plan percentage (decision #53). */
function assumptionsHtml(): string {
  const a = ASSUMPTIONS;
  const rates = Object.entries(a.saleRatePerDay)
    .map(([k, r]) => `${k} ${pct(r)}/day`)
    .join(", ");
  return `<details><summary>How the odds are estimated</summary><div class="rs note">Each plan is run ${2000} times. An item at its list price sells on a given day with these chances: ${esc(rates)}; a lower price raises that by (list ÷ price)^${a.priceElasticity}. Last Call drops the price to ${pct(a.lastCallDrop)} of list two days before move-out and relists it free the day before; anything left is hauled away for ${fmtUsd(a.dumpCents)}. Trucks: ${esc(a.trucks.map((t) => `${t.size} ${fmtUsd(t.cents)} (up to ${t.capacityLb} lb)`).join(", "))}, sized for ${a.baseLoadLb} lb of boxes plus what you haul. Movers: ${fmtUsd(a.moversCents)}. These are estimates, not quotes.</div></details>`;
}

/** The Move Plans section: the chosen plan with its path and its Nessie records, or the drafts to pick from. */
function plansHtml(
  v: LedgerView,
  row: (left: string, right: string, sub: string, cls?: string) => string,
): string {
  const ps = v.plans;
  if (!ps) return "";
  const p = ps.chosen;
  if (p) {
    const path = planPath(
      p,
      ps.budgetCents,
      ps.history,
      ps.moveOutDate,
      { x: 6, y: 0, w: 508, h: 240 },
      PAGE_COLORS,
      PAGE_FONT,
    );
    const records = ps.records.map((r) =>
      row(
        r.label.replace(/^Plan [ABC]: /, ""),
        `${r.tag === "plan_in" ? "+" : "-"}${fmtUsd(r.cents)}`,
        "",
        r.tag === "plan_in" ? "in" : "",
      ).replace(
        '<div class="rl">',
        `<div class="rs"><span class="chip ${esc(r.status)}">${esc(r.status)}</span>${esc(fmtDate(r.date))}</div><div class="rl">`,
      ),
    );
    return `<section class="proj"><h2>Move plan</h2>
<div class="kpis"><div><div class="kl">Plan ${p.label} · ${esc(p.name)}</div><div class="kv">${netPhrase(p.stats.p50Cents)}</div><div class="ks">likely final cost · range ${netPhrase(p.stats.p10Cents)}–${netPhrase(p.stats.p90Cents)}</div></div>
<div><div class="kl">Chance under ${fmtUsd(ps.budgetCents)}</div><div class="kv fundc">${pct(p.stats.chanceUnderBudget)}</div><div class="ks">move-out ${esc(fmtDate(ps.moveOutDate))} · ${p.truck.size} truck${p.movers ? " + movers" : ""}</div></div></div>
${path ? `<svg class="chart" viewBox="0 0 520 240" role="img" aria-label="${esc(`Plan ${p.label}: likely ${netPhrase(p.stats.p50Cents)} by move-out`)}">${path}</svg>` : ""}
<div class="rs">Shaded: 10–90% of simulated moves. Dots: your real net cost, day by day.</div>
${records.length ? `<h2 style="margin-top:14px">In Nessie</h2>${records.join("")}` : ""}
${assumptionsHtml()}
</section>`;
  }
  if (!ps.drafts.length) return "";
  const race = planRace(ps.drafts, ps.budgetCents, { x: 6, y: 0, w: 508, h: 300 }, PAGE_COLORS, PAGE_FONT);
  const grid = planGrid(ps.drafts, { x: 6, y: 0, w: 508 }, PAGE_COLORS, PAGE_FONT);
  return `<section class="proj"><h2>Move plans under ${fmtUsd(ps.budgetCents)}</h2>
<svg class="chart" viewBox="0 0 520 300" role="img" aria-label="${esc(ps.drafts.map((d) => `Plan ${d.label}: ${netPhrase(d.stats.p50Cents)}, ${pct(d.stats.chanceUnderBudget)} under budget`).join("; "))}">${race}</svg>
<svg class="chart" viewBox="0 0 520 ${Math.ceil(grid.h + 8)}" role="img" aria-label="What each plan does with each item">${grid.svg}</svg>
<div class="rs">Reply A, B or C in Messages, or tap the poll.</div>
${assumptionsHtml()}
</section>`;
}
