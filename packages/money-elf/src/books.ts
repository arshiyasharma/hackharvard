/**
 * The live Ledger: rebuilt on every turn by reading the move's accounts back from Nessie.
 *
 * Nessie never updates balances (decision #9), so each record carries a tag in its description,
 * `[elves:<kind>:<entryId>]`, saying what it was. The totals here come only from those records, so what the
 * owner sees is exactly what is in the bank.
 */
import { fmtUsd } from "./amounts.ts";
import type { MoneyStore, Person } from "./ledger.ts";
import type { AccountRecords, PaymentsProvider } from "./payments.ts";

export type RecordTag =
  | "expense"
  | "deposit_out"
  | "deposit_back"
  | "share_paid"
  | "share_paid_outside"
  | "loan_payment"
  | "escrow_in"
  | "escrow_release"
  | "escrow_refund"
  | "payment";

export function tagged(description: string, tag: RecordTag, entryId: string): string {
  return `${description} [elves:${tag}:${entryId}]`;
}

const TAG_RE = /\[elves:([a-z_]+):([A-Za-z0-9_]+)\]/;

export function readTag(description: string): { tag: RecordTag; entryId: string } | null {
  const m = description.match(TAG_RE);
  return m?.[1] && m[2] ? { tag: m[1] as RecordTag, entryId: m[2] } : null;
}

export interface PersonOwes {
  personId: string;
  name: string;
  /** Still due on open payment requests (Nessie bills). */
  billCents: number;
  /** The open bills behind billCents, by their Nessie nickname ("truck share"). */
  bills: { nickname: string; amountCents: number }[];
  /** Still due on Moving Fund loans. */
  loanCents: number;
  loanMonthlyCents: number | null;
}

export interface Books {
  /** Balance of the Moving Fund savings account. */
  fundCents: number;
  escrowCents: number;
  /** Shared costs and payments the owner paid out (deposits are tracked separately, in depositsOutCents). */
  spentCents: number;
  /** Paid back by roommates, through the fund or outside it. */
  collectedCents: number;
  salesCents: number;
  depositsOutCents: number;
  owes: PersonOwes[];
  /** Number of tagged Nessie records the totals were built from. */
  records: number;
}

function sumTagged(recs: { amountCents: number; description: string }[], tags: RecordTag[]): number {
  let n = 0;
  for (const r of recs) {
    const t = readTag(r.description);
    if (t && tags.includes(t.tag)) n += r.amountCents;
  }
  return n;
}

function countTagged(r: AccountRecords): number {
  return [...r.withdrawals, ...r.deposits].filter((x) => readTag(x.description)).length;
}

export async function readBooks(
  store: MoneyStore,
  payments: PaymentsProvider,
  moveId: string,
): Promise<Books> {
  const people = await store.listPeople(moveId);
  const owner = people.find((p) => p.role === "owner");
  const fundId = await store.getFundAccount(moveId);
  const escrowId = await store.getEscrowAccount(moveId);
  const read = (id: string | null | undefined) => (id ? payments.readAccount(id) : Promise.resolve(null));
  const others = people.filter((p) => p.role !== "owner" && p.nessieAccountId);
  const [ownerRecs, fundRecs, escrowRecs, ...otherRecs] = await Promise.all([
    read(owner?.nessieAccountId),
    read(fundId),
    read(escrowId),
    ...others.map((p) => read(p.nessieAccountId)),
  ]);

  const books: Books = {
    fundCents: 0,
    escrowCents: 0,
    spentCents: 0,
    collectedCents: 0,
    salesCents: 0,
    depositsOutCents: 0,
    owes: [],
    records: 0,
  };
  if (ownerRecs) {
    books.spentCents += sumTagged(ownerRecs.withdrawals, ["expense", "payment"]);
    books.depositsOutCents +=
      sumTagged(ownerRecs.withdrawals, ["deposit_out"]) - sumTagged(ownerRecs.deposits, ["deposit_back"]);
    books.collectedCents += sumTagged(ownerRecs.deposits, ["share_paid_outside"]);
    books.salesCents += sumTagged(ownerRecs.deposits, ["escrow_release"]);
    books.records += countTagged(ownerRecs);
  }
  if (fundRecs) {
    books.fundCents =
      fundRecs.deposits.reduce((a, r) => a + r.amountCents, 0) -
      fundRecs.withdrawals.reduce((a, r) => a + r.amountCents, 0);
    books.collectedCents += sumTagged(fundRecs.deposits, ["share_paid", "loan_payment"]);
    books.spentCents += sumTagged(fundRecs.withdrawals, ["payment"]);
    books.records += countTagged(fundRecs);
  }
  if (escrowRecs) {
    books.escrowCents =
      escrowRecs.deposits.reduce((a, r) => a + r.amountCents, 0) -
      escrowRecs.withdrawals.reduce((a, r) => a + r.amountCents, 0);
    books.records += countTagged(escrowRecs);
  }
  others.forEach((p: Person, i) => {
    const r = otherRecs[i];
    if (!r) return;
    books.records += countTagged(r);
    const openBills = r.bills.filter((b) => b.status === "pending");
    const billCents = openBills.reduce((a, b) => a + b.amountCents, 0);
    const open = r.loans.filter((l) => l.status === "open");
    const loanCents = open.reduce((a, l) => a + l.amountCents, 0);
    if (billCents || loanCents)
      books.owes.push({
        personId: p.id,
        name: p.name,
        billCents,
        bills: openBills.map((b) => ({ nickname: b.nickname, amountCents: b.amountCents })),
        loanCents,
        loanMonthlyCents: open[0]?.monthlyCents ?? null,
      });
  });
  return books;
}

export function owedTotal(b: Books): number {
  return b.owes.reduce((a, o) => a + o.billCents + o.loanCents, 0);
}

/** One line for the Crew Board's Money row, built from Nessie. */
export function booksLine(b: Books): string {
  const parts: string[] = [];
  if (b.spentCents) parts.push(`${fmtUsd(b.spentCents)} spent`);
  const owed = owedTotal(b);
  if (owed) parts.push(`${fmtUsd(owed)} owed to you`);
  if (b.fundCents) parts.push(`${fmtUsd(b.fundCents)} in the Moving Fund`);
  if (b.escrowCents) parts.push(`${fmtUsd(b.escrowCents)} in escrow`);
  if (b.salesCents) parts.push(`${fmtUsd(b.salesCents)} from sales`);
  if (b.depositsOutCents) parts.push(`${fmtUsd(b.depositsOutCents)} in deposits out`);
  return parts.length ? `Ledger: ${parts.join(", ")}` : "Ledger is empty";
}
