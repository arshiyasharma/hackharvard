/**
 * Money operations: every dollar in a move goes through here and lands on the Ledger.
 *
 * Guardrail: methods that move money or request it (`execute*`) are only called after the owner's explicit
 * yes for that one pending action. `propose*` methods only stage a PendingAction. Recording something the
 * owner already paid elsewhere moves nothing, so it needs no approval.
 */
import { fmtUsd, splitCents } from "./amounts.ts";
import { type Books, owedTotal, type RecordTag, readBooks, tagged } from "./books.ts";
import type { LedgerEntry, MoneyStore, PendingAction, Person } from "./ledger.ts";
import type { Share } from "./parse.ts";
import type { MoneyRails } from "./rails.ts";
import type { MoneyEvent, MoneyMove, MoneyPoll, OutboundMessage, Role } from "./types.ts";

export interface OpResult {
  lines: string[];
  events: MoneyEvent[];
  outbound: OutboundMessage[];
}

const empty = (): OpResult => ({ lines: [], events: [], outbound: [] });

/**
 * Whether Elves can text this handle right now. On the shared iMessage pool it can only text someone who has
 * texted Elves first. The Money Elf passes the real answer; callers without one (the Deal Engine, tests)
 * get "yes".
 */
export type Reach = (handle: string) => boolean;
const ANYONE: Reach = () => true;

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class MoneyService {
  constructor(
    readonly store: MoneyStore,
    readonly rails: MoneyRails,
    private readonly now: () => Date = () => new Date(),
  ) {}

  today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** The service's clock (injectable for tests), so projections and records agree on "today". */
  clock(): Date {
    return this.now();
  }

  // ---------- people and accounts ----------

  async owner(move: MoneyMove): Promise<Person> {
    const people = await this.store.listPeople(move.id);
    const found = people.find((p) => p.role === "owner");
    if (found) return found;
    return this.store.upsertPerson({
      moveId: move.id,
      name: move.name ?? "Owner",
      role: "owner",
      handle: move.ownerHandle,
    });
  }

  /** Rebuild a move from its owner on the Ledger (for the web Ledger, which has no message context). */
  async moveFromStore(moveId: string): Promise<MoneyMove | undefined> {
    const owner = (await this.store.listPeople(moveId)).find((p) => p.role === "owner");
    if (!owner?.handle) return undefined;
    return { id: moveId, ownerHandle: owner.handle, name: owner.name === "Owner" ? null : owner.name };
  }

  async findPerson(moveId: string, nameOrHandle: string): Promise<Person | undefined> {
    const people = await this.store.listPeople(moveId);
    return (
      people.find((p) => p.handle === nameOrHandle) ?? people.find((p) => sameName(p.name, nameOrHandle))
    );
  }

  async person(moveId: string, name: string, role: Role, handle: string | null = null): Promise<Person> {
    const existing =
      (handle ? await this.findPerson(moveId, handle) : undefined) ?? (await this.findPerson(moveId, name));
    if (existing) {
      if (handle && existing.handle !== handle) return this.store.upsertPerson({ ...existing, handle });
      return existing;
    }
    return this.store.upsertPerson({ moveId, name, role, handle });
  }

  async roommates(moveId: string): Promise<Person[]> {
    return (await this.store.listPeople(moveId)).filter((p) => p.role === "roommate");
  }

  /** The person's simulated bank account, opened on first use. */
  async account(p: Person): Promise<string> {
    if (p.nessieAccountId) return p.nessieAccountId;
    const [first, ...rest] = p.name.split(/\s+/);
    const acct = await this.rails.openAccount({
      firstName: first || "Elves",
      lastName: rest.join(" ") || p.role,
      nickname: `${p.name} (${p.role})`,
    });
    await this.store.upsertPerson({
      ...p,
      nessieCustomerId: acct.customerId,
      nessieAccountId: acct.accountId,
    });
    return acct.accountId;
  }

  /** The move's Escrow: a Savings account (SPEC §4) on its own "Elves Escrow" customer. */
  async escrowAccount(moveId: string): Promise<string> {
    const existing = await this.store.getEscrowAccount(moveId);
    if (existing) return existing;
    const acct = await this.rails.openAccount({
      firstName: "Elves",
      lastName: "Escrow",
      nickname: `Escrow ${moveId}`,
      type: "Savings",
    });
    await this.store.setEscrowAccount(moveId, acct.accountId);
    return acct.accountId;
  }

  /** The owner's Moving Fund: a second Checking account (SPEC §4) on the owner's own Nessie customer. */
  async fundAccount(move: MoneyMove): Promise<string> {
    const existing = await this.store.getFundAccount(move.id);
    if (existing) return existing;
    const owner = await this.owner(move);
    await this.account(owner);
    const fresh = (await this.store.getPerson(owner.id)) ?? owner;
    const acct = await this.rails.openAccount({
      firstName: fresh.name,
      lastName: "Moving Fund",
      nickname: "Moving Fund",
      type: "Checking",
      customerId: fresh.nessieCustomerId ?? undefined,
    });
    await this.store.setFundAccount(move.id, acct.accountId);
    return acct.accountId;
  }

  /** The live Ledger, read back from Nessie. */
  async books(move: MoneyMove): Promise<Books> {
    return readBooks(this.store, this.rails, move.id);
  }

  /** Record a movement in Nessie, tagged so the live Ledger can read it back. */
  private async movement(
    entry: LedgerEntry,
    from: string | null,
    to: string | null,
    description: string,
    tag: RecordTag,
    amountCents: number = entry.amountCents,
  ): Promise<LedgerEntry> {
    const r = await this.rails.moveMoney({
      fromAccountId: from,
      toAccountId: to,
      amountCents,
      description: tagged(description, tag, entry.id),
      date: this.today(),
    });
    const fresh = (await this.store.getEntry(entry.id)) ?? entry;
    return this.store.updateEntry(entry.id, {
      nessie: {
        ...fresh.nessie,
        withdrawalIds: [...fresh.nessie.withdrawalIds, ...(r.withdrawalId ? [r.withdrawalId] : [])],
        depositIds: [...fresh.nessie.depositIds, ...(r.depositId ? [r.depositId] : [])],
      },
    });
  }

  /** Record money the owner paid a vendor (truck, storage, movers) as a Nessie purchase at that merchant. */
  private async purchase(
    entry: LedgerEntry,
    from: string,
    merchant: string,
    description: string,
    tag: RecordTag,
  ): Promise<LedgerEntry> {
    const r = await this.rails.purchase({
      accountId: from,
      merchant,
      amountCents: entry.amountCents,
      description: tagged(description, tag, entry.id),
      date: this.today(),
    });
    const fresh = (await this.store.getEntry(entry.id)) ?? entry;
    return this.store.updateEntry(entry.id, {
      nessie: { ...fresh.nessie, purchaseIds: [...fresh.nessie.purchaseIds, r.purchaseId] },
    });
  }

  private async name(id: string | null): Promise<string> {
    if (!id) return "someone";
    return (await this.store.getPerson(id))?.name ?? "someone";
  }

  // ---------- contacts ----------

  /** Save a roommate's number and text them any approved requests that were waiting for it. */
  async addContact(move: MoneyMove, name: string, handle: string, reach: Reach = ANYONE): Promise<OpResult> {
    const out = empty();
    const p = await this.person(move.id, name, "roommate", handle);
    out.lines.push(`Got it, ${p.name} is ${handle}.`);
    const waiting = (await this.store.listEntries(move.id)).filter(
      (e) => e.kind === "split" && e.owedBy === p.id && e.requested && !e.notified && e.status === "pending",
    );
    for (const e of waiting) {
      out.outbound.push(await this.requestFor(move, p, e, handle));
      // Someone Elves can't text yet stays un-notified; the owner is told to pass it on instead.
      if (reach(handle)) await this.store.updateEntry(e.id, { notified: true });
    }
    if (waiting.length && reach(handle))
      out.lines.push(`I just texted ${p.name} the request for ${fmtUsd(sum(waiting))}.`);
    return out;
  }

  private async requestFor(
    move: MoneyMove,
    p: Person,
    e: LedgerEntry,
    handle: string,
  ): Promise<OutboundMessage> {
    return {
      toHandle: handle,
      toName: p.name,
      about: `the ${fmtUsd(e.amountCents)} ${e.what} share`,
      text: await this.requestText(move, p, e),
    };
  }

  private async requestText(move: MoneyMove, p: Person, e: LedgerEntry): Promise<string> {
    const owner = await this.owner(move);
    return `Hi ${p.name}, it's Elves, ${owner.name === "Owner" ? "your roommate's" : `${owner.name}'s`} moving crew. Your share of the ${e.what} is ${fmtUsd(e.amountCents)}. Reply PAID once you've sent it, or ask for a payment plan.`;
  }

  // ---------- splits / Moving Fund ----------

  /** Record a shared cost the owner fronted and stage the payment requests for the owner's yes. */
  async proposeSplit(
    move: MoneyMove,
    input: { amountCents: number; what: string; shares: Share[] },
  ): Promise<OpResult> {
    const out = empty();
    const owner = await this.owner(move);
    const others = input.shares.filter((s) => s.name !== "me");
    if (others.length === 0) {
      out.lines.push(`Who's splitting the ${fmtUsd(input.amountCents)} ${input.what} with you?`);
      return out;
    }
    const parts = splitCents(
      input.amountCents,
      input.shares.map((s) => s.weight),
    );
    const expense = await this.store.addEntry({
      moveId: move.id,
      date: this.today(),
      kind: "expense",
      what: input.what,
      amountCents: input.amountCents,
      paidBy: owner.id,
      status: "paid",
    });
    await this.purchase(
      expense,
      await this.account(owner),
      cap(input.what),
      `${cap(input.what)} (you paid)`,
      "expense",
    );
    out.events.push({
      type: "ledger.entry_added",
      payload: { entryId: expense.id, kind: "expense", amountCents: input.amountCents },
    });
    const rows: LedgerEntry[] = [];
    const labels: string[] = [];
    for (const [i, s] of input.shares.entries()) {
      const cents = parts[i] ?? 0;
      if (s.name === "me") {
        labels.push(`you ${fmtUsd(cents)}`);
        continue;
      }
      if (cents <= 0) continue;
      const p = await this.person(move.id, s.name, "roommate");
      rows.push(
        await this.store.addEntry({
          moveId: move.id,
          date: this.today(),
          kind: "split",
          what: input.what,
          amountCents: cents,
          owedBy: p.id,
          paidTo: owner.id,
          groupId: expense.id,
          status: "pending",
        }),
      );
      labels.push(`${p.name} ${fmtUsd(cents)}`);
    }
    const summary = `send payment requests for the ${input.what}: ${labels.filter((l) => !l.startsWith("you")).join(", ")}`;
    const pending = await this.store.addPending({
      moveId: move.id,
      kind: "send_split_requests",
      summary,
      entryIds: rows.map((r) => r.id),
    });
    out.events.push({ type: "approval.requested", payload: { pendingId: pending.id, kind: pending.kind } });
    out.lines.push(`${cap(input.what)} ${fmtUsd(input.amountCents)} split: ${labels.join(", ")}.`);
    out.lines.push(
      `Want me to send ${rows.length === 1 ? "the request" : `the ${rows.length} requests`}? Reply yes.`,
    );
    return out;
  }

  async executeSplitRequests(
    move: MoneyMove,
    action: PendingAction,
    reach: Reach = ANYONE,
  ): Promise<OpResult> {
    const out = empty();
    const owner = await this.owner(move);
    const missing: string[] = [];
    let sent = 0;
    for (const id of action.entryIds) {
      const e = await this.store.getEntry(id);
      if (e?.status !== "pending" || e.flagged || e.requested) continue;
      const p = e.owedBy ? await this.store.getPerson(e.owedBy) : undefined;
      if (!p) continue;
      const acct = await this.account(p);
      const bill = await this.rails.createBill({
        accountId: acct,
        payee: `${owner.name} (Elves Moving Fund)`,
        nickname: `${e.what} share`,
        amountCents: e.amountCents,
        dueDate: this.today(),
      });
      await this.store.updateEntry(e.id, { requested: true, nessie: { ...e.nessie, billId: bill.billId } });
      out.events.push({
        type: "payment.requested",
        payload: {
          entryId: e.id,
          personId: p.id,
          amountCents: e.amountCents,
          what: e.what,
          billId: bill.billId,
        },
      });
      if (p.handle) {
        out.outbound.push(await this.requestFor(move, p, e, p.handle));
        if (reach(p.handle)) {
          await this.store.updateEntry(e.id, { notified: true });
          sent++;
        }
      } else {
        missing.push(p.name);
      }
    }
    if (sent)
      out.lines.push(
        `Sent ${sent === 1 ? "the request" : `${sent} requests`}; I'll tell you as each one pays.`,
      );
    if (missing.length) {
      out.lines.push(
        `${sent ? "" : "Requests are on the Ledger. "}What's ${missing[0]}'s number so I can text the request?`,
      );
    }
    return out;
  }

  /**
   * The person paid some or all of what they owe. Through us (they replied PAID): roommate account to the
   * Moving Fund. Owner reporting it (Venmo etc.): recorded as money arriving from outside. Partial payments
   * lower the open bill or the loan balance in Nessie.
   */
  async markPaid(
    move: MoneyMove,
    input: { person: Person; what: string | null; viaLedger: boolean; amountCents?: number | null },
  ): Promise<OpResult> {
    const out = empty();
    const open = (await this.store.listEntries(move.id))
      .filter(
        (e) => e.kind === "split" && e.owedBy === input.person.id && e.status === "pending" && !e.flagged,
      )
      .filter((e) => !input.what || e.what.toLowerCase().includes(input.what.toLowerCase()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const e = open[0];
    if (!e) {
      out.lines.push(`${input.person.name} doesn't owe anything on the Ledger right now.`);
      return out;
    }
    const remaining = e.amountCents - e.paidCents;
    // A bare PAID on a loan is one monthly payment; otherwise it settles the rest.
    const asked = input.amountCents ?? (e.loanId ? (e.loanMonthlyCents ?? remaining) : remaining);
    const pay = Math.min(asked, remaining);
    const tag: RecordTag = e.loanId ? "loan_payment" : input.viaLedger ? "share_paid" : "share_paid_outside";
    const label = `${input.person.name}: ${e.what} ${e.loanId ? "loan payment" : "share"}`;
    if (input.viaLedger) {
      await this.movement(e, await this.account(input.person), await this.fundAccount(move), label, tag, pay);
    } else {
      const owner = await this.owner(move);
      await this.movement(e, null, await this.account(owner), `${label} (paid outside Elves)`, tag, pay);
    }
    const paidCents = e.paidCents + pay;
    const left = e.amountCents - paidCents;
    const fresh = (await this.store.getEntry(e.id)) ?? e;
    if (e.loanId) {
      await this.rails.updateLoan(e.loanId, {
        amountCents: left,
        status: left === 0 ? "paid off" : "open",
      });
    } else if (fresh.nessie.billId) {
      await this.rails.updateBill(
        fresh.nessie.billId,
        left === 0 ? { status: "completed" } : { amountCents: left },
      );
    }
    await this.store.updateEntry(e.id, {
      paidCents,
      status: left === 0 ? "paid" : "pending",
      paidBy: input.person.id,
    });
    out.events.push({
      type: "payment.received",
      payload: {
        entryId: e.id,
        personId: input.person.id,
        amountCents: pay,
        leftCents: left,
        via: input.viaLedger ? "ledger" : "off_ledger",
        loanId: e.loanId,
      },
    });
    if (left === 0) {
      out.lines.push(
        `${input.person.name} paid ${fmtUsd(pay)} for the ${e.what}${e.loanId ? " and the loan is paid off" : ""}.${open.length > 1 ? ` ${open.length - 1} more open for them.` : ""}`,
      );
    } else {
      out.lines.push(
        `${input.person.name} paid ${fmtUsd(pay)} toward the ${e.what}; ${fmtUsd(left)} left${e.loanId ? " on the loan" : ""}.`,
      );
    }
    if (asked > remaining) out.lines.push(`That's more than they owed, so I only counted ${fmtUsd(pay)}.`);
    return out;
  }

  // ---------- Moving Fund loans (roommate IOUs) ----------

  /**
   * Turn a roommate's open share into a Moving Fund loan with a monthly payment. The owner is the lender, so
   * it waits for the owner's yes whether the roommate asked or the owner offered.
   */
  async proposeLoan(
    move: MoneyMove,
    input: { person: Person; what: string | null; monthlyCents: number | null },
  ): Promise<OpResult> {
    const out = empty();
    const e = (await this.store.listEntries(move.id))
      .filter(
        (x) =>
          x.kind === "split" &&
          x.owedBy === input.person.id &&
          x.status === "pending" &&
          !x.flagged &&
          !x.loanId,
      )
      .filter((x) => !input.what || x.what.toLowerCase().includes(input.what.toLowerCase()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!e) {
      out.lines.push(`${input.person.name} has no open share to put on a payment plan.`);
      return out;
    }
    const remaining = e.amountCents - e.paidCents;
    const monthly = Math.min(remaining, input.monthlyCents ?? defaultMonthly(remaining));
    const months = Math.ceil(remaining / monthly);
    const summary = `put ${input.person.name}'s ${fmtUsd(remaining)} ${e.what} share on a Moving Fund loan at ${fmtUsd(monthly)}/month (${months} payment${months === 1 ? "" : "s"})`;
    const pending = await this.store.addPending({
      moveId: move.id,
      kind: "create_loan",
      summary,
      entryIds: [e.id],
      data: { monthlyCents: monthly },
    });
    out.events.push({ type: "approval.requested", payload: { pendingId: pending.id, kind: pending.kind } });
    out.lines.push(
      `${input.person.name} can pay the ${fmtUsd(remaining)} ${e.what} share at ${fmtUsd(monthly)} a month, ${months} payment${months === 1 ? "" : "s"}.`,
    );
    out.lines.push("Set it up as a Moving Fund loan? Reply yes.");
    return out;
  }

  async executeLoan(move: MoneyMove, action: PendingAction): Promise<OpResult> {
    const out = empty();
    const e = await this.store.getEntry(action.entryIds[0] ?? "");
    const monthly = Number(action.data?.monthlyCents ?? 0);
    if (e?.status !== "pending" || e.loanId || e.flagged || monthly <= 0) {
      out.lines.push("That share isn't open anymore, so I didn't set up a loan.");
      return out;
    }
    const p = e.owedBy ? await this.store.getPerson(e.owedBy) : undefined;
    if (!p) throw new Error(`split ${e.id} has no person`);
    const owner = await this.owner(move);
    const remaining = e.amountCents - e.paidCents;
    const loan = await this.rails.createLoan({
      accountId: await this.account(p),
      amountCents: remaining,
      monthlyCents: monthly,
      description: `${p.name} owes ${owner.name}'s Moving Fund for the ${e.what} [elves:loan:${e.id}]`,
    });
    // The loan replaces the payment request.
    if (e.nessie.billId) await this.rails.updateBill(e.nessie.billId, { status: "cancelled" });
    await this.store.updateEntry(e.id, { loanId: loan.loanId, loanMonthlyCents: monthly });
    out.events.push({
      type: "loan.created",
      payload: {
        entryId: e.id,
        loanId: loan.loanId,
        amountCents: remaining,
        monthlyCents: monthly,
        personId: p.id,
      },
    });
    if (p.handle)
      out.outbound.push({
        toHandle: p.handle,
        toName: p.name,
        about: `the ${fmtUsd(remaining)} ${e.what} payment plan (${fmtUsd(monthly)} a month)`,
        text: `You're on a payment plan for the ${e.what}: ${fmtUsd(remaining)} at ${fmtUsd(monthly)} a month into the Moving Fund. Reply PAID each time you send a payment.`,
      });
    out.lines.push(
      `Done: ${p.name}'s ${fmtUsd(remaining)} is a Moving Fund loan at ${fmtUsd(monthly)} a month.`,
    );
    return out;
  }

  // ---------- deposits ----------

  /** Log a deposit the owner already paid elsewhere (nothing moves through us, so no approval). */
  async recordDeposit(
    move: MoneyMove,
    input: { amountCents: number; what: string; dueBackAt: string | null },
  ): Promise<OpResult> {
    const out = empty();
    const owner = await this.owner(move);
    let e = await this.store.addEntry({
      moveId: move.id,
      date: this.today(),
      kind: "deposit",
      what: input.what,
      amountCents: input.amountCents,
      paidBy: owner.id,
      dueBackAt: input.dueBackAt,
      status: "pending",
    });
    e = await this.movement(e, await this.account(owner), null, `Deposit: ${input.what}`, "deposit_out");
    out.events.push({
      type: "deposit.recorded",
      payload: { entryId: e.id, amountCents: e.amountCents, dueBackAt: e.dueBackAt },
    });
    out.lines.push(
      `Logged your ${fmtUsd(input.amountCents)} ${input.what === "deposit" ? "deposit" : `${input.what} deposit`}.`,
    );
    out.lines.push(
      input.dueBackAt ? `I'll remind you if it isn't back by ${input.dueBackAt}.` : "When is it due back?",
    );
    return out;
  }

  async depositReturned(move: MoneyMove, what: string | null): Promise<OpResult> {
    const out = empty();
    const open = (await this.store.listEntries(move.id)).filter(
      (e) => e.kind === "deposit" && e.status === "pending",
    );
    const matches = what ? open.filter((e) => e.what.toLowerCase().includes(what.toLowerCase())) : open;
    if (matches.length !== 1) {
      out.lines.push(
        open.length === 0
          ? "There's no open deposit on the Ledger."
          : `Which deposit came back: ${open.map((e) => `${e.what} ${fmtUsd(e.amountCents)}`).join(" or ")}?`,
      );
      return out;
    }
    const e = matches[0];
    if (!e) return out;
    const owner = await this.owner(move);
    await this.movement(e, null, await this.account(owner), `Deposit returned: ${e.what}`, "deposit_back");
    await this.store.updateEntry(e.id, { status: "refunded", paidTo: owner.id });
    out.events.push({ type: "deposit.returned", payload: { entryId: e.id, amountCents: e.amountCents } });
    out.lines.push(`Nice, the ${fmtUsd(e.amountCents)} ${e.what} deposit is back. Marked it on the Ledger.`);
    return out;
  }

  // ---------- escrow for sales ----------
  //
  // SPEC §4: the buyer's price is held in the move's Escrow (Savings) account. On hand-off it moves into the
  // Moving Fund once two signals are in, in either order: the buyer confirms pickup, plus the owner's OK (a yes
  // or poll tap) or Move Map convergence. A no-show 24h past the pickup time, or the owner calling the sale
  // off, refunds the buyer after the owner's yes.

  /**
   * Hand-off from the Stuff Elf / Deal Engine: the buyer paid for an item. The buyer's own action, so no owner
   * approval; the money sits in escrow until the hand-off signals are in.
   */
  async openEscrow(
    move: MoneyMove,
    input: {
      item: string;
      buyerName: string;
      buyerHandle: string | null;
      amountCents: number;
      /** When the buyer is due to pick up (ISO), for the 24h no-show rule. */
      pickupAt?: string | null;
    },
  ): Promise<OpResult & { entry: LedgerEntry }> {
    const out = empty();
    const buyer = await this.person(move.id, input.buyerName, "buyer", input.buyerHandle);
    const owner = await this.owner(move);
    let entry = await this.store.addEntry({
      moveId: move.id,
      date: this.today(),
      kind: "sale",
      what: input.item,
      amountCents: input.amountCents,
      paidBy: buyer.id,
      paidTo: owner.id,
      status: "pending",
      escrow: "held",
      pickupAt: input.pickupAt ?? null,
    });
    entry = await this.movement(
      entry,
      await this.account(buyer),
      await this.escrowAccount(move.id),
      `Escrow: ${input.item}`,
      "escrow_in",
    );
    out.events.push({
      type: "escrow.opened",
      payload: { entryId: entry.id, buyerId: buyer.id, amountCents: entry.amountCents, item: input.item },
    });
    out.outbound.push({
      toHandle: move.ownerHandle,
      text: `${buyer.name} paid ${fmtUsd(entry.amountCents)} for the ${input.item}; it's held in escrow until ${buyer.name} confirms pickup and you OK it.`,
    });
    if (buyer.handle)
      out.outbound.push({
        toHandle: buyer.handle,
        toName: buyer.name,
        about: `confirming pickup of the ${input.item}`,
        text: `Your ${fmtUsd(entry.amountCents)} for the ${input.item} is held in escrow. Text "got it" here once you've picked it up.`,
      });
    return { ...out, entry };
  }

  private async heldSale(moveId: string, item: string | null): Promise<LedgerEntry[]> {
    const held = (await this.store.listEntries(moveId)).filter(
      (e) => e.kind === "sale" && e.escrow === "held",
    );
    return item ? held.filter((e) => e.what.toLowerCase().includes(item.toLowerCase())) : held;
  }

  /** Close every open question about one entry (the sale moved on, or a newer question replaces it). */
  private async dropPending(moveId: string, entryId: string): Promise<void> {
    for (const a of await this.store.listPending(moveId))
      if (a.entryIds.includes(entryId)) await this.store.removePending(a.id);
  }

  private releaseSummary(e: LedgerEntry): string {
    return `move ${fmtUsd(e.amountCents)} from escrow to the Moving Fund for the ${e.what}`;
  }

  /** The owner says the pickup happened (release) or fell through (refund). Either waits for their yes. */
  async proposeEscrow(
    move: MoneyMove,
    kind: "release_escrow" | "refund_escrow",
    item: string | null,
  ): Promise<OpResult> {
    const out = empty();
    const held = await this.heldSale(move.id, item);
    if (held.length !== 1) {
      const all = await this.heldSale(move.id, null);
      out.lines.push(
        all.length === 0
          ? "Nothing is held in escrow right now."
          : `Which sale: ${all.map((e) => `${e.what} ${fmtUsd(e.amountCents)}`).join(" or ")}?`,
      );
      return out;
    }
    const e = held[0];
    if (!e) return out;
    const buyer = await this.name(e.paidBy);
    if (kind === "release_escrow" && e.ownerOkAt) {
      out.lines.push(
        `You already OK'd the ${e.what}. The ${fmtUsd(e.amountCents)} moves to the Moving Fund as soon as ${buyer} confirms pickup.`,
      );
      return out;
    }
    // One open question per sale: a newer release or refund question replaces the older one.
    await this.dropPending(move.id, e.id);
    const summary =
      kind === "release_escrow"
        ? this.releaseSummary(e)
        : `refund ${buyer} ${fmtUsd(e.amountCents)} for the ${e.what}`;
    const pending = await this.store.addPending({ moveId: move.id, kind, summary, entryIds: [e.id] });
    out.events.push({ type: "approval.requested", payload: { pendingId: pending.id, kind } });
    if (kind === "release_escrow" && e.buyerConfirmedAt) {
      out.lines.push(`${buyer} confirmed pickup of the ${e.what}. ${fmtUsd(e.amountCents)} is in escrow.`);
      out.lines.push("Move it to the Moving Fund? Reply yes.");
    } else if (kind === "release_escrow") {
      out.lines.push(
        `${fmtUsd(e.amountCents)} for the ${e.what} is in escrow. It moves to the Moving Fund once you OK it and ${buyer} confirms pickup.`,
      );
      out.lines.push("OK it now? Reply yes.");
    } else {
      out.lines.push(
        `Sorry the ${e.what} pickup fell through. ${buyer}'s ${fmtUsd(e.amountCents)} is still in escrow.`,
      );
      out.lines.push(`Refund ${buyer}? Reply yes.`);
    }
    return out;
  }

  async executeEscrow(move: MoneyMove, action: PendingAction): Promise<OpResult> {
    const out = empty();
    const e = await this.store.getEntry(action.entryIds[0] ?? "");
    if (e?.escrow !== "held") {
      out.lines.push("That sale isn't in escrow anymore, so nothing moved.");
      return out;
    }
    const buyer = e.paidBy ? await this.store.getPerson(e.paidBy) : undefined;
    if (!buyer) throw new Error(`sale ${e.id} has no buyer`);
    if (action.kind === "release_escrow") {
      // The owner's 👍 is one signal; the money moves only once the buyer has confirmed too.
      const ok = await this.store.updateEntry(e.id, { ownerOkAt: this.now().toISOString() });
      out.events.push({ type: "escrow.owner_ok", payload: { entryId: e.id } });
      const released = await this.tryRelease(move, ok);
      if (released) return mergeOps(out, released);
      out.lines.push(
        `OK'd. I'll move the ${fmtUsd(e.amountCents)} for the ${e.what} to the Moving Fund as soon as ${buyer.name} confirms pickup.`,
      );
      if (buyer.handle)
        out.outbound.push({
          toHandle: buyer.handle,
          toName: buyer.name,
          about: `confirming pickup of the ${e.what}`,
          text: `Did you pick up the ${e.what}? Text "got it" here to confirm.`,
        });
      return out;
    }
    await this.movement(
      e,
      await this.escrowAccount(move.id),
      await this.account(buyer),
      `Refund: ${e.what}`,
      "escrow_refund",
    );
    await this.store.updateEntry(e.id, { escrow: "refunded", status: "refunded", paidTo: buyer.id });
    await this.dropPending(move.id, e.id);
    out.events.push({ type: "escrow.refunded", payload: { entryId: e.id, amountCents: e.amountCents } });
    if (buyer.handle)
      out.outbound.push({
        toHandle: buyer.handle,
        toName: buyer.name,
        about: `their ${fmtUsd(e.amountCents)} refund for the ${e.what}`,
        text: `Your ${fmtUsd(e.amountCents)} for the ${e.what} has been refunded.`,
      });
    out.lines.push(
      `Refunded ${buyer.name} ${fmtUsd(e.amountCents)}. I'll tell the Stuff Elf the ${e.what} is available again.`,
    );
    return out;
  }

  /** Release a held sale into the Moving Fund if both hand-off signals are in; otherwise do nothing. */
  private async tryRelease(move: MoneyMove, e: LedgerEntry): Promise<OpResult | null> {
    if (e.escrow !== "held" || !e.buyerConfirmedAt || !(e.ownerOkAt || e.mapConvergedAt)) return null;
    const out = empty();
    await this.movement(
      e,
      await this.escrowAccount(move.id),
      await this.fundAccount(move),
      `Release to the Moving Fund: ${e.what}`,
      "escrow_release",
    );
    const owner = await this.owner(move);
    await this.store.updateEntry(e.id, { escrow: "released", status: "paid", paidTo: owner.id });
    await this.dropPending(move.id, e.id);
    out.events.push({
      type: "escrow.released",
      payload: {
        entryId: e.id,
        amountCents: e.amountCents,
        signals: ["buyer_confirmed", e.ownerOkAt ? "owner_ok" : "map_converged"],
      },
    });
    out.lines.push(`Moved ${fmtUsd(e.amountCents)} for the ${e.what} from escrow into the Moving Fund.`);
    return out;
  }

  /**
   * The buyer confirms they have the item: from their own DM ("got it"), or from the Deal Engine when it sees
   * the confirmation (pass `entryId`). If the owner's OK or Map convergence is already in, the money moves now;
   * otherwise the owner gets the release question with a poll. Lines are for the buyer.
   */
  async confirmPickup(
    move: MoneyMove,
    input: { via: "buyer" | "engine"; entryId?: string; buyer?: Person; item?: string | null },
  ): Promise<OpResult> {
    const out = empty();
    let held = await this.heldSale(move.id, null);
    if (input.entryId) held = held.filter((e) => e.id === input.entryId);
    const buyerId = input.buyer?.id;
    if (buyerId) held = held.filter((e) => e.paidBy === buyerId);
    // Narrow by the item they named, unless that rules out everything (a buyer's wording is loose).
    const item = input.item?.toLowerCase();
    const named = item ? held.filter((e) => e.what.toLowerCase().includes(item)) : [];
    if (named.length) held = named;
    const first = held[0];
    if (!first || held.length !== 1) {
      out.lines.push(
        first
          ? `Which one did you pick up: ${held.map((e) => e.what).join(" or ")}?`
          : "I don't see a payment of yours waiting in escrow.",
      );
      return out;
    }
    const e = first.buyerConfirmedAt
      ? first
      : await this.store.updateEntry(first.id, { buyerConfirmedAt: this.now().toISOString() });
    out.events.push({ type: "escrow.buyer_confirmed", payload: { entryId: e.id, via: input.via } });
    const buyer = await this.name(e.paidBy);
    const released = await this.tryRelease(move, e);
    if (released) {
      out.events.push(...released.events);
      out.outbound.push({
        toHandle: move.ownerHandle,
        text: `${buyer} confirmed pickup of the ${e.what}, so ${fmtUsd(e.amountCents)} moved from escrow into the Moving Fund.`,
      });
      out.lines.push(`Thanks, pickup of the ${e.what} is confirmed. You're all set.`);
      return out;
    }
    // Still needs the owner's 👍. Reuse an open release question; a stale refund question is dropped.
    const open = (await this.store.listPending(move.id)).find(
      (a) => a.kind === "release_escrow" && a.entryIds.includes(e.id),
    );
    if (!open) await this.dropPending(move.id, e.id);
    const pending =
      open ??
      (await this.store.addPending({
        moveId: move.id,
        kind: "release_escrow",
        summary: this.releaseSummary(e),
        entryIds: [e.id],
      }));
    if (!open)
      out.events.push({ type: "approval.requested", payload: { pendingId: pending.id, kind: pending.kind } });
    out.outbound.push({
      toHandle: move.ownerHandle,
      text: `${buyer} confirmed they picked up the ${e.what}. Move the ${fmtUsd(e.amountCents)} from escrow to the Moving Fund? Reply yes.`,
      poll: approvalPollFor(pending),
    });
    out.lines.push(`Thanks, pickup of the ${e.what} is confirmed. The seller releases the payment next.`);
    return out;
  }

  /**
   * Move Map convergence (a stub hook until the Move Map exists): the Deal Engine calls this when the buyer's
   * and the owner's pins meet at the hand-off. It stands in for the owner's 👍 as the second release signal.
   */
  async mapConverged(move: MoneyMove, entryId: string): Promise<OpResult> {
    const out = empty();
    const found = await this.store.getEntry(entryId);
    if (found?.kind !== "sale" || found.escrow !== "held") {
      out.lines.push("That sale isn't in escrow anymore.");
      return out;
    }
    const e = found.mapConvergedAt
      ? found
      : await this.store.updateEntry(found.id, { mapConvergedAt: this.now().toISOString() });
    out.events.push({ type: "escrow.map_converged", payload: { entryId: e.id } });
    const released = await this.tryRelease(move, e);
    if (!released) return out;
    out.events.push(...released.events);
    out.outbound.push({
      toHandle: move.ownerHandle,
      text: `The ${e.what} hand-off checked out on the Move Map and ${await this.name(e.paidBy)} confirmed pickup, so ${fmtUsd(e.amountCents)} moved into the Moving Fund.`,
    });
    return out;
  }

  /** Set or move the pickup time (the Deal Engine's one reschedule). Clears any no-show question. */
  async setPickupTime(move: MoneyMove, entryId: string, pickupAt: string): Promise<void> {
    const e = await this.store.getEntry(entryId);
    if (e?.kind !== "sale" || e.escrow !== "held") return;
    if (e.noShowAt) await this.dropPending(move.id, e.id);
    await this.store.updateEntry(e.id, { pickupAt, noShowAt: null });
  }

  /**
   * The 24h no-show rule, for the Deal Engine's periodic sweep. A buyer who hasn't confirmed pickup more than
   * 24h after the pickup time gets a refund staged for the owner's yes, sent with a poll. It asks once per
   * sale, and nothing moves here.
   */
  async sweepNoShows(move: MoneyMove): Promise<OpResult> {
    const out = empty();
    const now = this.now();
    for (const e of await this.store.listEntries(move.id)) {
      if (!isNoShow(e, now)) continue;
      await this.store.updateEntry(e.id, { noShowAt: now.toISOString() });
      await this.dropPending(move.id, e.id);
      const buyer = await this.name(e.paidBy);
      const pending = await this.store.addPending({
        moveId: move.id,
        kind: "refund_escrow",
        summary: `refund ${buyer} ${fmtUsd(e.amountCents)} for the ${e.what} (no-show)`,
        entryIds: [e.id],
      });
      out.events.push(
        { type: "escrow.no_show", payload: { entryId: e.id, pickupAt: e.pickupAt } },
        { type: "approval.requested", payload: { pendingId: pending.id, kind: pending.kind } },
      );
      out.outbound.push({
        toHandle: move.ownerHandle,
        text: `${buyer} didn't pick up the ${e.what}, and it's been over 24 hours. Refund their ${fmtUsd(e.amountCents)} from escrow? Reply yes.`,
        poll: approvalPollFor(pending),
      });
    }
    return out;
  }

  // ---------- owner pays someone ----------

  async proposePay(
    move: MoneyMove,
    input: { person: string; amountCents: number; what: string; flagged: boolean },
  ): Promise<OpResult> {
    const out = empty();
    const owner = await this.owner(move);
    const to = await this.person(move.id, input.person, "roommate");
    const entry = await this.store.addEntry({
      moveId: move.id,
      date: this.today(),
      kind: "payment",
      what: input.what,
      amountCents: input.amountCents,
      paidBy: owner.id,
      paidTo: to.id,
      status: "pending",
      flagged: input.flagged,
    });
    if (input.flagged) return out;
    const pending = await this.store.addPending({
      moveId: move.id,
      kind: "pay_person",
      summary: `pay ${to.name} ${fmtUsd(input.amountCents)} for ${input.what}`,
      entryIds: [entry.id],
    });
    out.events.push({ type: "approval.requested", payload: { pendingId: pending.id, kind: pending.kind } });
    out.lines.push(
      `Pay ${to.name} ${fmtUsd(input.amountCents)}${input.what === "payment" ? "" : ` for the ${input.what}`} ?`,
    );
    out.lines.push("Reply yes to send it.");
    return out;
  }

  async executePay(move: MoneyMove, action: PendingAction): Promise<OpResult> {
    const out = empty();
    const e = await this.store.getEntry(action.entryIds[0] ?? "");
    if (e?.status !== "pending" || e.flagged) {
      out.lines.push("I can't send that one, so nothing moved.");
      return out;
    }
    const owner = await this.owner(move);
    const to = e.paidTo ? await this.store.getPerson(e.paidTo) : undefined;
    if (!to) throw new Error(`payment ${e.id} has no recipient`);
    // Pay from the Moving Fund when it covers the amount, otherwise from the owner's own account.
    const fromFund = (await this.books(move)).fundCents >= e.amountCents;
    await this.movement(
      e,
      fromFund ? await this.fundAccount(move) : await this.account(owner),
      await this.account(to),
      `${fromFund ? "Moving Fund" : owner.name} to ${to.name}: ${e.what}`,
      "payment",
    );
    await this.store.updateEntry(e.id, { status: "paid" });
    out.events.push({
      type: "payment.sent",
      payload: { entryId: e.id, toId: to.id, amountCents: e.amountCents },
    });
    if (to.handle)
      out.outbound.push({
        toHandle: to.handle,
        toName: to.name,
        about: `the ${fmtUsd(e.amountCents)} you sent for ${e.what}`,
        text: `${owner.name} sent you ${fmtUsd(e.amountCents)} for ${e.what} through Elves.`,
      });
    out.lines.push(`Sent ${to.name} ${fmtUsd(e.amountCents)}${fromFund ? " from the Moving Fund" : ""}.`);
    return out;
  }

  // ---------- approvals ----------

  /** The action a yes or no answers: the most recently proposed one. */
  async latestPending(moveId: string): Promise<PendingAction | undefined> {
    const all = await this.store.listPending(moveId);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /** Approve one action: the one a poll vote names, or else the most recently proposed. */
  async approve(move: MoneyMove, actionId?: string, reach: Reach = ANYONE): Promise<OpResult> {
    const action = actionId
      ? (await this.store.listPending(move.id)).find((a) => a.id === actionId)
      : await this.latestPending(move.id);
    if (!action)
      return {
        ...empty(),
        lines: [
          actionId
            ? "That one's already been handled, so nothing moved."
            : "There's nothing waiting for your OK right now.",
        ],
      };
    // Remove first so a retry after a partial failure can never double-run the same approval.
    await this.store.removePending(action.id);
    let r: OpResult;
    try {
      switch (action.kind) {
        case "send_split_requests":
          r = await this.executeSplitRequests(move, action, reach);
          break;
        case "release_escrow":
        case "refund_escrow":
          r = await this.executeEscrow(move, action);
          break;
        case "pay_person":
          r = await this.executePay(move, action);
          break;
        case "create_loan":
          r = await this.executeLoan(move, action);
          break;
      }
    } catch (err) {
      // Put the approval back so the owner can retry; each execute step skips work already done.
      await this.store.addPending({
        moveId: action.moveId,
        kind: action.kind,
        summary: action.summary,
        entryIds: action.entryIds,
        data: action.data,
      });
      throw err;
    }
    r.events.unshift({ type: "approval.granted", payload: { pendingId: action.id, kind: action.kind } });
    const next = await this.latestPending(move.id);
    if (next && r.lines.length < 3) r.lines.push(`Still waiting on your OK to ${next.summary}.`);
    return r;
  }

  async decline(move: MoneyMove, actionId?: string): Promise<OpResult> {
    const action = actionId
      ? (await this.store.listPending(move.id)).find((a) => a.id === actionId)
      : await this.latestPending(move.id);
    if (!action)
      return {
        ...empty(),
        lines: [actionId ? "That one's already been handled." : "OK, nothing is waiting on you."],
      };
    await this.store.removePending(action.id);
    if (action.kind === "pay_person") {
      for (const id of action.entryIds) await this.store.updateEntry(id, { status: "cancelled" });
    }
    return {
      lines: [`OK, I won't ${action.summary}. Nothing moved.`],
      events: [{ type: "approval.cancelled", payload: { pendingId: action.id, kind: action.kind } }],
      outbound: [],
    };
  }

  // ---------- ledger ----------

  /** What "ledger" answers: read live from Nessie. A roommate sees only their own balance. */
  async ledgerSummary(move: MoneyMove, forPerson?: Person): Promise<string[]> {
    const books = await this.books(move);
    if (forPerson) {
      const mine = books.owes.find((o) => o.personId === forPerson.id);
      if (!mine) return ["You're all squared up, nothing owed."];
      const lines: string[] = [];
      if (mine.billCents)
        lines.push(
          `You owe ${fmtUsd(mine.billCents)}: ${mine.bills.map((b) => `${b.nickname} ${fmtUsd(b.amountCents)}`).join(", ")}.`,
        );
      if (mine.loanCents)
        lines.push(
          `${fmtUsd(mine.loanCents)} left on your Moving Fund loan${mine.loanMonthlyCents ? `, ${fmtUsd(mine.loanMonthlyCents)} a month` : ""}.`,
        );
      lines.push("Reply PAID once you've sent it.");
      return lines;
    }
    const entries = await this.store.listEntries(move.id);
    const lines: string[] = [];
    if (books.owes.length)
      lines.push(
        `Owed to you: ${books.owes
          .map((o) => `${o.name} ${fmtUsd(o.billCents + o.loanCents)}${o.loanCents ? " (loan)" : ""}`)
          .join(", ")}.`,
      );
    const money: string[] = [];
    if (books.fundCents) money.push(`Moving Fund ${fmtUsd(books.fundCents)}`);
    if (books.escrowCents) money.push(`escrow ${fmtUsd(books.escrowCents)}`);
    if (books.salesCents) money.push(`sales ${fmtUsd(books.salesCents)}`);
    if (money.length) lines.push(`${money.join(", ")}.`);
    const deps = entries.filter((e) => e.kind === "deposit" && e.status === "pending");
    if (deps.length)
      lines.push(
        `Deposits out: ${deps.map((e) => `${e.what} ${fmtUsd(e.amountCents)}${e.dueBackAt ? ` (due back ${e.dueBackAt})` : ""}`).join(", ")}.`,
      );
    if (!lines.length) return ["The Ledger is empty so far. Tell me about any deposit or shared cost."];
    if (lines.length < 3)
      lines.push(`Live from Nessie: ${books.records} records, ${fmtUsd(owedTotal(books))} outstanding.`);
    return lines.slice(0, 3);
  }
}

/** A no-show is a buyer who hasn't confirmed pickup this long after the pickup time (SPEC §4). */
export const NO_SHOW_MS = 24 * 60 * 60 * 1000;

/** True when a held sale's buyer is past the no-show window and the owner hasn't been asked about it yet. */
export function isNoShow(e: LedgerEntry, now: Date): boolean {
  if (e.kind !== "sale" || e.escrow !== "held" || !e.pickupAt || e.buyerConfirmedAt || e.noShowAt)
    return false;
  return now.getTime() - Date.parse(e.pickupAt) > NO_SHOW_MS;
}

/** The approval poll for one pending action. Option ids carry the action id, so a tap can't hit the wrong one. */
export function approvalPollFor(a: PendingAction): MoneyPoll {
  return {
    question: `${cap(a.summary)}?`,
    options: [
      { id: `money:approve:${a.id}`, text: "Yes" },
      { id: `money:decline:${a.id}`, text: "Not now" },
    ],
    selectionMode: "single",
  };
}

function mergeOps(a: OpResult, b: OpResult): OpResult {
  return {
    lines: [...a.lines, ...b.lines],
    events: [...a.events, ...b.events],
    outbound: [...a.outbound, ...b.outbound],
  };
}

/** Default plan: about four monthly payments, rounded up to whole dollars, at least $5. */
export function defaultMonthly(cents: number): number {
  return Math.min(cents, Math.max(500, Math.ceil(cents / 4 / 100) * 100));
}

function sum(es: LedgerEntry[]) {
  return es.reduce((a, e) => a + e.amountCents, 0);
}
function cap(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
