/**
 * Payments providers. Nessie (Capital One's hackathon bank API) is the simulated provider for now.
 *
 * Verified live on Oct 17 2026 (see money-elf-decisions.md #9): withdrawals and deposits are stored but do
 * not change balances, and transfers cannot name a payee. So a movement from A to B is recorded as a
 * withdrawal on A plus a deposit on B, and the Ledger, not Nessie, is the source of truth for balances.
 */

export interface OpenAccountInput {
  firstName: string;
  lastName: string;
  nickname: string;
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
}

export interface PaymentsProvider {
  readonly name: string;
  openAccount(input: OpenAccountInput): Promise<{ customerId: string; accountId: string }>;
  moveMoney(input: MoveMoneyInput): Promise<{ withdrawalId: string | null; depositId: string | null }>;
  createBill(input: {
    accountId: string;
    payee: string;
    nickname: string;
    amountCents: number;
    dueDate: string;
  }): Promise<{ billId: string }>;
  setBillStatus(billId: string, status: "completed" | "cancelled"): Promise<void>;
}

export class PaymentsError extends Error {
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

export class NessiePayments implements PaymentsProvider {
  readonly name = "nessie";
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: NessieOptions) {
    if (!opts.apiKey) throw new Error("NessiePayments needs an API key (NESSIE_API_KEY)");
    this.base = (opts.baseUrl ?? "https://prod-api.nessieisreal.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<{ _id: string }> {
    const res = await this.request("POST", path, body);
    const created = (res as { objectCreated?: { _id?: string } } | null)?.objectCreated;
    if (!created?._id)
      throw new PaymentsError(`Nessie POST ${path}: no objectCreated._id`, 200, JSON.stringify(res));
    return { _id: created._id };
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
    if (!res.ok) throw new PaymentsError(`Nessie ${method} ${path} failed (${res.status})`, res.status, text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async openAccount(input: OpenAccountInput) {
    const customer = await this.post("/customers", {
      first_name: input.firstName,
      last_name: input.lastName,
      address: SIM_ADDRESS,
    });
    const account = await this.post(`/customers/${customer._id}/accounts`, {
      type: "Checking",
      nickname: input.nickname.slice(0, 40),
      rewards: 0,
      balance: 0,
    });
    return { customerId: customer._id, accountId: account._id };
  }

  async moveMoney(input: MoveMoneyInput) {
    assertCents(input.amountCents);
    const leg = {
      medium: "balance",
      amount: input.amountCents,
      status: "completed",
      transaction_date: input.date,
      description: input.description.slice(0, 120),
    };
    const w = input.fromAccountId
      ? await this.post(`/accounts/${input.fromAccountId}/withdrawals`, leg)
      : null;
    const d = input.toAccountId ? await this.post(`/accounts/${input.toAccountId}/deposits`, leg) : null;
    return { withdrawalId: w?._id ?? null, depositId: d?._id ?? null };
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

  async setBillStatus(billId: string, status: "completed" | "cancelled") {
    await this.request("PUT", `/bills/${billId}`, { status });
  }
}

function assertCents(cents: number) {
  if (!Number.isInteger(cents) || cents <= 0)
    throw new Error(`amounts are positive integer cents, got ${cents}`);
}

/** In-memory provider for tests and runs without NESSIE_API_KEY. Records every call. */
export class FakePayments implements PaymentsProvider {
  readonly name = "fake";
  calls: { op: string; input: unknown }[] = [];
  bills = new Map<string, { status: string; amountCents: number }>();
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

  async openAccount(input: OpenAccountInput) {
    this.check("openAccount", input);
    return { customerId: this.id("cust"), accountId: this.id("acct") };
  }
  async moveMoney(input: MoveMoneyInput) {
    this.check("moveMoney", input);
    assertCents(input.amountCents);
    return {
      withdrawalId: input.fromAccountId ? this.id("wd") : null,
      depositId: input.toAccountId ? this.id("dep") : null,
    };
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
    this.bills.set(billId, { status: "pending", amountCents: input.amountCents });
    return { billId };
  }
  async setBillStatus(billId: string, status: "completed" | "cancelled") {
    this.check("setBillStatus", { billId, status });
    const b = this.bills.get(billId);
    if (b) b.status = status;
  }
}
