/**
 * The Money Elf (spec section 3): every dollar in the move on one Ledger, and no money moves without the
 * owner's OK. Elves never send messages themselves; this returns replies, outbound messages, a board patch
 * and events for the service to apply.
 */
import { fmtUsd } from "./amounts.ts";
import { boardLine, ledgerTotals, type MemoryMoneyStore, type MoneyStore } from "./ledger.ts";
import { parseIntent } from "./parse.ts";
import type { PaymentsProvider } from "./payments.ts";
import { containsFinancialNumber, scamCheck } from "./scam.ts";
import { MoneyService, type OpResult } from "./service.ts";
import type { MoneyContext, MoneyResult } from "./types.ts";

export const MONEY_DESCRIPTION =
  "Money: payments, deposits, escrow, Venmo or Zelle requests, splitting costs with roommates, the ledger, scams";

/** Same list as the foundation stub, so routing is unchanged when this replaces it. */
export const MONEY_KEYWORDS = [
  "pay",
  "paid",
  "payment",
  "venmo",
  "zelle",
  "cash app",
  "deposit",
  "escrow",
  "split",
  "owe",
  "refund",
  "ledger",
  "scam",
  "money",
];

export interface MoneyElf {
  readonly name: "money";
  readonly description: string;
  readonly keywords: string[];
  readonly service: MoneyService;
  handle(ctx: MoneyContext): Promise<MoneyResult>;
}

export function createMoneyElf(deps: {
  store: MoneyStore | MemoryMoneyStore;
  payments: PaymentsProvider;
  now?: () => Date;
}): MoneyElf {
  const service = new MoneyService(deps.store, deps.payments, deps.now);
  return {
    name: "money",
    description: MONEY_DESCRIPTION,
    keywords: MONEY_KEYWORDS,
    service,
    async handle(ctx) {
      try {
        return await handle(service, ctx);
      } catch (err) {
        ctx.log.error("money elf failed", { err: String(err), traceId: ctx.traceId });
        return {
          replies: [
            {
              text: "I couldn't reach the payments system just now, so nothing moved. Try me again in a minute.",
              parentMessageId: lastId(ctx),
            },
          ],
          boardPatch: {
            status: "blocked",
            currentTask: "Payments system unreachable",
            lastUpdate: "Nothing moved; waiting to retry",
          },
          events: [{ type: "money.error", payload: { error: String(err) } }],
        };
      }
    },
  };
}

function lastId(ctx: MoneyContext): string | null {
  return ctx.batch.messages[ctx.batch.messages.length - 1]?.id ?? null;
}

function textOf(ctx: MoneyContext): string {
  return ctx.batch.messages
    .map((m) => m.text ?? "")
    .filter(Boolean)
    .join("\n");
}

