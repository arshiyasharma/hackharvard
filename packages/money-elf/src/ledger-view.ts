/**
 * The Ledger as a picture: one view model, built live from Nessie, that both the image card
 * (ledger-card.ts) and the web page (ledger-page.ts) draw. Owner-only: it names who owes what.
 */
import { fmtUsd } from "./amounts.ts";
import type { Activity, PlannedRecord } from "./books.ts";
import type { Plan } from "./plans.ts";
import { type Projection, projectMove } from "./projection.ts";
import type { MoneyService } from "./service.ts";
import type { MoneyMove } from "./types.ts";

export interface OweRow {
  name: string;
  /** Still owed, from Nessie (open bills plus open loan balance). */
  owedCents: number;
  /** Loans only: the original amount, the monthly payment, and how much has been paid. */
  loan: { totalCents: number; monthlyCents: number; paidCents: number } | null;
}

export interface LedgerView {
  moveId: string;
  ownerName: string;
  /** ISO time the view was read from Nessie. */
  asOf: string;
  fundCents: number;
  owedCents: number;
  escrowCents: number;
  spentCents: number;
  salesCents: number;
  depositsOutCents: number;
  owes: OweRow[];
  escrow: { item: string; buyer: string; cents: number }[];
  deposits: { what: string; cents: number; dueBackAt: string | null }[];
  recent: Activity[];
  pending: string[];
  records: number;
  /** What the move costs, what's still coming back and when (projection.ts). */
  projection: Projection;
  /** Move Plans: the latest drafts and the chosen plan, with its records read live from Nessie. */
  plans: {
    budgetCents: number;
    moveOutDate: string;
    drafts: Plan[];
    chosen: Plan | null;
    history: { date: string; netCents: number }[];
    records: PlannedRecord[];
  } | null;
}

export async function buildLedgerView(service: MoneyService, move: MoneyMove): Promise<LedgerView> {
  const [books, entries, pending, owner, planState] = await Promise.all([
    service.books(move),
    service.store.listEntries(move.id),
    service.store.listPending(move.id),
    service.owner(move),
    service.store.getPlans(move.id),
  ]);
  const owes: OweRow[] = books.owes.map((o) => {
    const loanEntry = entries.find((e) => e.owedBy === o.personId && e.loanId && e.status === "pending");
    return {
      name: o.name,
      owedCents: o.billCents + o.loanCents,
      loan:
        loanEntry && o.loanCents
          ? {
              totalCents: loanEntry.amountCents,
              monthlyCents: o.loanMonthlyCents ?? loanEntry.loanMonthlyCents ?? 0,
              paidCents: loanEntry.amountCents - o.loanCents,
            }
          : null,
    };
  });
  const people = new Map((await service.store.listPeople(move.id)).map((p) => [p.id, p.name]));
  return {
    moveId: move.id,
    ownerName: owner.name === "Owner" ? "Your" : `${owner.name}'s`,
    asOf: new Date().toISOString(),
    fundCents: books.fundCents,
    owedCents: owes.reduce((a, o) => a + o.owedCents, 0),
    escrowCents: books.escrowCents,
    spentCents: books.spentCents,
    salesCents: books.salesCents,
    depositsOutCents: books.depositsOutCents,
    owes: owes.sort((a, b) => b.owedCents - a.owedCents),
    escrow: entries
      .filter((e) => e.kind === "sale" && e.escrow === "held")
      .map((e) => ({ item: e.what, buyer: people.get(e.paidBy ?? "") ?? "buyer", cents: e.amountCents })),
    deposits: entries
      .filter((e) => e.kind === "deposit" && e.status === "pending")
      .map((e) => ({ what: e.what, cents: e.amountCents, dueBackAt: e.dueBackAt })),
    recent: books.recent.slice(0, 6),
    pending: pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => p.summary),
    records: books.records,
    projection: projectMove({ books, entries, names: people, now: service.clock() }),
    plans: planState
      ? {
          budgetCents: planState.budgetCents,
          moveOutDate: planState.moveOutDate,
          drafts: planState.drafts,
          chosen: planState.chosen,
          history: planState.history,
          records: planState.chosenPrefix
            ? books.planned.filter((r) => r.lineId.startsWith(`${planState.chosenPrefix}_`))
            : [],
        }
      : null,
  };
}

/** One sentence summing the view, for link previews and the reply text. */
export function ledgerSummaryLine(v: LedgerView): string {
  const parts: string[] = [];
  if (v.fundCents) parts.push(`${fmtUsd(v.fundCents)} in the Moving Fund`);
  if (v.owedCents) parts.push(`${fmtUsd(v.owedCents)} owed to you`);
  if (v.escrowCents) parts.push(`${fmtUsd(v.escrowCents)} in escrow`);
  if (v.depositsOutCents) parts.push(`${fmtUsd(v.depositsOutCents)} in deposits out`);
  return parts.length ? `${cap(parts.join(", "))}.` : "Nothing on the Ledger yet.";
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
