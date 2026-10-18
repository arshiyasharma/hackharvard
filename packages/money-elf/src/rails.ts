/**
 * Money rails (SPEC §4 `MoneyRails`): where the Money Elf records money. Nessie (Capital One's hackathon bank
 * API) is the simulated rail for now, with an in-memory fake for tests, so Stripe Connect can be swapped in later.
 *
 * Verified live on Oct 17 2026 (see money-elf-decisions.md #9): withdrawals, deposits and purchases are stored
 * but do not change balances, and transfers cannot name a payee. So a movement from A to B is recorded as a
 * withdrawal on A plus a deposit on B, and money paid to a vendor (truck, storage, movers) is a purchase at a
 * merchant. Every record carries an [elves:<tag>:<entry>] tag in its description, and the live Ledger
 * (books.ts) is rebuilt by reading those records back.
 */

export type AccountType = "Checking" | "Savings";

export interface OpenAccountInput {
  firstName: string;
  lastName: string;
  nickname: string;
  /** Default Checking. */
  type?: AccountType;
  /** Open the account on an existing customer instead of creating a new one. */
  customerId?: string;
}

export interface MoveMoneyInput {
  /** null = money arriving from outside the simulated bank. */
  fromAccountId: string | null;
  /** null = money leaving the simulated bank. */
  toAccountId: string | null;
  amountCents: number;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  /**
   * Default completed. "pending" records money that is expected, not moved yet (Move Plans, decision #54):
   * a future-dated record that settle() later flips to completed or cancelled.
   */
  status?: "pending" | "completed";
}

/** Only deposits and withdrawals can be settled: Nessie rejects a status update on a purchase (#54). */
export type SettleKind = "deposit" | "withdrawal";

export interface MoneyRecord {
  id: string;
  amountCents: number;
  status: string;
  description: string;
  date: string;
}

export interface BillRecord {
  id: string;
  amountCents: number;
  status: string;
  nickname: string;
}

export interface LoanRecord {
  id: string;
  /** What is still owed (we PUT the remaining amount after each payment). */
  amountCents: number;
  monthlyCents: number;
  status: string;
  description: string;
}

export interface PurchaseInput {
  accountId: string;
  /** Who was paid ("Truck", "Storage", "Movers"); one Nessie merchant per name. */
  merchant: string;
  amountCents: number;
  description: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface AccountRecords {
  withdrawals: MoneyRecord[];
  deposits: MoneyRecord[];
  /** Money paid out of the account to a merchant. */
  purchases: MoneyRecord[];
  bills: BillRecord[];
  loans: LoanRecord[];
}

export interface MoneyRails {
  readonly name: string;
  openAccount(input: OpenAccountInput): Promise<{ customerId: string; accountId: string }>;
  moveMoney(input: MoveMoneyInput): Promise<{ withdrawalId: string | null; depositId: string | null }>;
  /** Money paid out to a vendor, recorded as a purchase at a merchant of that name. */
  purchase(input: PurchaseInput): Promise<{ purchaseId: string }>;
  createBill(input: {
    accountId: string;
    payee: string;
    nickname: string;
    amountCents: number;
    dueDate: string;
  }): Promise<{ billId: string }>;
  /** Mark a bill completed or cancelled, or lower what is still due after a partial payment. */
  updateBill(
    billId: string,
    patch: { status?: "completed" | "cancelled"; amountCents?: number },
  ): Promise<void>;
  createLoan(input: {
    accountId: string;
    amountCents: number;
    monthlyCents: number;
    description: string;
  }): Promise<{ loanId: string }>;
  updateLoan(loanId: string, patch: { amountCents?: number; status?: string }): Promise<void>;
  /** Flip a pending deposit or withdrawal to completed (it happened) or cancelled (it won't). */
  settle(kind: SettleKind, id: string, status: "completed" | "cancelled"): Promise<void>;
  /** Everything recorded on one account, read back live. */
  readAccount(accountId: string): Promise<AccountRecords>;
}

export class RailsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export interface NessieOptions {
  apiKey: string;
  /** Default https://prod-api.nessieisreal.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Placeholder address for simulated customers; Nessie requires one and the owner's real address never goes there. */
const SIM_ADDRESS = {
  street_number: "1",
  street_name: "Elves Way",
  city: "Cambridge",
  state: "MA",
  zip: "02138",
};

/** Loans need a credit score; roommate IOUs have none, so this fixed value marks "not scored". */
export const IOU_CREDIT_SCORE = 0;
export const IOU_LOAN_TYPE = "Moving Fund IOU";

interface RawRecord {
  _id?: string;
  id?: string;
  amount?: number;
  payment_amount?: number;
  monthly_payment?: number;
  status?: string;
  description?: string;
  nickname?: string;
  transaction_date?: string;
  purchase_date?: string;
}

export class NessieRails implements MoneyRails {
  readonly name = "nessie";
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  /** Merchant ids by name. Nessie's GET /merchants doesn't list ones we create, so they're cached per process. */
  private readonly merchants = new Map<string, Promise<string>>();

