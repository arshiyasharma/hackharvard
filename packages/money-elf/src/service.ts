/**
 * Money operations: every dollar in a move goes through here and lands on the Ledger.
 *
 * Guardrail: methods that move money or request it (`execute*`) are only called after the owner's explicit
 * yes for that one pending action. `propose*` methods only stage a PendingAction. Recording something the
 * owner already paid elsewhere moves nothing, so it needs no approval.
 */
import { fmtUsd, splitCents } from "./amounts.ts";
import type { LedgerEntry, MoneyStore, PendingAction, Person } from "./ledger.ts";
import type { Share } from "./parse.ts";
import type { PaymentsProvider } from "./payments.ts";
import type { MoneyEvent, MoneyMove, OutboundMessage, Role } from "./types.ts";

export interface OpResult {
  lines: string[];
  events: MoneyEvent[];
  outbound: OutboundMessage[];
}

const empty = (): OpResult => ({ lines: [], events: [], outbound: [] });

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class MoneyService {
  constructor(
    readonly store: MoneyStore,
    readonly payments: PaymentsProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  today(): string {
    return this.now().toISOString().slice(0, 10);
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
    const acct = await this.payments.openAccount({
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

  async escrowAccount(moveId: string): Promise<string> {
    const existing = await this.store.getEscrowAccount(moveId);
    if (existing) return existing;
    const acct = await this.payments.openAccount({
      firstName: "Elves",
      lastName: "Escrow",
      nickname: `Escrow ${moveId}`,
    });
    await this.store.setEscrowAccount(moveId, acct.accountId);
    return acct.accountId;
  }

  private async movement(
    entry: LedgerEntry,
    from: string | null,
    to: string | null,
    description: string,
  ): Promise<LedgerEntry> {
    const r = await this.payments.moveMoney({
      fromAccountId: from,
      toAccountId: to,
      amountCents: entry.amountCents,
      description,
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

  private async name(id: string | null): Promise<string> {
    if (!id) return "someone";
    return (await this.store.getPerson(id))?.name ?? "someone";
  }

  // ---------- contacts ----------

  /** Save a roommate's number and text them any approved requests that were waiting for it. */
  async addContact(move: MoneyMove, name: string, handle: string): Promise<OpResult> {
    const out = empty();
    const p = await this.person(move.id, name, "roommate", handle);
    out.lines.push(`Got it, ${p.name} is ${handle}.`);
    const waiting = (await this.store.listEntries(move.id)).filter(
      (e) => e.kind === "split" && e.owedBy === p.id && e.requested && !e.notified && e.status === "pending",
    );
    for (const e of waiting) {
      out.outbound.push({ toHandle: handle, text: await this.requestText(move, p, e) });
      await this.store.updateEntry(e.id, { notified: true });
    }
    if (waiting.length) out.lines.push(`I just texted ${p.name} the request for ${fmtUsd(sum(waiting))}.`);
    return out;
  }

  private async requestText(move: MoneyMove, p: Person, e: LedgerEntry): Promise<string> {
    const owner = await this.owner(move);
    return `Hi ${p.name}, it's Elves, ${owner.name === "Owner" ? "your roommate's" : `${owner.name}'s`} moving crew. Your share of the ${e.what} is ${fmtUsd(e.amountCents)}. Reply PAID here once you've sent it.`;
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

  async executeSplitRequests(move: MoneyMove, action: PendingAction): Promise<OpResult> {
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
      const bill = await this.payments.createBill({
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
        out.outbound.push({ toHandle: p.handle, text: await this.requestText(move, p, e) });
        await this.store.updateEntry(e.id, { notified: true });
        sent++;
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

  /** The person paid what they owed. Through us (they replied PAID): recorded as a Nessie movement. */
  async markPaid(
    move: MoneyMove,
    input: { person: Person; what: string | null; viaLedger: boolean },
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
    let entry = e;
    if (input.viaLedger) {
      const owner = await this.owner(move);
      entry = await this.movement(
        e,
        await this.account(input.person),
        await this.account(owner),
        `${input.person.name}: ${e.what} share`,
      );
    }
    if (entry.nessie.billId) await this.payments.setBillStatus(entry.nessie.billId, "completed");
    await this.store.updateEntry(e.id, { status: "paid", paidBy: input.person.id });
    out.events.push({
      type: "payment.received",
      payload: {
        entryId: e.id,
        personId: input.person.id,
        amountCents: e.amountCents,
        via: input.viaLedger ? "ledger" : "off_ledger",
      },
    });
    const left = open.length - 1;
    out.lines.push(
      `${input.person.name} paid ${fmtUsd(e.amountCents)} for the ${e.what}.${left ? ` ${left} more open for them.` : ""}`,
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
    e = await this.movement(e, await this.account(owner), null, `Deposit: ${input.what}`);
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
    await this.movement(e, null, await this.account(owner), `Deposit returned: ${e.what}`);
    await this.store.updateEntry(e.id, { status: "refunded", paidTo: owner.id });
    out.events.push({ type: "deposit.returned", payload: { entryId: e.id, amountCents: e.amountCents } });
    out.lines.push(`Nice, the ${fmtUsd(e.amountCents)} ${e.what} deposit is back. Marked it on the Ledger.`);
    return out;
  }

  // ---------- escrow for sales ----------

  /**
   * Hand-off from the Stuff Elf: the buyer paid for an item. The buyer's own action, so no owner approval;
   * the money sits in escrow until the owner confirms pickup.
   */
  async openEscrow(
    move: MoneyMove,
    input: { item: string; buyerName: string; buyerHandle: string | null; amountCents: number },
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
    });
    entry = await this.movement(
      entry,
      await this.account(buyer),
      await this.escrowAccount(move.id),
      `Escrow: ${input.item}`,
    );
    out.events.push({
      type: "escrow.opened",
      payload: { entryId: entry.id, buyerId: buyer.id, amountCents: entry.amountCents, item: input.item },
    });
    out.outbound.push({
      toHandle: move.ownerHandle,
      text: `${buyer.name} paid ${fmtUsd(entry.amountCents)} for the ${input.item}; it's held in escrow until you confirm pickup.`,
    });
    return { ...out, entry };
  }

  private async heldSale(moveId: string, item: string | null): Promise<LedgerEntry[]> {
    const held = (await this.store.listEntries(moveId)).filter(
      (e) => e.kind === "sale" && e.escrow === "held",
    );
    return item ? held.filter((e) => e.what.toLowerCase().includes(item.toLowerCase())) : held;
  }

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
    const summary =
      kind === "release_escrow"
        ? `release ${fmtUsd(e.amountCents)} from escrow for the ${e.what}`
        : `refund ${buyer} ${fmtUsd(e.amountCents)} for the ${e.what}`;
    const pending = await this.store.addPending({ moveId: move.id, kind, summary, entryIds: [e.id] });
    out.events.push({ type: "approval.requested", payload: { pendingId: pending.id, kind } });
    if (kind === "release_escrow") {
      out.lines.push(`${buyer} picked up the ${e.what}. ${fmtUsd(e.amountCents)} is in escrow.`);
      out.lines.push("Release it to you? Reply yes.");
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
    const escrow = await this.escrowAccount(move.id);
    if (action.kind === "release_escrow") {
      const owner = await this.owner(move);
      await this.movement(e, escrow, await this.account(owner), `Release: ${e.what}`);
      await this.store.updateEntry(e.id, { escrow: "released", status: "paid", paidTo: owner.id });
      out.events.push({ type: "escrow.released", payload: { entryId: e.id, amountCents: e.amountCents } });
      out.lines.push(`Released ${fmtUsd(e.amountCents)} for the ${e.what} to you.`);
    } else {
      const buyer = e.paidBy ? await this.store.getPerson(e.paidBy) : undefined;
      if (!buyer) throw new Error(`sale ${e.id} has no buyer`);
      await this.movement(e, escrow, await this.account(buyer), `Refund: ${e.what}`);
      await this.store.updateEntry(e.id, { escrow: "refunded", status: "refunded", paidTo: buyer.id });
      out.events.push({ type: "escrow.refunded", payload: { entryId: e.id, amountCents: e.amountCents } });
      if (buyer.handle)
        out.outbound.push({
          toHandle: buyer.handle,
          text: `Your ${fmtUsd(e.amountCents)} for the ${e.what} has been refunded.`,
        });
      out.lines.push(
        `Refunded ${buyer.name} ${fmtUsd(e.amountCents)}. I'll tell the Stuff Elf the ${e.what} is available again.`,
      );
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
      `Pay ${to.name} ${fmtUsd(input.amountCents)}${input.what === "payment" ? "" : ` for the ${input.what}`} from your Moving Fund?`,
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
    await this.movement(
      e,
      await this.account(owner),
      await this.account(to),
      `${owner.name} to ${to.name}: ${e.what}`,
    );
    await this.store.updateEntry(e.id, { status: "paid" });
    out.events.push({
      type: "payment.sent",
      payload: { entryId: e.id, toId: to.id, amountCents: e.amountCents },
    });
    if (to.handle)
      out.outbound.push({
        toHandle: to.handle,
        text: `${owner.name} sent you ${fmtUsd(e.amountCents)} for ${e.what} through Elves.`,
      });
    out.lines.push(`Sent ${to.name} ${fmtUsd(e.amountCents)}.`);
    return out;
  }

  // ---------- approvals ----------

  /** The action a yes or no answers: the most recently proposed one. */
  async latestPending(moveId: string): Promise<PendingAction | undefined> {
    const all = await this.store.listPending(moveId);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  async approve(move: MoneyMove): Promise<OpResult> {
    const action = await this.latestPending(move.id);
    if (!action) return { ...empty(), lines: ["There's nothing waiting for your OK right now."] };
    // Remove first so a retry after a partial failure can never double-run the same approval.
    await this.store.removePending(action.id);
    let r: OpResult;
    try {
      switch (action.kind) {
        case "send_split_requests":
          r = await this.executeSplitRequests(move, action);
          break;
        case "release_escrow":
        case "refund_escrow":
          r = await this.executeEscrow(move, action);
          break;
        case "pay_person":
          r = await this.executePay(move, action);
          break;
      }
    } catch (err) {
      // Put the approval back so the owner can retry; each execute step skips work already done.
      await this.store.addPending({
        moveId: action.moveId,
        kind: action.kind,
        summary: action.summary,
        entryIds: action.entryIds,
      });
      throw err;
    }
    r.events.unshift({ type: "approval.granted", payload: { pendingId: action.id, kind: action.kind } });
    const next = await this.latestPending(move.id);
    if (next && r.lines.length < 3) r.lines.push(`Still waiting on your OK to ${next.summary}.`);
    return r;
  }

  async decline(move: MoneyMove): Promise<OpResult> {
    const action = await this.latestPending(move.id);
    if (!action) return { ...empty(), lines: ["OK, nothing is waiting on you."] };
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

  async ledgerSummary(move: MoneyMove, forPerson?: Person): Promise<string[]> {
    const entries = await this.store.listEntries(move.id);
    if (forPerson) {
      const owed = entries.filter(
        (e) => e.kind === "split" && e.owedBy === forPerson.id && e.status === "pending",
      );
      return owed.length
        ? [
            `You owe ${fmtUsd(sum(owed))}: ${owed.map((e) => `${e.what} ${fmtUsd(e.amountCents)}`).join(", ")}.`,
            "Reply PAID once you've sent it.",
          ]
        : ["You're all squared up, nothing owed."];
    }
    const lines: string[] = [];
    const owing = new Map<string, number>();
    for (const e of entries)
      if (e.kind === "split" && e.status === "pending" && e.owedBy)
        owing.set(e.owedBy, (owing.get(e.owedBy) ?? 0) + e.amountCents);
    if (owing.size) {
      const parts: string[] = [];
      for (const [id, cents] of owing) parts.push(`${await this.name(id)} ${fmtUsd(cents)}`);
      lines.push(`Owed to you: ${parts.join(", ")}.`);
    }
    const held = entries.filter((e) => e.kind === "sale" && e.escrow === "held");
    if (held.length)
      lines.push(`In escrow: ${held.map((e) => `${e.what} ${fmtUsd(e.amountCents)}`).join(", ")}.`);
    const deps = entries.filter((e) => e.kind === "deposit" && e.status === "pending");
    if (deps.length)
      lines.push(
        `Deposits out: ${deps.map((e) => `${e.what} ${fmtUsd(e.amountCents)}${e.dueBackAt ? ` (due back ${e.dueBackAt})` : ""}`).join(", ")}.`,
      );
    return lines.length
      ? lines.slice(0, 3)
      : ["The Ledger is empty so far. Tell me about any deposit or shared cost."];
  }
}

function sum(es: LedgerEntry[]) {
  return es.reduce((a, e) => a + e.amountCents, 0);
}
function cap(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
