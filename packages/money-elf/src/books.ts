/**
 * The live Ledger: rebuilt on every turn by reading the move's accounts back from Nessie.
 *
 * Nessie never updates balances (decision #9), so each record carries a tag in its description,
 * `[elves:<kind>:<entryId>]`, saying what it was. The totals here come only from those records, so what the
 * owner sees is exactly what is in the bank.
 */
import { fmtUsd } from "./amounts.ts";
import type { MoneyStore, Person } from "./ledger.ts";
import type { AccountRecords, MoneyRails, MoneyRecord } from "./rails.ts";

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
  | "payment"
  /** Move Plans (decision #54): expected sale money into the Moving Fund, a pending deposit. */
  | "plan_in"
  /** Move Plans: an expected cost (truck, movers), a pending withdrawal on the owner's account. */
  | "plan_out";

const PLAN_TAGS: RecordTag[] = ["plan_in", "plan_out"];

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
  /** Balance of the Moving Fund checking account. */
  fundCents: number;
  escrowCents: number;
  /** Shared costs and payments the owner paid out (deposits are tracked separately, in depositsOutCents). */
  spentCents: number;
  /** Paid back by roommates, through the fund or outside it. */
  collectedCents: number;
  salesCents: number;
  depositsOutCents: number;
  owes: PersonOwes[];
  /** Tagged movements and purchases on the owner's, Moving Fund and escrow accounts, newest first. */
  recent: Activity[];
  /** Number of tagged Nessie records the totals were built from. */
  records: number;
  /**
   * The chosen move plan's records (Move Plans), whatever their status: pending = still expected, completed =
   * it happened, cancelled = it won't. Never counted in the totals above.
   */
  planned: PlannedRecord[];
}

export interface PlannedRecord {
  tag: "plan_in" | "plan_out";
  /** The plan line id from the tag (`<planId>_<lineId>`). */
  lineId: string;
  /** Nessie record id, for settling it. */
  recordId: string;
  date: string;
  cents: number;
  status: string;
  label: string;
}

/**
 * Whether a record counts as money that moved. Pending and cancelled records are expectations; plan records are
 * never totals. FakeRails and records written before Move Plans may carry "" or "completed".
 */
function settled(r: { status: string; description: string }): boolean {
  if (r.status !== "" && r.status !== "completed") return false;
  const t = readTag(r.description);
  return !(t && PLAN_TAGS.includes(t.tag));
}

export interface Activity {
  date: string;
  /** The record's description without its tag. */
  label: string;
  amountCents: number;
  account: "you" | "fund" | "escrow";
  direction: "in" | "out";
  tag: RecordTag;
}

export function untagged(description: string): string {
  return description.replace(/\s*\[elves:[^\]]*\]\s*$/, "");
}

function activity(r: AccountRecords, account: Activity["account"]): Activity[] {
  const out: Activity[] = [];
  for (const [list, direction] of [
    [r.deposits, "in"],
    [r.withdrawals, "out"],
    [r.purchases, "out"],
  ] as const) {
    for (const x of list) {
      const t = readTag(x.description);
      if (t && settled(x))
        out.push({
          date: x.date,
          label: untagged(x.description),
          amountCents: x.amountCents,
          account,
          direction,
          tag: t.tag,
        });
    }
  }
  return out;
}

function sumTagged(recs: MoneyRecord[], tags: RecordTag[]): number {
  let n = 0;
  for (const r of recs) {
    const t = readTag(r.description);
    if (t && tags.includes(t.tag) && settled(r)) n += r.amountCents;
  }
  return n;
}

/** Balance of an account from the records that actually moved (pending and plan records excluded). */
function balanceOf(r: AccountRecords): number {
  const sum = (xs: MoneyRecord[]) => xs.filter(settled).reduce((a, x) => a + x.amountCents, 0);
  return sum(r.deposits) - sum(r.withdrawals) - sum(r.purchases);
}

function plannedIn(r: AccountRecords): PlannedRecord[] {
  const out: PlannedRecord[] = [];
  for (const x of [...r.deposits, ...r.withdrawals]) {
    const t = readTag(x.description);
    if (t && (t.tag === "plan_in" || t.tag === "plan_out"))
      out.push({
        tag: t.tag,
        lineId: t.entryId,
        recordId: x.id,
        date: x.date,
        cents: x.amountCents,
        status: x.status,
        label: untagged(x.description),
      });
  }
  return out;
}

function countTagged(r: AccountRecords): number {
  return [...r.withdrawals, ...r.deposits, ...r.purchases].filter((x) => readTag(x.description)).length;
}

export async function readBooks(store: MoneyStore, rails: MoneyRails, moveId: string): Promise<Books> {
  const people = await store.listPeople(moveId);
  const owner = people.find((p) => p.role === "owner");
  const fundId = await store.getFundAccount(moveId);
  const escrowId = await store.getEscrowAccount(moveId);
  const read = (id: string | null | undefined) => (id ? rails.readAccount(id) : Promise.resolve(null));
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
    recent: [],
    records: 0,
    planned: [],
  };
  if (ownerRecs) {
    // Shared costs are purchases at a merchant (SPEC §4); older moves recorded them as withdrawals.
    books.spentCents +=
      sumTagged(ownerRecs.purchases, ["expense"]) + sumTagged(ownerRecs.withdrawals, ["expense", "payment"]);
    books.depositsOutCents +=
      sumTagged(ownerRecs.withdrawals, ["deposit_out"]) - sumTagged(ownerRecs.deposits, ["deposit_back"]);
    books.collectedCents += sumTagged(ownerRecs.deposits, ["share_paid_outside"]);
    // Older moves released sales to the owner's own account; now they go into the Moving Fund.
    books.salesCents += sumTagged(ownerRecs.deposits, ["escrow_release"]);
    books.records += countTagged(ownerRecs);
  }
  if (fundRecs) {
    books.fundCents = balanceOf(fundRecs);
    books.collectedCents += sumTagged(fundRecs.deposits, ["share_paid", "loan_payment"]);
    books.salesCents += sumTagged(fundRecs.deposits, ["escrow_release"]);
    books.spentCents += sumTagged(fundRecs.withdrawals, ["payment"]);
    books.records += countTagged(fundRecs);
  }
  if (escrowRecs) {
    books.escrowCents = balanceOf(escrowRecs);
    books.records += countTagged(escrowRecs);
  }
  books.planned = [...(ownerRecs ? plannedIn(ownerRecs) : []), ...(fundRecs ? plannedIn(fundRecs) : [])].sort(
    (a, b) => a.date.localeCompare(b.date) || a.lineId.localeCompare(b.lineId),
  );
  // Escrow and the Fund mirror the owner's own movements, so the owner's view lists each event once.
  books.recent = [
    ...(ownerRecs ? activity(ownerRecs, "you") : []),
    ...(fundRecs ? activity(fundRecs, "fund") : []),
    ...(escrowRecs ? activity(escrowRecs, "escrow").filter((a) => a.direction === "in") : []),
  ]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => y.a.date.localeCompare(x.a.date) || y.i - x.i)
    .map((x) => x.a);
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
