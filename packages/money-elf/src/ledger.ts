/** The Ledger: one running list of every dollar in a move, plus the people and pending approvals behind it. */
import { fmtUsd } from "./amounts.ts";
import type { Plan, PlanLabel } from "./plans.ts";
import type { Role } from "./types.ts";

export type EntryKind = "expense" | "split" | "deposit" | "sale" | "payment";
/** The spec's pending / paid / refunded, plus cancelled for a payment the owner said no to. */
export type EntryStatus = "pending" | "paid" | "refunded" | "cancelled";
export type EscrowState = "held" | "released" | "refunded";

export interface NessieRefs {
  withdrawalIds: string[];
  depositIds: string[];
  purchaseIds: string[];
  billId: string | null;
}

export interface LedgerEntry {
  id: string;
  moveId: string;
  /** YYYY-MM-DD the entry was made. */
  date: string;
  kind: EntryKind;
  what: string;
  /** Person ids. */
  paidBy: string | null;
  owedBy: string | null;
  /** Payments and refunds: who received the money. */
  paidTo: string | null;
  amountCents: number;
  status: EntryStatus;
  /** Sales only: where the buyer's money is. */
  escrow: EscrowState | null;
  /**
   * Sales only: the hand-off signals behind an escrow release (SPEC §4). Release needs the buyer's confirmation
   * plus either the owner's OK or Move Map convergence. ISO timestamps, null until the signal arrives.
   */
  buyerConfirmedAt: string | null;
  ownerOkAt: string | null;
  mapConvergedAt: string | null;
  /** Sales only: when the buyer is due to pick up (ISO). A no-show 24h past this stages a refund. */
  pickupAt: string | null;
  /** Sales only: when the no-show sweep asked the owner about a refund, so it asks once. */
  noShowAt: string | null;
  /** The Deal Engine deal and counterparty this sale came from, so a hand-off or a walk finds its escrow. */
  dealId: string | null;
  partyId: string | null;
  /** Deposits only: YYYY-MM-DD the deposit is due back. */
  dueBackAt: string | null;
  /** Split rows share the id of the expense they split. */
  groupId: string | null;
  /** Split rows: the request has been sent to the person (after the owner's yes). */
  requested: boolean;
  /** Split rows: the person has been texted the request (needs their number). */
  notified: boolean;
  /** Split rows: how much of amountCents has been paid so far (payments can be partial). */
  paidCents: number;
  /** Split rows turned into a Moving Fund loan: the Nessie loan id and the agreed monthly payment. */
  loanId: string | null;
  loanMonthlyCents: number | null;
  /** Blocked by the scam check; never paid. */
  flagged: boolean;
  nessie: NessieRefs;
  createdAt: string;
  updatedAt: string;
}

export interface Person {
  id: string;
  moveId: string;
  name: string;
  /** Phone handle in E.164, when known. */
  handle: string | null;
  role: Role;
  nessieCustomerId: string | null;
  nessieAccountId: string | null;
}

export type PendingKind =
  | "open_escrow"
  | "send_split_requests"
  | "release_escrow"
  | "refund_escrow"
  | "pay_person"
  | "create_loan";

/** A money-moving action waiting for the owner's explicit yes. One yes approves exactly one of these. */
export interface PendingAction {
  id: string;
  moveId: string;
  kind: PendingKind;
  summary: string;
  entryIds: string[];
  /** Kind-specific terms, e.g. { monthlyCents } for a loan. */
  data?: Record<string, number | string>;
  createdAt: string;
}

/** One Nessie record written for the chosen plan (Move Plans, decision #78). */
export interface PlanLine {
  lineId: string;
  kind: "deposit" | "withdrawal";
  recordId: string;
  /** The item a sale line is for; null for the truck and movers. */
  itemId: string | null;
  label: string;
  cents: number;
  date: string;
  status: "pending" | "completed" | "cancelled";
}

/** A move's plans: the latest drafts, the chosen plan and its Nessie records. Drafts never go to Nessie (#80). */
export interface PlanState {
  budgetCents: number;
  moveOutDate: string;
  /** Changes on every draft; poll option ids carry it, so a tap on old drafts is caught. */
  draftKey: string;
  drafts: Plan[];
  chosen: Plan | null;
  chosenLabel: PlanLabel | null;
  chosenAt: string | null;
  /** Line-id prefix of the chosen plan's Nessie records, to tell them from an earlier plan's. */
  chosenPrefix: string | null;
  lines: PlanLine[];
  /** Item id → date the owner was nudged about it, so each item is nudged once. */
  nudged: Record<string, string>;
  /** The real net cost, one point per day it was checked, drawn over the plan's path. */
  history: { date: string; netCents: number }[];
}