  constructor(private readonly opts: NessieOptions) {
    if (!opts.apiKey) throw new Error("NessieRails needs an API key (NESSIE_API_KEY)");
    this.base = (opts.baseUrl ?? "https://prod-api.nessieisreal.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<{ _id: string }> {
    const res = await this.request("POST", path, body);
    const created = (res as { objectCreated?: { _id?: string } } | null)?.objectCreated;
    if (!created?._id)
      throw new RailsError(`Nessie POST ${path}: no objectCreated._id`, 200, JSON.stringify(res));
    return { _id: created._id };
  }

  /** GET a list; Nessie answers 404 with a message string when a list is empty. */
  private async list(path: string): Promise<RawRecord[]> {
    try {
      const res = await this.request("GET", path);
      return Array.isArray(res) ? (res as RawRecord[]) : [];
    } catch (err) {
      if (err instanceof RailsError && err.status === 404) return [];
      throw err;
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    // The key travels as a query parameter (Nessie's only auth); never log the full URL.
    const url = `${this.base}${path}?key=${encodeURIComponent(this.opts.apiKey)}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new RailsError(`Nessie ${method} ${path} failed (${res.status})`, res.status, text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async openAccount(input: OpenAccountInput) {
    const customerId =
      input.customerId ??
      (
        await this.post("/customers", {
          first_name: input.firstName,
          last_name: input.lastName,
          address: SIM_ADDRESS,
        })
      )._id;
    const account = await this.post(`/customers/${customerId}/accounts`, {
      type: input.type ?? "Checking",
      nickname: input.nickname.slice(0, 40),
      rewards: 0,
      balance: 0,
    });
    return { customerId, accountId: account._id };
  }

  async moveMoney(input: MoveMoneyInput) {
    assertCents(input.amountCents);
    const leg = {
      medium: "balance",
      amount: input.amountCents,
      status: input.status ?? "completed",
      transaction_date: input.date,
      description: input.description.slice(0, 200),
    };
    const w = input.fromAccountId
      ? await this.post(`/accounts/${input.fromAccountId}/withdrawals`, leg)
      : null;
    const d = input.toAccountId ? await this.post(`/accounts/${input.toAccountId}/deposits`, leg) : null;
    return { withdrawalId: w?._id ?? null, depositId: d?._id ?? null };
  }

  private merchantId(name: string): Promise<string> {
    const key = name.slice(0, 60);
    let id = this.merchants.get(key);
    if (!id) {
      id = this.post("/merchants", { name: key, category: "moving" }).then((m) => m._id);
      // Forget a failed create so the next purchase retries it.
      id.catch(() => this.merchants.delete(key));
      this.merchants.set(key, id);
    }
    return id;
  }

  async purchase(input: PurchaseInput) {
    assertCents(input.amountCents);
    const p = await this.post(`/accounts/${input.accountId}/purchases`, {
      merchant_id: await this.merchantId(input.merchant),
      medium: "balance",
      amount: input.amountCents,
      // Without status and purchase_date Nessie stores the purchase, then fails to list the account's
      // purchases (verified Oct 17 2026).
      status: "completed",
      purchase_date: input.date,
      description: input.description.slice(0, 200),
    });
    return { purchaseId: p._id };
  }

  async createBill(input: {
    accountId: string;
    payee: string;
    nickname: string;
    amountCents: number;
    dueDate: string;
  }) {
    assertCents(input.amountCents);
    const bill = await this.post(`/accounts/${input.accountId}/bills`, {
      status: "pending",
      payee: input.payee.slice(0, 60),
      nickname: input.nickname.slice(0, 60),
      payment_date: input.dueDate,
      // Without recurring_date Nessie stores the bill but then fails to read it back (verified Oct 17 2026).
      recurring_date: Math.min(31, Math.max(1, Number(input.dueDate.slice(8, 10)) || 1)),
      payment_amount: input.amountCents,
    });
    return { billId: bill._id };
  }

  async updateBill(billId: string, patch: { status?: "completed" | "cancelled"; amountCents?: number }) {
    await this.request("PUT", `/bills/${billId}`, {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.amountCents != null ? { payment_amount: patch.amountCents } : {}),
    });
  }

  async createLoan(input: {
    accountId: string;
    amountCents: number;
    monthlyCents: number;
    description: string;
  }) {
    assertCents(input.amountCents);
    assertCents(input.monthlyCents);
    const loan = await this.post(`/accounts/${input.accountId}/loans`, {
      type: IOU_LOAN_TYPE,
      status: "open",
      credit_score: IOU_CREDIT_SCORE,
      monthly_payment: input.monthlyCents,
      amount: input.amountCents,
      description: input.description.slice(0, 200),
    });
    return { loanId: loan._id };
  }

  async updateLoan(loanId: string, patch: { amountCents?: number; status?: string }) {
    await this.request("PUT", `/loans/${loanId}`, {
      ...(patch.amountCents != null ? { amount: patch.amountCents } : {}),
      ...(patch.status ? { status: patch.status } : {}),
    });
  }

  async settle(kind: SettleKind, id: string, status: "completed" | "cancelled") {
    // PUT paths are singular for withdrawals and plural for deposits (verified Oct 18 2026).
    await this.request("PUT", kind === "deposit" ? `/deposits/${id}` : `/withdrawal/${id}`, { status });
  }

  async readAccount(accountId: string): Promise<AccountRecords> {
    const [w, d, p, b, l] = await Promise.all([
      this.list(`/accounts/${accountId}/withdrawals`),
      this.list(`/accounts/${accountId}/deposits`),
      this.list(`/accounts/${accountId}/purchases`),
      this.list(`/accounts/${accountId}/bills`),
      this.list(`/accounts/${accountId}/loans`),
    ]);
    const money = (r: RawRecord): MoneyRecord => ({
      id: r._id ?? r.id ?? "",
      amountCents: Number(r.amount ?? 0),
      status: r.status ?? "",
      description: r.description ?? "",
      date: r.transaction_date ?? r.purchase_date ?? "",
    });
    return {
      withdrawals: w.map(money),
      deposits: d.map(money),
      purchases: p.map(money),
      bills: b.map((r) => ({
        id: r._id ?? "",
        amountCents: Math.round(Number(r.payment_amount ?? 0)),
        status: r.status ?? "",
        nickname: r.nickname ?? "",
      })),
      loans: l.map((r) => ({
        id: r._id ?? "",
        amountCents: Number(r.amount ?? 0),
        monthlyCents: Number(r.monthly_payment ?? 0),
        status: r.status ?? "",
        description: r.description ?? "",
      })),
    };
  }
}

function assertCents(cents: number) {
  if (!Number.isInteger(cents) || cents <= 0)
    throw new Error(`amounts are positive integer cents, got ${cents}`);
}

/** In-memory rails for tests and runs without NESSIE_API_KEY. Keeps records so reads work like Nessie. */
export class FakeRails implements MoneyRails {
  readonly name = "fake";
  calls: { op: string; input: unknown }[] = [];
  accounts = new Map<string, AccountRecords & { type: AccountType; nickname: string }>();
  bills = new Map<string, BillRecord & { accountId: string }>();
  loans = new Map<string, LoanRecord & { accountId: string }>();
  /** Merchant ids by name, created on first purchase like Nessie's. */
  merchants = new Map<string, string>();
  /** Set to make the next call throw (one-shot). */
  failNext: Error | null = null;
  private n = 0;

  private check(op: string, input: unknown) {
    this.calls.push({ op, input });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }
  private id(p: string) {
    return `${p}_${++this.n}`;
  }
  private acct(id: string) {
    const a = this.accounts.get(id);
    if (!a) throw new RailsError(`unknown account ${id}`, 404, "");
    return a;
  }

  async openAccount(input: OpenAccountInput) {
    this.check("openAccount", input);
    const accountId = this.id("acct");
    this.accounts.set(accountId, {
      type: input.type ?? "Checking",
      nickname: input.nickname,
      withdrawals: [],
      deposits: [],
      purchases: [],
      bills: [],
      loans: [],
    });
    return { customerId: input.customerId ?? this.id("cust"), accountId };
  }
  async moveMoney(input: MoveMoneyInput) {
    this.check("moveMoney", input);
    assertCents(input.amountCents);
    const rec = (id: string): MoneyRecord => ({
      id,
      amountCents: input.amountCents,
      status: input.status ?? "completed",
      description: input.description,
      date: input.date,
    });
    const withdrawalId = input.fromAccountId ? this.id("wd") : null;
    const depositId = input.toAccountId ? this.id("dep") : null;
    if (input.fromAccountId && withdrawalId)
      this.acct(input.fromAccountId).withdrawals.push(rec(withdrawalId));
    if (input.toAccountId && depositId) this.acct(input.toAccountId).deposits.push(rec(depositId));
    return { withdrawalId, depositId };
  }
  async purchase(input: PurchaseInput) {
    this.check("purchase", input);
    assertCents(input.amountCents);
    const a = this.acct(input.accountId);
    if (!this.merchants.has(input.merchant)) this.merchants.set(input.merchant, this.id("merch"));
    const purchaseId = this.id("pur");
    a.purchases.push({
      id: purchaseId,
      amountCents: input.amountCents,
      status: "completed",
      description: input.description,
      date: input.date,
    });
    return { purchaseId };
  }
  async createBill(input: {
    accountId: string;
    payee: string;
    nickname: string;
    amountCents: number;
    dueDate: string;
  }) {
    this.check("createBill", input);
    const billId = this.id("bill");
    this.bills.set(billId, {
      id: billId,
      accountId: input.accountId,
      amountCents: input.amountCents,
      status: "pending",
      nickname: input.nickname,
    });
    return { billId };
  }
  async updateBill(billId: string, patch: { status?: "completed" | "cancelled"; amountCents?: number }) {
    this.check("updateBill", { billId, ...patch });
    const b = this.bills.get(billId);
    if (!b) return;
    if (patch.status) b.status = patch.status;
    if (patch.amountCents != null) b.amountCents = patch.amountCents;
  }
  async createLoan(input: {
    accountId: string;
    amountCents: number;
    monthlyCents: number;
    description: string;
  }) {
    this.check("createLoan", input);
    assertCents(input.amountCents);
    assertCents(input.monthlyCents);
    const loanId = this.id("loan");
    this.loans.set(loanId, {
      id: loanId,
      accountId: input.accountId,
      amountCents: input.amountCents,
      monthlyCents: input.monthlyCents,
      status: "open",
      description: input.description,
    });
    return { loanId };
  }
  async updateLoan(loanId: string, patch: { amountCents?: number; status?: string }) {
    this.check("updateLoan", { loanId, ...patch });
    const l = this.loans.get(loanId);
    if (!l) return;
    if (patch.amountCents != null) l.amountCents = patch.amountCents;
    if (patch.status) l.status = patch.status;
  }
  async settle(kind: SettleKind, id: string, status: "completed" | "cancelled") {
    this.check("settle", { kind, id, status });
    for (const a of this.accounts.values()) {
      const r = (kind === "deposit" ? a.deposits : a.withdrawals).find((x) => x.id === id);
      if (r) {
        r.status = status;
        return;
      }
    }
    throw new RailsError(`unknown ${kind} ${id}`, 404, "");
  }
  async readAccount(accountId: string): Promise<AccountRecords> {
    const a = this.acct(accountId);
    const strip = <T extends { accountId: string }>({ accountId: _a, ...rest }: T) => rest;
    return {
      withdrawals: a.withdrawals.map((x) => ({ ...x })),
      deposits: a.deposits.map((x) => ({ ...x })),
      purchases: a.purchases.map((x) => ({ ...x })),
      bills: [...this.bills.values()].filter((b) => b.accountId === accountId).map(strip),
      loans: [...this.loans.values()].filter((l) => l.accountId === accountId).map(strip),
    };
  }
}
