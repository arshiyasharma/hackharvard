/**
 * The Money Elf (spec section 3): every dollar in the move on one Ledger, and no money moves without the
 * owner's OK. Elves never send messages themselves; this returns replies, outbound messages, a board patch
 * and events for the service to apply.
 */
import { fmtUsd } from "./amounts.ts";
import { booksLine } from "./books.ts";
import { formatLines, formatOutbound } from "./format.ts";
import type { MemoryMoneyStore, MoneyStore } from "./ledger.ts";
import { renderLedgerPng } from "./ledger-card.ts";
import { type LedgerLinks, ledgerUrl } from "./ledger-http.ts";
import { buildLedgerView, ledgerSummaryLine } from "./ledger-view.ts";
import { cantLines, clarifyLines, focusLine, menuLines, otherLines } from "./menu.ts";
import { buyerConfirmsPickup, parseIntent } from "./parse.ts";
import type { MoneyRails } from "./rails.ts";
import { containsFinancialNumber, scamCheck } from "./scam.ts";
import { approvalPollFor, MoneyService, type OpResult, type Reach } from "./service.ts";
import type {
  MoneyContext,
  MoneyEvent,
  MoneyImage,
  MoneyOutbound,
  MoneyPoll,
  MoneyResult,
  OutboundMessage,
} from "./types.ts";