export interface MoneyStore {
  listEntries(moveId: string): Promise<LedgerEntry[]>;
  getEntry(id: string): Promise<LedgerEntry | undefined>;
  addEntry(
    input: Pick<LedgerEntry, "moveId" | "date" | "kind" | "what" | "amountCents"> & Partial<LedgerEntry>,
  ): Promise<LedgerEntry>;
  updateEntry(
    id: string,
    patch: Partial<Omit<LedgerEntry, "id" | "moveId" | "createdAt">>,
  ): Promise<LedgerEntry>;

  listPeople(moveId: string): Promise<Person[]>;
  getPerson(id: string): Promise<Person | undefined>;
  upsertPerson(input: Pick<Person, "moveId" | "name" | "role"> & Partial<Person>): Promise<Person>;

  listPending(moveId: string): Promise<PendingAction[]>;
  addPending(input: Omit<PendingAction, "id" | "createdAt">): Promise<PendingAction>;
  removePending(id: string): Promise<void>;
  /** Change a waiting action's terms (a pickup time that arrives after the question was asked). */
  updatePending(id: string, patch: Partial<Pick<PendingAction, "summary" | "data">>): Promise<PendingAction>;

  getEscrowAccount(moveId: string): Promise<string | undefined>;
  setEscrowAccount(moveId: string, accountId: string): Promise<void>;

  /** The owner's Moving Fund checking account in Nessie. */
  getFundAccount(moveId: string): Promise<string | undefined>;
  setFundAccount(moveId: string, accountId: string): Promise<void>;

  getPlans(moveId: string): Promise<PlanState | undefined>;
  setPlans(moveId: string, state: PlanState | null): Promise<void>;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export class MemoryMoneyStore implements MoneyStore {
  entries = new Map<string, LedgerEntry>();
  people = new Map<string, Person>();
  pending = new Map<string, PendingAction>();
  escrow = new Map<string, string>();
  fund = new Map<string, string>();
  plans = new Map<string, PlanState>();
  private seq = 0;

  async listEntries(moveId: string) {
    return [...this.entries.values()].filter((e) => e.moveId === moveId);
  }
  async getEntry(id: string) {
    return this.entries.get(id);
  }
  async addEntry(
    input: Pick<LedgerEntry, "moveId" | "date" | "kind" | "what" | "amountCents"> & Partial<LedgerEntry>,
  ) {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
      throw new Error(`ledger amounts are positive integer cents, got ${input.amountCents}`);
    const ts = new Date().toISOString();
    const e: LedgerEntry = {
      paidBy: null,
      owedBy: null,
      paidTo: null,
      status: "pending",
      escrow: null,
      buyerConfirmedAt: null,
      ownerOkAt: null,
      mapConvergedAt: null,
      pickupAt: null,
      noShowAt: null,
      dealId: null,
      partyId: null,
      dueBackAt: null,
      groupId: null,
      requested: false,
      notified: false,
      paidCents: 0,
      loanId: null,
      loanMonthlyCents: null,
      flagged: false,
      nessie: { withdrawalIds: [], depositIds: [], purchaseIds: [], billId: null },
      createdAt: ts,
      updatedAt: ts,
      ...input,
      id: input.id ?? newId("le"),
    };
    this.entries.set(e.id, e);
    return e;
  }
  async updateEntry(id: string, patch: Partial<Omit<LedgerEntry, "id" | "moveId" | "createdAt">>) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`ledger entry ${id} not found`);
    const next = { ...e, ...patch, updatedAt: new Date().toISOString() };
    this.entries.set(id, next);
    return next;
  }

  async listPeople(moveId: string) {
    return [...this.people.values()].filter((p) => p.moveId === moveId);
  }
  async getPerson(id: string) {
    return this.people.get(id);
  }
  async upsertPerson(input: Pick<Person, "moveId" | "name" | "role"> & Partial<Person>) {
    const prev = input.id ? this.people.get(input.id) : undefined;
    const p: Person = {
      handle: null,
      nessieCustomerId: null,
      nessieAccountId: null,
      ...(prev ?? {}),
      ...input,
      id: input.id ?? newId("pp"),
    };
    this.people.set(p.id, p);
    return p;
  }

  async listPending(moveId: string) {
    return [...this.pending.values()].filter((p) => p.moveId === moveId);
  }
  async addPending(input: Omit<PendingAction, "id" | "createdAt">) {
    // createdAt carries a sequence suffix so "most recent" is stable within one millisecond.
    const a: PendingAction = {
      ...input,
      id: newId("pa"),
      createdAt: `${new Date().toISOString()}#${String(++this.seq).padStart(6, "0")}`,
    };
    this.pending.set(a.id, a);
    return a;
  }
  async removePending(id: string) {
    this.pending.delete(id);
  }
  async updatePending(id: string, patch: Partial<Pick<PendingAction, "summary" | "data">>) {
    const a = this.pending.get(id);
    if (!a) throw new Error(`pending action ${id} not found`);
    const next = { ...a, ...patch };
    this.pending.set(id, next);
    return next;
  }

  async getEscrowAccount(moveId: string) {
    return this.escrow.get(moveId);
  }
  async setEscrowAccount(moveId: string, accountId: string) {
    this.escrow.set(moveId, accountId);
  }

  async getFundAccount(moveId: string) {
    return this.fund.get(moveId);
  }
  async setFundAccount(moveId: string, accountId: string) {
    this.fund.set(moveId, accountId);
  }

  async getPlans(moveId: string) {
    const s = this.plans.get(moveId);
    return s ? structuredClone(s) : undefined;
  }
  async setPlans(moveId: string, state: PlanState | null) {
    if (state) this.plans.set(moveId, structuredClone(state));
    else this.plans.delete(moveId);
  }
}

