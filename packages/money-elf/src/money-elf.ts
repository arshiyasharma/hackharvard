/**
 * The Money Elf (spec section 3): every dollar in the move on one Ledger, and no money moves without the
 * owner's OK. Elves never send messages themselves; this returns replies, outbound messages, a board patch
 * and events for the service to apply.
 */
import { fmtUsd } from "./amounts.ts";
import { booksLine } from "./books.ts";
import type { MemoryMoneyStore, MoneyStore } from "./ledger.ts";
import { renderLedgerPng } from "./ledger-card.ts";
import { type LedgerLinks, ledgerUrl } from "./ledger-http.ts";
import { buildLedgerView, ledgerSummaryLine } from "./ledger-view.ts";
import { buyerConfirmsPickup, parseIntent } from "./parse.ts";
import type { MoneyRails } from "./rails.ts";
import { containsFinancialNumber, scamCheck } from "./scam.ts";
import { approvalPollFor, MoneyService, type OpResult } from "./service.ts";
import type { MoneyContext, MoneyImage, MoneyPoll, MoneyResult } from "./types.ts";

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
  "payment plan",
  "loan",
  "installments",
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
  rails: MoneyRails;
  now?: () => Date;
  /** Public URL + signing secret for live Ledger links; without it the Ledger card is sent with no link. */
  links?: LedgerLinks;
}): MoneyElf {
  const service = new MoneyService(deps.store, deps.rails, deps.now);
  return {
    name: "money",
    description: MONEY_DESCRIPTION,
    keywords: MONEY_KEYWORDS,
    service,
    async handle(ctx) {
      try {
        return await handle(service, ctx, deps.links);
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

const POLL_ID = /^money:(approve|decline):([A-Za-z0-9_]+)$/;

/** The approval poll for one pending action. Option ids carry the action id, so a vote can't hit the wrong one. */
export async function approvalPoll(
  service: MoneyService,
  moveId: string,
  pendingId: string,
): Promise<MoneyPoll | undefined> {
  const a = (await service.store.listPending(moveId)).find((x) => x.id === pendingId);
  return a ? approvalPollFor(a) : undefined;
}

function pendingIdsIn(events: { type: string; payload: Record<string, unknown> }[]): string[] {
  return events.filter((e) => e.type === "approval.requested").map((e) => String(e.payload.pendingId));
}

interface Extras {
  images?: MoneyImage[];
  poll?: MoneyPoll;
}

async function handle(service: MoneyService, ctx: MoneyContext, links?: LedgerLinks): Promise<MoneyResult> {
  const text = textOf(ctx);
  const move = ctx.move;
  const role = ctx.participant.role;
  let r: OpResult = { lines: [], events: [], outbound: [] };
  const extras: Extras = {};

  // A tap on an approval poll answers exactly the action it was sent for. Only the owner's taps count.
  const vote = ctx.batch.messages.flatMap((m) => m.pollVote?.selectedOptions ?? []).at(-1);
  if (vote) {
    const m = vote.id.match(POLL_ID);
    if (role !== "owner") {
      r.lines.push("Only the move's owner can approve money moves.");
    } else if (m?.[2]) {
      r = merge(
        r,
        m[1] === "approve" ? await service.approve(move, m[2]) : await service.decline(move, m[2]),
      );
      r.events.push({ type: "poll.voted", payload: { pendingId: m[2], choice: m[1] } });
    } else if (/^yes$/i.test(vote.text) || /^not now$/i.test(vote.text)) {
      // The platform dropped our option ids; fall back to the most recent action.
      r = merge(r, /^yes$/i.test(vote.text) ? await service.approve(move) : await service.decline(move));
    } else {
      r.lines.push("I couldn't tell which approval that was for. Reply yes or no instead.");
    }
    return finish(service, ctx, r, extras);
  }

  // Card and bank numbers are never stored, parsed or echoed.
  if (containsFinancialNumber(text)) {
    r.lines.push("Please don't text card or bank numbers here; I never need them.");
    r.lines.push("Payments run through the Ledger, so nobody has to share account details.");
    r.events.push({ type: "money.sensitive_blocked", payload: { role } });
    return finish(service, ctx, r, extras);
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
      r = merge(
        r,
        await service.markPaid(move, {
          person: me,
          what: intent.what,
          viaLedger: true,
          amountCents: intent.amountCents,
        }),
      );
      const paid = r.events.find((e) => e.type === "payment.received");
      if (paid) {
        const left = Number(paid.payload.leftCents);
        r.outbound.push({
          toHandle: move.ownerHandle,
          text: `${me.name} paid ${fmtUsd(Number(paid.payload.amountCents))} into the Moving Fund${left ? `; ${fmtUsd(left)} left` : ""}.`,
        });
      }
    } else if (role === "roommate" && me && intent.kind === "loan") {
      // The roommate asks; the owner (the lender) decides.
      const ask = await service.proposeLoan(move, {
        person: me,
        what: intent.what,
        monthlyCents: intent.monthlyCents,
      });
      r.events.push(...ask.events);
      if (ask.events.some((e) => e.type === "approval.requested")) {
        const [pid] = pendingIdsIn(ask.events);
        r.outbound.push({
          toHandle: move.ownerHandle,
          text: `${me.name} asked for a payment plan. ${ask.lines.join(" ")}`,
          poll: pid ? await approvalPoll(service, move.id, pid) : undefined,
        });
        r.lines.push("I asked about a payment plan for you; I'll text you as soon as it's set up.");
      } else {
        r.lines.push(...ask.lines);
      }
    } else if (role === "roommate" && me) {
      r.lines.push(...(await service.ledgerSummary(move, me)));
    } else if (role === "buyer" && me && (intent.kind === "pickup_confirmed" || buyerConfirmsPickup(text))) {
      // The buyer's half of the escrow release; the owner is asked (or told) through outbound.
      r = merge(
        r,
        await service.confirmPickup(move, {
          via: "buyer",
          buyer: me,
          item: intent.kind === "pickup_confirmed" ? intent.item : null,
        }),
      );
    } else {
      r.lines.push(
        "Money Elf here. Payments for this move run through escrow on this number, never any other way.",
      );
    }
    return finish(service, ctx, r, extras);
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
    return finish(service, ctx, r, extras);
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
      else
        r = merge(
          r,
          await service.markPaid(move, {
            person: p,
            what: intent.what,
            viaLedger: false,
            amountCents: intent.amountCents,
          }),
        );
      break;
    }
    case "loan": {
      // The owner offers a plan. Without a name, use the only roommate who still owes something.
      const owing = (await service.store.listEntries(move.id)).filter(
        (e) => e.kind === "split" && e.status === "pending" && !e.loanId && e.owedBy,
      );
      const ids = [...new Set(owing.map((e) => e.owedBy as string))];
      const p = intent.person
        ? await service.findPerson(move.id, intent.person)
        : ids.length === 1
          ? await service.store.getPerson(ids[0] as string)
          : undefined;
      if (!p)
        r.lines.push(
          intent.person ? `I don't have ${intent.person} on the Ledger yet.` : "Who's the payment plan for?",
        );
      else
        r = merge(
          r,
          await service.proposeLoan(move, {
            person: p,
            what: intent.what,
            monthlyCents: intent.monthlyCents,
          }),
        );
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
    case "ledger": {
      // The Ledger card (an image, inline in iMessage) plus a signed link to the live page.
      const view = await buildLedgerView(service, move);
      let png: Uint8Array | null = null;
      try {
        png = await renderLedgerPng(view);
      } catch (err) {
        ctx.log.warn("ledger card render failed; sending text", { err: String(err) });
      }
      if (png) {
        r.lines.push("Here's your Ledger, live from Nessie.");
        r.lines.push(ledgerSummaryLine(view));
        extras.images = [
          {
            contentType: "image/png",
            filename: "ledger.png",
            bytes: png,
            alt: `Moving Ledger: ${ledgerSummaryLine(view)}`,
          },
        ];
      } else {
        r.lines.push(...(await service.ledgerSummary(move)).slice(0, 2));
      }
      if (links) r.lines.push(ledgerUrl(links, move.id));
      r.events.push({ type: "ledger.shown", payload: { records: view.records, card: !!png, link: !!links } });
      break;
    }
    default:
      r.lines.push(
        "Money Elf here. I keep every dollar on the Ledger in Nessie: shared costs, the Moving Fund, deposits and escrow.",
      );
      r.lines.push(
        `Tell me something like "split the $240 truck with Sam and Priya" or "I paid a $500 sublet deposit, due back Dec 1".`,
      );
  }
  return finish(service, ctx, r, extras);
}

function merge(a: OpResult, b: OpResult): OpResult {
  return {
    lines: [...a.lines, ...b.lines],
    events: [...a.events, ...b.events],
    outbound: [...a.outbound, ...b.outbound],
  };
}

async function finish(
  service: MoneyService,
  ctx: MoneyContext,
  r: OpResult,
  extras: Extras,
): Promise<MoneyResult> {
  await service.owner(ctx.move);
  const entries = await service.store.listEntries(ctx.move.id);
  const pending = await service.latestPending(ctx.move.id);
  // The board shows the live Ledger, read back from Nessie.
  const books = await service.books(ctx.move);
  // Spec: 2-3 short plain lines per reply.
  const lines = r.lines.filter(Boolean).slice(0, 3);
  // Anything the owner was just asked to approve also gets a tap-to-answer poll.
  const [pid] = ctx.participant.role === "owner" ? pendingIdsIn(r.events) : [];
  const poll = extras.poll ?? (pid ? await approvalPoll(service, ctx.move.id, pid) : undefined);
  return {
    ...(extras.images?.length ? { images: extras.images } : {}),
    ...(poll ? { poll } : {}),
    replies: lines.length ? [{ text: lines.join("\n"), parentMessageId: lastId(ctx) }] : [],
    outbound: r.outbound,
    events: [...r.events, { type: "ledger.totals", payload: { ...books, owes: books.owes.length } }],
    boardPatch: {
      status: pending ? "waiting" : entries.length ? "working" : "idle",
      currentTask: pending
        ? `Waiting for your OK to ${pending.summary}`
        : entries.length
          ? "Keeping the Ledger"
          : "Standing by",
      lastUpdate: booksLine(books),
    },
  };
}