async function handle(service: MoneyService, ctx: MoneyContext): Promise<MoneyResult> {
  const text = textOf(ctx);
  const move = ctx.move;
  const role = ctx.participant.role;
  let r: OpResult = { lines: [], events: [], outbound: [] };

  // Card and bank numbers are never stored, parsed or echoed.
  if (containsFinancialNumber(text)) {
    r.lines.push("Please don't text card or bank numbers here; I never need them.");
    r.lines.push("Payments run through the Ledger, so nobody has to share account details.");
    r.events.push({ type: "money.sensitive_blocked", payload: { role } });
    return finish(service, ctx, r);
  }

  const flags = scamCheck(text);
  for (const f of flags) r.events.push({ type: "scam.flagged", payload: { reason: f.reason, role } });

  const roster = (await service.roommates(move.id)).map((p) => p.name);
  const intent = await parseIntent(text, {
    llm: ctx.llm,
    now: ctx.now(),
    roommates: roster,
    context: roster.join(", "),
  });
  ctx.log.debug("money intent", { kind: intent.kind, traceId: ctx.traceId });

  if (role !== "owner") {
    const me = await service.findPerson(move.id, ctx.participant.handle);
    if (flags.length) {
      r.lines.push(`Heads up: ${flags[0]?.warning}`);
      r.lines.push("Payments for this move only go through Elves on this number.");
    } else if (role === "roommate" && me && intent.kind === "mark_paid") {
      r = merge(r, await service.markPaid(move, { person: me, what: intent.what, viaLedger: true }));
      const paid = r.events.find((e) => e.type === "payment.received");
      if (paid)
        r.outbound.push({
          toHandle: move.ownerHandle,
          text: `${me.name} paid ${fmtUsd(Number(paid.payload.amountCents))} toward the move.`,
        });
    } else if (role === "roommate" && me) {
      r.lines.push(...(await service.ledgerSummary(move, me)));
    } else {
      r.lines.push(
        "Money Elf here. Payments for this move run through escrow on this number, never any other way.",
      );
    }
    return finish(service, ctx, r);
  }

  // A flagged message is never paid: warn, and if it asked to pay, record it as blocked.
  if (
    flags.length &&
    (intent.kind === "pay_person" ||
      intent.kind === "scam_check" ||
      intent.kind === "deposit_paid" ||
      intent.kind === "other")
  ) {
    if (intent.kind === "pay_person") await service.proposePay(move, { ...intent, flagged: true });
    r.lines.push(`That looks like a scam: ${flags[0]?.warning}`);
    r.lines.push(
      intent.kind === "deposit_paid"
        ? "If you already paid it, tell me and I'll help you dispute it."
        : "I won't pay it. Want me to tell the Crew Lead to block them?",
    );
    return finish(service, ctx, r);
  }

  switch (intent.kind) {
    case "approve":
      r = merge(r, await service.approve(move));
      break;
    case "decline":
      r = merge(r, await service.decline(move));
      break;
    case "split":
      r = merge(r, await service.proposeSplit(move, intent));
      break;
    case "deposit_paid":
      r = merge(r, await service.recordDeposit(move, intent));
      break;
    case "deposit_returned":
      r = merge(r, await service.depositReturned(move, intent.what));
      break;
    case "mark_paid": {
      const p = intent.person ? await service.findPerson(move.id, intent.person) : undefined;
      if (!p) r.lines.push(intent.person ? `I don't have ${intent.person} on the Ledger yet.` : "Who paid?");
      else r = merge(r, await service.markPaid(move, { person: p, what: intent.what, viaLedger: false }));
      break;
    }
    case "pay_person":
      r = merge(r, await service.proposePay(move, { ...intent, flagged: false }));
      break;
    case "pickup_confirmed":
      r = merge(r, await service.proposeEscrow(move, "release_escrow", intent.item));
      break;
    case "pickup_failed":
      r = merge(r, await service.proposeEscrow(move, "refund_escrow", intent.item));
      break;
    case "add_contact":
      r = merge(r, await service.addContact(move, intent.name, intent.handle));
      break;
    case "scam_check":
      r.lines.push("Nothing in that looks like a known scam pattern.");
      r.lines.push("Still, only pay through the Ledger, and never before you've seen the item or the place.");
      break;
    case "ledger":
      r.lines.push(...(await service.ledgerSummary(move)));
      break;
    default:
      r.lines.push(
        "Money Elf here. I track every dollar on the Ledger: deposits, shared costs and sales in escrow.",
      );
      r.lines.push(
        `Tell me something like "split the $240 truck with Sam and Priya" or "I paid a $500 sublet deposit, due back Dec 1".`,
      );
  }
  return finish(service, ctx, r);
}

function merge(a: OpResult, b: OpResult): OpResult {
  return {
    lines: [...a.lines, ...b.lines],
    events: [...a.events, ...b.events],
    outbound: [...a.outbound, ...b.outbound],
  };
}

async function finish(service: MoneyService, ctx: MoneyContext, r: OpResult): Promise<MoneyResult> {
  const owner = await service.owner(ctx.move);
  const entries = await service.store.listEntries(ctx.move.id);
  const pending = await service.latestPending(ctx.move.id);
  const totals = ledgerTotals(entries, owner.id);
  // Spec: 2-3 short plain lines per reply.
  const lines = r.lines.filter(Boolean).slice(0, 3);
  return {
    replies: lines.length ? [{ text: lines.join("\n"), parentMessageId: lastId(ctx) }] : [],
    outbound: r.outbound,
    events: [...r.events, { type: "ledger.totals", payload: { ...totals } }],
    boardPatch: {
      status: pending ? "waiting" : entries.length ? "working" : "idle",
      currentTask: pending
        ? `Waiting for your OK to ${pending.summary}`
        : entries.length
          ? "Keeping the Ledger"
          : "Standing by",
      lastUpdate: boardLine(totals),
    },
  };
}