export interface LedgerTotals {
  /** Shared costs and deposits the owner paid out. */
  spentCents: number;
  /** Still owed to the owner by roommates (requested or not). */
  owedToOwnerCents: number;
  /** Paid back to the owner by roommates. */
  collectedCents: number;
  /** Buyer money sitting in escrow. */
  inEscrowCents: number;
  /** Sale money released from escrow into the Moving Fund. */
  salesCents: number;
  /** Deposits not yet returned. */
  depositsOutCents: number;
  pendingCount: number;
}

export function ledgerTotals(entries: LedgerEntry[], ownerId: string | null): LedgerTotals {
  const t: LedgerTotals = {
    spentCents: 0,
    owedToOwnerCents: 0,
    collectedCents: 0,
    inEscrowCents: 0,
    salesCents: 0,
    depositsOutCents: 0,
    pendingCount: 0,
  };
  for (const e of entries) {
    if (e.flagged) continue;
    if (e.status === "pending") t.pendingCount++;
    switch (e.kind) {
      case "expense":
        if (e.paidBy === ownerId) t.spentCents += e.amountCents;
        break;
      case "split":
        if (e.status === "pending") t.owedToOwnerCents += e.amountCents - e.paidCents;
        t.collectedCents += e.status === "paid" ? e.amountCents : e.paidCents;
        break;
      case "deposit":
        if (e.status === "pending") t.depositsOutCents += e.amountCents;
        break;
      case "sale":
        if (e.escrow === "held") t.inEscrowCents += e.amountCents;
        if (e.escrow === "released") t.salesCents += e.amountCents;
        break;
      case "payment":
        if (e.paidBy === ownerId && e.status === "paid") t.spentCents += e.amountCents;
        break;
    }
  }
  return t;
}

/** One line for the Crew Board's Money row. */
export function boardLine(t: LedgerTotals): string {
  const parts: string[] = [];
  if (t.spentCents) parts.push(`${fmtUsd(t.spentCents)} spent`);
  if (t.owedToOwnerCents) parts.push(`${fmtUsd(t.owedToOwnerCents)} owed to you`);
  if (t.collectedCents) parts.push(`${fmtUsd(t.collectedCents)} collected`);
  if (t.inEscrowCents) parts.push(`${fmtUsd(t.inEscrowCents)} in escrow`);
  if (t.salesCents) parts.push(`${fmtUsd(t.salesCents)} from sales`);
  if (t.depositsOutCents) parts.push(`${fmtUsd(t.depositsOutCents)} in deposits out`);
  return parts.length ? `Ledger: ${parts.join(", ")}` : "Ledger is empty";
}
