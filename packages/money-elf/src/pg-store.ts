/**
 * The Money Elf's own state on Postgres (migration 0010_money.sql). Nessie stays the record of money moved; this
 * holds what Nessie cannot: people and their Nessie ids, ledger entries and the hand-off signals behind an
 * escrow, the approvals waiting for the owner's yes, and each move's escrow and Moving Fund accounts.
 *
 * Takes the crew's Bun SQL client, so it shares the pool the rest of the store uses.
 */
import type { SQL } from "bun";
import type { LedgerEntry, MoneyStore, NessieRefs, PendingAction, PendingKind, Person } from "./ledger.ts";
import type { MerchantCache } from "./rails.ts";
import type { Role } from "./types.ts";

type Row = Record<string, unknown>;

const json = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
};
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

const NO_NESSIE: NessieRefs = { withdrawalIds: [], depositIds: [], purchaseIds: [], billId: null };

function personRow(r: Row): Person {
  return {
    id: String(r.id),
    moveId: String(r.move_id),
    name: String(r.name),
    handle: str(r.handle),
    role: String(r.role) as Role,
    nessieCustomerId: str(r.nessie_customer_id),
    nessieAccountId: str(r.nessie_account_id),
  };
}

function entryRow(r: Row): LedgerEntry {
  return {
    id: String(r.id),
    moveId: String(r.move_id),
    date: String(r.date),
    kind: String(r.kind) as LedgerEntry["kind"],
    what: String(r.what),
    paidBy: str(r.paid_by),
    owedBy: str(r.owed_by),
    paidTo: str(r.paid_to),
    amountCents: num(r.amount_cents),
    status: String(r.status) as LedgerEntry["status"],
    escrow: str(r.escrow) as LedgerEntry["escrow"],
    buyerConfirmedAt: str(r.buyer_confirmed_at),
    ownerOkAt: str(r.owner_ok_at),
    mapConvergedAt: str(r.map_converged_at),
    pickupAt: str(r.pickup_at),
    noShowAt: str(r.no_show_at),
    dealId: str(r.deal_id),
    partyId: str(r.party_id),
    dueBackAt: str(r.due_back_at),
    groupId: str(r.group_id),
    requested: Boolean(r.requested),
    notified: Boolean(r.notified),
    paidCents: num(r.paid_cents),
    loanId: str(r.loan_id),
    loanMonthlyCents: r.loan_monthly_cents == null ? null : num(r.loan_monthly_cents),
    flagged: Boolean(r.flagged),
    nessie: json<NessieRefs>(r.nessie, NO_NESSIE),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function pendingRow(r: Row): PendingAction {
  return {
    id: String(r.id),
    moveId: String(r.move_id),
    kind: String(r.kind) as PendingKind,
    summary: String(r.summary),
    entryIds: json<string[]>(r.entry_ids, []),
    ...(r.data == null ? {} : { data: json<Record<string, number | string>>(r.data, {}) }),
    createdAt: String(r.created_at),
  };
}

/** Nessie merchant ids on Postgres, so a restart reuses them (NessieRails' merchantCache). */
export class PostgresMerchantCache implements MerchantCache {
  constructor(private readonly sql: SQL) {}
  async get(name: string) {
    const rows = await this.sql`select merchant_id from money_merchants where name = ${name}`;
    return str(rows[0]?.merchant_id) ?? undefined;
  }
  async set(name: string, merchantId: string) {
    await this.sql`
      insert into money_merchants (name, merchant_id) values (${name}, ${merchantId})
      on conflict (name) do update set merchant_id = excluded.merchant_id`;
  }
}

export class PostgresMoneyStore implements MoneyStore {
  private seq = 0;

  constructor(private readonly sql: SQL) {}

  // ---------- entries

  async listEntries(moveId: string) {
    const rows = await this.sql`select * from money_entries where move_id = ${moveId} order by seq`;
    return rows.map((r: Row) => entryRow(r));
  }

  async getEntry(id: string) {
    const rows = await this.sql`select * from money_entries where id = ${id}`;
    return rows[0] ? entryRow(rows[0] as Row) : undefined;
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
      nessie: { ...NO_NESSIE },
      createdAt: ts,
      updatedAt: ts,
      ...input,
      id: input.id ?? newId("le"),
    };
    await this.sql`
      insert into money_entries (id, move_id, date, kind, what, paid_by, owed_by, paid_to, amount_cents, status,
        escrow, buyer_confirmed_at, owner_ok_at, map_converged_at, pickup_at, no_show_at, deal_id, party_id,
        due_back_at, group_id, requested, notified, paid_cents, loan_id, loan_monthly_cents, flagged, nessie)
      values (${e.id}, ${e.moveId}, ${e.date}, ${e.kind}, ${e.what}, ${e.paidBy}, ${e.owedBy}, ${e.paidTo},
        ${e.amountCents}, ${e.status}, ${e.escrow}, ${e.buyerConfirmedAt}, ${e.ownerOkAt}, ${e.mapConvergedAt},
        ${e.pickupAt}, ${e.noShowAt}, ${e.dealId}, ${e.partyId}, ${e.dueBackAt}, ${e.groupId}, ${e.requested},
        ${e.notified}, ${e.paidCents}, ${e.loanId}, ${e.loanMonthlyCents}, ${e.flagged},
        ${JSON.stringify(e.nessie)}::jsonb)
      on conflict (id) do nothing`;
    return (await this.getEntry(e.id)) as LedgerEntry;
  }

  async updateEntry(id: string, patch: Partial<Omit<LedgerEntry, "id" | "moveId" | "createdAt">>) {
    const prev = await this.getEntry(id);
    if (!prev) throw new Error(`ledger entry ${id} not found`);
    const e = { ...prev, ...patch };
    await this.sql`
      update money_entries set date = ${e.date}, kind = ${e.kind}, what = ${e.what}, paid_by = ${e.paidBy},
        owed_by = ${e.owedBy}, paid_to = ${e.paidTo}, amount_cents = ${e.amountCents}, status = ${e.status},
        escrow = ${e.escrow}, buyer_confirmed_at = ${e.buyerConfirmedAt}, owner_ok_at = ${e.ownerOkAt},
        map_converged_at = ${e.mapConvergedAt}, pickup_at = ${e.pickupAt}, no_show_at = ${e.noShowAt},
        deal_id = ${e.dealId}, party_id = ${e.partyId}, due_back_at = ${e.dueBackAt}, group_id = ${e.groupId},
        requested = ${e.requested}, notified = ${e.notified}, paid_cents = ${e.paidCents},
        loan_id = ${e.loanId}, loan_monthly_cents = ${e.loanMonthlyCents}, flagged = ${e.flagged},
        nessie = ${JSON.stringify(e.nessie)}::jsonb, updated_at = now()
      where id = ${id}`;
    return (await this.getEntry(id)) as LedgerEntry;
  }

  // ---------- people

  async listPeople(moveId: string) {
    const rows = await this.sql`select * from money_people where move_id = ${moveId} order by seq`;
    return rows.map((r: Row) => personRow(r));
  }

  async getPerson(id: string) {
    const rows = await this.sql`select * from money_people where id = ${id}`;
    return rows[0] ? personRow(rows[0] as Row) : undefined;
  }

  async upsertPerson(input: Pick<Person, "moveId" | "name" | "role"> & Partial<Person>) {
    const prev = input.id ? await this.getPerson(input.id) : undefined;
    const p: Person = {
      handle: null,
      nessieCustomerId: null,
      nessieAccountId: null,
      ...(prev ?? {}),
      ...input,
      id: input.id ?? newId("pp"),
    };
    await this.sql`
      insert into money_people (id, move_id, name, handle, role, nessie_customer_id, nessie_account_id)
      values (${p.id}, ${p.moveId}, ${p.name}, ${p.handle}, ${p.role}, ${p.nessieCustomerId}, ${p.nessieAccountId})
      on conflict (id) do update set name = excluded.name, handle = excluded.handle, role = excluded.role,
        nessie_customer_id = excluded.nessie_customer_id, nessie_account_id = excluded.nessie_account_id`;
    return p;
  }

  // ---------- approvals waiting for the owner

  async listPending(moveId: string) {
    const rows = await this.sql`select * from money_pending where move_id = ${moveId} order by seq`;
    return rows.map((r: Row) => pendingRow(r));
  }

  async addPending(input: Omit<PendingAction, "id" | "createdAt">) {
    // createdAt carries a sequence suffix so "most recent" is stable within one millisecond.
    const a: PendingAction = {
      ...input,
      id: newId("pa"),
      createdAt: `${new Date().toISOString()}#${String(++this.seq).padStart(6, "0")}`,
    };
    await this.sql`
      insert into money_pending (id, move_id, kind, summary, entry_ids, data, created_at)
      values (${a.id}, ${a.moveId}, ${a.kind}, ${a.summary}, ${JSON.stringify(a.entryIds)}::jsonb,
        ${a.data ? JSON.stringify(a.data) : null}::jsonb, ${a.createdAt})`;
    return a;
  }

  async removePending(id: string) {
    await this.sql`delete from money_pending where id = ${id}`;
  }

  async updatePending(id: string, patch: Partial<Pick<PendingAction, "summary" | "data">>) {
    const rows = await this.sql`select * from money_pending where id = ${id}`;
    if (!rows[0]) throw new Error(`pending action ${id} not found`);
    const next = { ...pendingRow(rows[0] as Row), ...patch };
    await this.sql`
      update money_pending set summary = ${next.summary}, data = ${next.data ? JSON.stringify(next.data) : null}::jsonb
      where id = ${id}`;
    return next;
  }

  // ---------- accounts

  async getEscrowAccount(moveId: string) {
    const rows = await this.sql`select escrow_account_id from money_accounts where move_id = ${moveId}`;
    return str(rows[0]?.escrow_account_id) ?? undefined;
  }

  async setEscrowAccount(moveId: string, accountId: string) {
    await this.sql`
      insert into money_accounts (move_id, escrow_account_id) values (${moveId}, ${accountId})
      on conflict (move_id) do update set escrow_account_id = excluded.escrow_account_id`;
  }

  async getFundAccount(moveId: string) {
    const rows = await this.sql`select fund_account_id from money_accounts where move_id = ${moveId}`;
    return str(rows[0]?.fund_account_id) ?? undefined;
  }

  async setFundAccount(moveId: string, accountId: string) {
    await this.sql`
      insert into money_accounts (move_id, fund_account_id) values (${moveId}, ${accountId})
      on conflict (move_id) do update set fund_account_id = excluded.fund_account_id`;
  }
}