export const MONEY_DESCRIPTION =
  'Money: splitting a shared cost with roommates, who owes what, payment plans, paying a roommate back from the Moving Fund, deposits the owner paid and when they come back, escrow for sales and sublet payments (open, release, refund), the dashboard and ledger ("how much have I spent", "who owes me", "how much did I make"), money scams. Not about listing, pricing or donating an item (that is stuff), not about finding or subletting a place (that is home); nobody pays rent, bills or a landlord, moves money to a bank, invests or does taxes';

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
  "chip in",
  "owe",
  "owes",
  "who owes",
  "owe me",
  "hasn't paid",
  "haven't paid",
  "unpaid",
  "refund",
  "ledger",
  "dashboard",
  "my money",
  "moving fund",
  "balance",
  "spent",
  "spend",
  "expenses",
  "my share",
  "how much did",
  "how much have",
  "bring in",
  "scam",
  "money",
  "payment plan",
  "pay back",
  "mistake",
  "undo",
  "was actually",
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
  /** Public URL + signing secret for the live dashboard link; without it the Ledger photo goes with no link. */
  links?: LedgerLinks;
  /**
   * Also send the dashboard as an iMessage mini app card through Spectrum (Photon 1.0). Shelved: off by default,
   * and the dashboard link rides on every Ledger change instead (decision #72).
   */
  cards?: boolean;
}): MoneyElf {
  const service = new MoneyService(deps.store, deps.rails, deps.now);
  return {
    name: "money",
    description: MONEY_DESCRIPTION,
    keywords: MONEY_KEYWORDS,
    service,
    async handle(ctx) {
      try {
        return await handle(service, ctx, deps.links, deps.cards === true);
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

/**
 * Events that change what the Moving Ledger dashboard shows. After one, the owner's reply (or the note they get
 * when someone else's turn caused it) ends with the dashboard link; with the shelved mini app on, the crew service
 * also refreshes the owner's card in place. The page re-reads Nessie every 5 seconds.
 */
export const LEDGER_CHANGING_EVENTS: ReadonlySet<string> = new Set([
  "ledger.entry_added",
  "payment.requested",
  "payment.received",
  "payment.sent",
  "deposit.recorded",
  "deposit.returned",
  "escrow.opened",
  "escrow.released",
  "escrow.refunded",
  "escrow.no_show",
  "loan.created",
]);

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
  miniApp?: { url: string };
}

async function handle(
  service: MoneyService,
  ctx: MoneyContext,
  links?: LedgerLinks,
  cards = false,
): Promise<MoneyResult> {
  const text = textOf(ctx);
  const move = ctx.move;
  const role = ctx.participant.role;
  let r: OpResult = { lines: [], events: [], outbound: [] };
  const extras: Extras = {};
  const spaceOf = await spaces(ctx);
  const reach: Reach = (h) => spaceOf(h) !== undefined;
  const finish = (res: OpResult, ex: Extras) => finishTurn(service, ctx, res, ex, spaceOf, links, cards);

  // A tap on an approval poll answers exactly the action it was sent for. Only the owner's taps count.
  const vote = ctx.batch.messages.flatMap((m) => m.pollVote?.selectedOptions ?? []).at(-1);
  if (vote) {
    const m = vote.id.match(POLL_ID);
    if (role !== "owner") {
      r.lines.push("Only the move's owner can approve money moves.");
    } else if (m?.[2]) {
      r = merge(
        r,
        m[1] === "approve" ? await service.approve(move, m[2], reach) : await service.decline(move, m[2]),
      );
      r.events.push({ type: "poll.voted", payload: { pendingId: m[2], choice: m[1] } });
    } else if (/^yes$/i.test(vote.text) || /^not now$/i.test(vote.text)) {
      // The platform dropped our option ids; fall back to the most recent action.
      r = merge(
        r,
        /^yes$/i.test(vote.text)
          ? await service.approve(move, undefined, reach)
          : await service.decline(move),
      );
    } else {
      r.lines.push("I couldn't tell which approval that was for. Reply yes or no instead.");
    }
    return finish(r, extras);
  }

  // Card and bank numbers are never stored, parsed or echoed.
  if (containsFinancialNumber(text)) {
    r.lines.push("Please don't text card or bank numbers here; I never need them.");
    r.lines.push("Payments run through the Ledger, so nobody has to share account details.");
    r.events.push({ type: "money.sensitive_blocked", payload: { role } });
    return finish(r, extras);
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
      r.lines.push("Payments for this move run through escrow on this number, never any other way.");
    }
    return finish(r, extras);
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
    return finish(r, extras);
  }

  switch (intent.kind) {
    case "approve":
      r = merge(r, await service.approve(move, undefined, reach));
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
      if (!p) {
        if (intent.person) {
          r.lines.push(`I don't have ${intent.person} on the Ledger yet.`);
          r.lines.push(
            `Add their number ("${intent.person} is 617-555-0101") or log what they owe ("split the $90 cleaning with ${intent.person}"), then tell me they paid.`,
          );
        } else r.lines.push("Who paid, and how much?");
      } else
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
    case "pay_person": {
      r = merge(r, await service.proposePay(move, { ...intent, flagged: false }));
      // "venmo Sam $40": the Elf pays through the Ledger (Nessie), not Venmo, and says so.
      if (/\b(venmo|zelle|cash ?app|paypal)\b/i.test(text) && r.lines.length)
        r.lines.splice(1, 0, "I pay through the Ledger in Nessie, not Venmo.");
      break;
    }
    case "help":
      r.lines.push(...menuLines());
      r.events.push({ type: "money.help", payload: {} });
      break;
    case "cant":
      r.lines.push(...cantLines(intent.what));
      r.events.push({ type: "money.out_of_scope", payload: { what: intent.what } });
      break;
    case "clarify":
      r.lines.push(...clarifyLines(intent));
      r.events.push({ type: "money.clarify", payload: { topic: intent.topic } });
      break;
    case "pickup_confirmed":
      r = merge(r, await service.proposeEscrow(move, "release_escrow", intent.item));
      break;
    case "pickup_failed":
      r = merge(r, await service.proposeEscrow(move, "refund_escrow", intent.item));
      break;
    case "add_contact":
      r = merge(r, await service.addContact(move, intent.name, intent.handle, reach));
      break;
    case "fix":
      // Past entries aren't editable (the dashboard replaced the editor, decision #60). Say so, and show
      // exactly what's recorded so the owner can tell what to log next.
      r.lines.push("I can't change a past Ledger entry by text yet.");
      r.lines.push(
        links
          ? `Your dashboard shows exactly what's recorded in Nessie: ${ledgerUrl(links, move.id)}`
          : "Say \"dashboard\" and I'll show you exactly what's recorded in Nessie.",
      );
      r.events.push({ type: "ledger.fix_declined", payload: { link: !!links } });
      break;
    case "scam_check":
      r.lines.push("Nothing in that looks like a known scam pattern.");
      r.lines.push("Still, only pay through the Ledger, and never before you've seen the item or the place.");
      break;
    case "ledger": {
      // The Ledger card (an image, inline in iMessage) plus a signed link to the live page.
      const view = await buildLedgerView(service, move);
      // A specific question ("who owes me?", "is anything in escrow?") gets its answer first.
      if (intent.focus) r.lines.push(focusLine(view, intent.focus));
      let png: Uint8Array | null = null;
      try {
        png = await renderLedgerPng(view);
      } catch (err) {
        ctx.log.warn("ledger card render failed; sending text", { err: String(err) });
      }
      if (png) {
        // With the dashboard link on, the summary shares a line so the intro fits in three lines.
        if (links) r.lines.push(`Your money, live from Nessie: ${lowerFirst(ledgerSummaryLine(view))}`);
        else {
          r.lines.push("Here's your money, live from Nessie.");
          r.lines.push(ledgerSummaryLine(view));
        }
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
      // The dashboard link closes the reply (finishTurn). Only with cards on is it also a Spectrum mini app card.
      if (links && cards) {
        r.lines.push(`Tap the Elves Ledger card to open your dashboard, or use ${ledgerUrl(links, move.id)}`);
        extras.miniApp = { url: ledgerUrl(links, move.id) };
      }
      r.events.push({ type: "ledger.shown", payload: { records: view.records, card: !!png, link: !!links } });
      break;
    }
    default:
      r.lines.push(...otherLines());
      r.events.push({ type: "money.unclear", payload: {} });
  }
  return finish(r, extras);
}

/**
 * Which chat each handle texts from: the owner's is the move's owner space, anyone else's the space they text
 * from. Without a crew store (tests, local chat, smoke test), every handle is reachable and stands in for its
 * own space.
 */
async function spaces(ctx: MoneyContext): Promise<(handle: string) => string | undefined> {
  const store = ctx.store;
  if (!store) return (h) => h;
  const people = await store.listParticipants(ctx.move.id);
  return (h) =>
    (h === ctx.move.ownerHandle ? ctx.move.ownerSpaceId : undefined) ??
    people.find((p) => p.handle === h)?.spaceId;
}

/**
 * One short line telling the owner who to talk to and about what, for texts Elves couldn't send (the person
 * hasn't texted Elves yet). Null when there are none.
 */
export function talkLine(missed: OutboundMessage[]): string | null {
  const people = new Map<string, { name: string; about: string[] }>();
  for (const o of missed) {
    const p = people.get(o.toHandle) ?? { name: o.toName ?? o.toHandle, about: [] };
    const about = o.about ?? "what I tried to text them";
    if (!p.about.includes(about)) p.about.push(about);
    people.set(o.toHandle, p);
  }
  if (!people.size) return null;
  const parts = [...people.values()].map((p) => `${p.name} about ${andList(p.about)}`);
  return `Talk to ${andList(parts)}; I can't text them until they've texted Elves.`;
}

function andList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

function merge(a: OpResult, b: OpResult): OpResult {
  return {
    lines: [...a.lines, ...b.lines],
    events: [...a.events, ...b.events],
    outbound: [...a.outbound, ...b.outbound],
  };
}

async function finishTurn(
  service: MoneyService,
  ctx: MoneyContext,
  r: OpResult,
  extras: Extras,
  spaceOf: (handle: string) => string | undefined,
  links?: LedgerLinks,
  cards = false,
): Promise<MoneyResult> {
  await service.owner(ctx.move);
  const entries = await service.store.listEntries(ctx.move.id);
  const pending = await service.latestPending(ctx.move.id);
  // The board shows the live Ledger, read back from Nessie.
  const books = await service.books(ctx.move);
  // Texts Elves can't deliver become one line telling the owner who to talk to; the Ledger already has the rest.
  const outbound: MoneyOutbound[] = [];
  const missed: OutboundMessage[] = [];
  // The dashboard link rides on whatever changed the Ledger: the owner's own reply, or the note the owner gets
  // when someone else's turn changed it (a roommate paid). Never on a text to anyone else.
  const changed = r.events.some((e) => LEDGER_CHANGING_EVENTS.has(e.type));
  const dashboard = links ? ledgerUrl(links, ctx.move.id) : null;
  const linkForOwner = !cards && changed ? dashboard : null;
  for (const o of r.outbound) {
    const spaceId = spaceOf(o.toHandle);
    const text = formatOutbound(o.text, {
      link: o.toHandle === ctx.move.ownerHandle && ctx.participant.role !== "owner" ? linkForOwner : null,
    });
    if (spaceId) outbound.push({ ...o, text, spaceId });
    else missed.push(o);
  }
  const unreachable: MoneyEvent[] = missed.map((o) => ({
    type: "outbound.unreachable",
    payload: { toHandle: o.toHandle },
  }));
  // Only the owner can pass a message on; in anyone else's turn, missed texts were for the owner anyway.
  const talk = ctx.participant.role === "owner" ? talkLine(missed) : null;
  // Spec: 2-3 short plain lines per reply. The talk line always makes it in.
  const lines = [...r.lines.filter(Boolean).slice(0, talk ? 2 : 3), ...(talk ? [talk] : [])];
  // Anything the owner was just asked to approve also gets a tap-to-answer poll.
  const [pid] = ctx.participant.role === "owner" ? pendingIdsIn(r.events) : [];
  const poll = extras.poll ?? (pid ? await approvalPoll(service, ctx.move.id, pid) : undefined);
  // When the owner's own turn changes the Ledger, the dashboard card comes along (or updates in place), so they
  // never have to ask for it. A roommate's turn refreshes the owner's card in the crew service instead.
  const miniApp =
    extras.miniApp ??
    (cards && links && ctx.participant.role === "owner" && changed
      ? { url: ledgerUrl(links, ctx.move.id) }
      : undefined);
  // Asked for the dashboard, or the owner's own turn changed the Ledger: the web page link closes the reply.
  const asked = r.events.some((e) => e.type === "ledger.shown");
  const link =
    !cards && dashboard && ctx.participant.role === "owner" && (asked || changed) ? dashboard : null;
  return {
    ...(extras.images?.length ? { images: extras.images } : {}),
    ...(poll ? { poll } : {}),
    ...(miniApp ? { miniApp } : {}),
    replies: lines.length
      ? [{ text: formatLines(lines, { events: r.events, link }), parentMessageId: lastId(ctx) }]
      : [],
    outbound,
    events: [
      ...r.events,
      ...unreachable,
      { type: "ledger.totals", payload: { ...books, owes: books.owes.length } },
    ],
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

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
