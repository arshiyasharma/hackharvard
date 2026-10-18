/**
 * The move's money projection: what the move costs the owner today, what is still expected back and when,
 * and the net cost once it has all come in. Built from the live Nessie books plus the dates the Ledger knows
 * (deposit due-back dates, loan schedules, pickup times). Every expected amount says how sure it is, so the
 * dashboard never presents a guess as a fact.
 */
import type { Books } from "./books.ts";
import type { LedgerEntry } from "./ledger.ts";

export type Certainty =
  /** A date someone agreed to: a deposit's due-back date, a loan's monthly schedule, a pickup time. */
  | "scheduled"
  /** No date agreed; we assume a typical one (see ASSUMED_DAYS) and label it as an estimate. */
  | "estimated";

export interface ExpectedInflow {
  /** YYYY-MM-DD the money is expected. */
  date: string;
  label: string;
  cents: number;
  kind: "deposit" | "share" | "loan" | "sale";
  certainty: Certainty;
}

export interface ProjectionPoint {
  date: string;
  /** The owner's net cost of the move on that date (positive = money out of pocket). */
  netCents: number;
}

export interface Projection {
  /** Paid out so far: shared costs, purchases and payments, plus deposits not yet back. */
  outCents: number;
  /** Already back: roommate shares, loan payments and sales. */
  backCents: number;
  /** outCents - backCents: what the move has cost the owner as of today. */
  netNowCents: number;
  expected: ExpectedInflow[];
  expectedCents: number;
  /** netNowCents - expectedCents: the net cost once everything expected has come in. */
  projectedNetCents: number;
  /** The date the last expected money arrives, or null if nothing is expected. */
  settledBy: string | null;
  /** True if any expected amount is an estimate rather than a scheduled date. */
  hasEstimates: boolean;
  points: ProjectionPoint[];
}

/** When no date was agreed: a requested roommate share usually lands within a week, a sale within a few days. */
export const ASSUMED_DAYS = { share: 7, sale: 3, deposit: 30 } as const;
const MONTH_DAYS = 30;

/** How to say a net cost: "$80" when it costs the owner money, "$10 ahead" when the move pays for itself. */
export function netPhrase(cents: number): string {
  const abs = Math.abs(cents);
  const usd = `$${(abs / 100).toFixed(abs % 100 === 0 ? 0 : 2)}`;
  return cents < 0 ? `${usd} ahead` : usd;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function projectMove(input: {
  books: Books;
  entries: LedgerEntry[];
  /** Person id → name, for labels. */
  names: Map<string, string>;
  now: Date;
}): Projection {
  const { books, entries, names } = input;
  const today = input.now.toISOString().slice(0, 10);
  const expected: ExpectedInflow[] = [];

  // Deposits still out, on their due-back dates.
  for (const e of entries) {
    if (e.kind !== "deposit" || e.status !== "pending" || e.flagged) continue;
    const date = e.dueBackAt && e.dueBackAt >= today ? e.dueBackAt : null;
    expected.push({
      date: date ?? addDays(today, ASSUMED_DAYS.deposit),
      label: `${e.what} deposit back`,
      cents: e.amountCents,
      kind: "deposit",
      certainty: date ? "scheduled" : "estimated",
    });
  }

  // Roommates: open payment requests (bills) are expected soon; loans follow their monthly schedule.
  for (const o of books.owes) {
    if (o.billCents > 0)
      expected.push({
        date: addDays(today, ASSUMED_DAYS.share),
        label: `${o.name}'s share`,
        cents: o.billCents,
        kind: "share",
        certainty: "estimated",
      });
    if (o.loanCents > 0) {
      const monthly = o.loanMonthlyCents && o.loanMonthlyCents > 0 ? o.loanMonthlyCents : o.loanCents;
      let left = o.loanCents;
      for (let i = 1; left > 0 && i <= 24; i++) {
        const cents = Math.min(monthly, left);
        expected.push({
          date: addDays(today, i * MONTH_DAYS),
          label: `${o.name}'s loan payment`,
          cents,
          kind: "loan",
          certainty: "scheduled",
        });
        left -= cents;
      }
    }
  }

  // Sales held in escrow: released at pickup.
  for (const e of entries) {
    if (e.kind !== "sale" || e.escrow !== "held" || e.flagged) continue;
    const pickup = e.pickupAt ? e.pickupAt.slice(0, 10) : null;
    const date = pickup && pickup >= today ? pickup : null;
    const buyer = names.get(e.paidBy ?? "");
    expected.push({
      date: date ?? addDays(today, ASSUMED_DAYS.sale),
      label: `${e.what} sale${buyer ? ` (${buyer})` : ""}`,
      cents: e.amountCents,
      kind: "sale",
      certainty: date ? "scheduled" : "estimated",
    });
  }

  expected.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  const outCents = books.spentCents + books.depositsOutCents;
  const backCents = books.collectedCents + books.salesCents;
  const netNowCents = outCents - backCents;
  const expectedCents = expected.reduce((a, x) => a + x.cents, 0);

  // A running net cost: today, then one point per day money is expected.
  const points: ProjectionPoint[] = [{ date: today, netCents: netNowCents }];
  let running = netNowCents;
  for (const x of expected) {
    running -= x.cents;
    const last = points[points.length - 1];
    if (last && last.date === x.date) last.netCents = running;
    else points.push({ date: x.date, netCents: running });
  }

  return {
    outCents,
    backCents,
    netNowCents,
    expected,
    expectedCents,
    projectedNetCents: netNowCents - expectedCents,
    settledBy: expected.at(-1)?.date ?? null,
    hasEstimates: expected.some((x) => x.certainty === "estimated"),
    points,
  };
}
