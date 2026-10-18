/** What the sender wants from the Money Elf. Rules first for yes/no, then the LLM, then rules as the backup. */
import { z } from "zod";
import { amountAppearsIn, normalizePhone, parseAmounts, parseDate } from "./amounts.ts";
import type { MoneyLLM } from "./types.ts";

/** "me" stands for the owner. */
export interface Share {
  name: string;
  weight: number;
}

export type Intent =
  | { kind: "approve" }
  | { kind: "decline" }
  | { kind: "split"; amountCents: number; what: string; shares: Share[] }
  | { kind: "deposit_paid"; amountCents: number; what: string; dueBackAt: string | null }
  | { kind: "deposit_returned"; what: string | null }
  | { kind: "mark_paid"; person: string | null; what: string | null; amountCents: number | null }
  /** A payment plan for someone's share: asked by the roommate, or offered by the owner (person named). */
  | { kind: "loan"; person: string | null; what: string | null; monthlyCents: number | null }
  | { kind: "pay_person"; person: string; amountCents: number; what: string }
  | { kind: "pickup_confirmed"; item: string | null }
  | { kind: "pickup_failed"; item: string | null }
  | { kind: "add_contact"; name: string; handle: string }
  | { kind: "ledger" }
  | { kind: "scam_check" }
  /** Move Plans (decision #66). budgetCents null: reuse the last budget, or ask for one. */
  | { kind: "plan_draft"; budgetCents: number | null }
  | { kind: "plan_choose"; label: "A" | "B" | "C" }
  | { kind: "plan_status" }
  | { kind: "plan_cancel" }
  /** The owner wants to correct or undo something already on the Ledger ("the truck was actually $260"). */
  | { kind: "fix" }
  | { kind: "other" };

/**
 * Move Plans texts, matched by rules only (never the LLM), before yes/no. "Payment plan" is the loan intent
 * and never a move plan.
 */
export function parsePlanIntent(text: string, amounts: number[]): Intent | null {
  const t = text.trim();
  if (/\b(payment|pay(ment)?s?)\s+plan\b|\binstallments?\b/i.test(t)) return null;
  const choose =
    t.match(/\b(?:go with|pick|choose|switch(?: me)? to|take|let'?s do|do|use)\s+plan\s+([abc])\b/i) ??
    t.match(/\b(?:go with|pick|choose|switch(?: me)? to|take)\s+([abc])\s*[.!]?\s*$/i) ??
    t.match(/^\s*(?:plan\s+)?([abc])\s*[.!]?\s*$/i);
  if (choose?.[1]) return { kind: "plan_choose", label: choose[1].toUpperCase() as "A" | "B" | "C" };
  if (/\b(drop|cancel|stop|forget|scrap|ditch)\s+(the|my|this)\s+(move\s+)?plan\b/i.test(t))
    return { kind: "plan_cancel" };
  if (/\b(what|which)\s+plan\b|\bplan status\b|\bam i on (track|plan)\b|\bhow'?s (my|the) plan\b/i.test(t))
    return { kind: "plan_status" };
  if (
    /\bplan (out )?(my|the|this) move\b|\bmove plans?\b|\b(draft|make|give me|show me|new|fresh)\s+(me\s+)?(some\s+|a few\s+|three\s+|3\s+)?plans\b|\bkeep (this|the|my) move under\b|\bmove (budget|for) under\b|\bplans? (for|under) \$/i.test(
      t,
    )
  )
    return { kind: "plan_draft", budgetCents: amounts[0] ?? null };
  return null;
}

const APPROVE =
  /^\s*(yes|yep|yeah|yup|y|ok|okay|sure|go ahead|do it|approved?|send (it|them)|release (it|the money)|confirm(ed)?|sounds good)\b/i;
const DECLINE = /^\s*(no|nope|nah|n|wait|hold( on| off)?|cancel|stop|don'?t|not yet)\b/i;

const COST_WORDS = [
  "u-haul",
  "uhaul",
  "truck",
  "van",
  "storage",
  "movers",
  "mover",
  "cleaning",
  "cleaners",
  "gas",
  "boxes",
  "supplies",
  "permit",
  "internet",
  "utilities",
  "pizza",
  "dumpster",
  "sublet",
  "apartment",
  "rent",
  "parking",
];

function costLabel(text: string): string | null {
  const t = text.toLowerCase();
  for (const w of COST_WORDS)
    if (new RegExp(`\\b${w.replace("-", "\\-")}\\b`).test(t)) return w === "uhaul" ? "U-Haul" : w;
  return null;
}

const NOT_NAMES = new Set([
  "me",
  "i",
  "my",
  "the",
  "and",
  "evenly",
  "equally",
  "roommates",
  "roommate",
  "everyone",
  "them",
  "us",
  "split",
  "cost",
  "share",
  "shares",
  "by",
  "with",
  "between",
  "among",
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  ...COST_WORDS,
]);

function namesIn(fragment: string): string[] {
  return fragment
    .split(/,|\band\b|&|\+/i)
    .map((s) =>
      s
        .trim()
        .replace(/[^A-Za-z' -]/g, "")
        .trim(),
    )
    .map((s) => s.split(/\s+/)[0] ?? "")
    .filter((s) => s.length > 1 && !NOT_NAMES.has(s.toLowerCase()))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
}

/** Rule-based parser. `roommates` is the roster, used when the owner says "my roommates". */
export function parseRules(text: string, now: Date, roommates: string[] = []): Intent {
  const t = text.trim();
  const lower = t.toLowerCase();
  const amounts = parseAmounts(t);

  const plan = parsePlanIntent(t, amounts);
  if (plan) return plan;
  if (t.length <= 60 && DECLINE.test(t)) return { kind: "decline" };
  if (t.length <= 60 && APPROVE.test(t)) return { kind: "approve" };

  const phone = normalizePhone(t);
  if (phone) {
    const m = t.match(/\b([A-Z][a-z]+)\b(?:'s)?(?:\s+(?:number|phone|cell|is|at|:))*\s*[:-]?\s*\(?\+?\d/);
    const name = m?.[1];
    if (name && !NOT_NAMES.has(name.toLowerCase())) return { kind: "add_contact", name, handle: phone };
  }

  if (/\b(scam|legit|sketchy|suspicious|fishy|safe to pay|real\?)\b/i.test(t)) return { kind: "scam_check" };

  if (
    /\b(was actually|is actually|should('ve| have)? been|that'?s wrong|is wrong|was wrong|wrong amount|mistake|typo|undo|fix (the|that|it|my)|correct (the|that|it)|edit (the|that|my)|change (the|that|my) (amount|split|share|deposit|truck|ledger))\b/i.test(
      t,
    )
  )
    return { kind: "fix" };

  const depositPaid = /\b(paid|put down|sent|gave|left|put)\b/i.test(t) && !!amounts[0];
  const dueBack = /\b(due back|back by|returned by|refund(ed)? by|get it back|back on)\b/i.test(t);
  if (
    /\bdeposit\b/i.test(t) &&
    !depositPaid &&
    !dueBack &&
    /\b(back|returned|refunded|got (it|the|my)|came back)\b/i.test(t)
  )
    return { kind: "deposit_returned", what: costLabel(t) };

  if (/\b(split|divide|chip in|go halves|halfsies|share the cost)\b/i.test(t) && amounts[0]) {
    const what = costLabel(t) ?? "shared cost";
    const excludeMe = /\b(not|without|except|minus) me\b|\bjust (them|between them)\b/i.test(t);
    // Explicit shares: "me 50% Sam 25% Priya 25%" or "me 2 Sam 1".
    const pairs = [
      ...t.matchAll(/\b(me|[A-Z][a-z]+)\s*(?:[:=-]\s*)?(\d{1,3})\s*(%|percent|shares?)?(?![\d$])/g),
    ]
      .map((m) => ({ name: m[1] === "me" || m[1] === "Me" ? "me" : (m[1] ?? ""), weight: Number(m[2]) }))
      .filter((p) => p.name === "me" || (p.name !== "" && !NOT_NAMES.has(p.name.toLowerCase())));
    if (pairs.length >= 2 && pairs.every((p) => p.weight > 0))
      return { kind: "split", amountCents: amounts[0], what, shares: pairs };
    const listed =
      t.match(/\b(?:with|between|among|amongst)\s+(.+?)(?:[.!?]|\bevenly\b|\bequally\b|$)/i)?.[1] ?? "";
    let names = namesIn(listed);
    if (names.length === 0 || /\b(my )?roommates\b|\beveryone\b/i.test(listed))
      names = [...new Set([...names, ...roommates])];
    const shares: Share[] = [
      ...(excludeMe ? [] : [{ name: "me", weight: 1 }]),
      ...names.map((n) => ({ name: n, weight: 1 })),
    ];
    return { kind: "split", amountCents: amounts[0], what, shares };
  }

  if (/\bdeposit\b/i.test(t) && amounts[0] && /\b(paid|put down|sent|gave|left|put)\b/i.test(t)) {
    const due = /\b(due back|back by|returned by|refund(ed)? by|get it back|back on)\b/i.test(t)
      ? parseDate(t, now)
      : null;
    return { kind: "deposit_paid", amountCents: amounts[0], what: costLabel(t) ?? "deposit", dueBackAt: due };
  }

  if (
    /\b(fell through|bailed|no[- ]show(ed)?|backed out|flaked|didn'?t show|cancel(l)?ed (the )?(pickup|sale|order))\b/i.test(
      t,
    )
  )
    return { kind: "pickup_failed", item: itemWord(t) };
  if (
    /\b(picked (it |them )?up|pickup (is )?(done|complete)|came and got|collected it|handed (it|them) off)\b/i.test(
      t,
    )
  )
    return { kind: "pickup_confirmed", item: itemWord(t) };

  if (
    /\b(payment plan|installments?|pay (it |this |that |you |the rest )?(back )?(later|over time|in parts|monthly|off)|can'?t (afford|pay)|loan|iou|(a|per) month|monthly|\/mo|spread (it|this) out)\b/i.test(
      t,
    )
  ) {
    const monthly =
      t.match(/\$\s?(\d{1,5}(?:\.\d{1,2})?)\s*(?:a|per|\/|each)\s*(?:month|mo)\b/i)?.[1] ??
      t.match(/\b(\d{1,5})\s*(?:dollars|bucks)?\s*(?:a|per|each)\s*month\b/i)?.[1];
    const named =
      t.match(/\b(?:let|give|offer|put)\s+([A-Z][a-z]+)\b/)?.[1] ??
      t.match(/\b([A-Z][a-z]+)\s+(?:can|could|will)\s+pay\b/)?.[1];
    const person = named && !NOT_NAMES.has(named.toLowerCase()) ? cap(named) : null;
    return {
      kind: "loan",
      person,
      what: costLabel(t),
      monthlyCents: monthly ? Math.round(Number(monthly) * 100) : null,
    };
  }

  const pay = t.match(/^\s*(?:please\s+)?(?:pay|send|venmo|zelle)\s+([A-Z][a-z]+)\s+\$/i);
  if (pay?.[1] && amounts[0] && !NOT_NAMES.has(pay[1].toLowerCase()))
    return {
      kind: "pay_person",
      person: cap(pay[1]),
      amountCents: amounts[0],
      what: costLabel(t) ?? "payment",
    };

  const paid = t.match(/\b([A-Z][a-z]+)\s+(?:already\s+|just\s+)?(?:paid|venmoed|zelled|sent)\b/);
  if (paid?.[1] && !NOT_NAMES.has(paid[1].toLowerCase()) && paid[1] !== "I")
    return { kind: "mark_paid", person: paid[1], what: costLabel(t), amountCents: amounts[0] ?? null };
  if (/^\s*(paid|sent( it)?|done|i paid|just paid|i sent( it)?)\b/i.test(t))
    return { kind: "mark_paid", person: null, what: costLabel(t), amountCents: amounts[0] ?? null };

  if (
    /\b(dashboard|my money|how('?s| is| am i doing (with|on)) (my )?money|money (overview|summary|picture|status|update)|where do i stand|ledger|the books|show me the money|who owes|owe|owes|balance|how much|totals?|where('?s| is) the money)\b/i.test(
      lower,
    )
  )
    return { kind: "ledger" };

  return { kind: "other" };
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const ITEM_WORDS = [
  "couch",
  "sofa",
  "mattress",
  "desk",
  "chair",
  "table",
  "lamp",
  "dresser",
  "bookshelf",
  "bed",
  "tv",
  "bike",
  "rug",
  "shelf",
];
function itemWord(text: string): string | null {
  const t = text.toLowerCase();
  return ITEM_WORDS.find((w) => new RegExp(`\\b${w}\\b`).test(t)) ?? null;
}

const LlmIntent = z.object({
  kind: z.enum([
    "approve",
    "decline",
    "split",
    "deposit_paid",
    "deposit_returned",
    "mark_paid",
    "loan",
    "pay_person",
    "pickup_confirmed",
    "pickup_failed",
    "add_contact",
    "ledger",
    "scam_check",
    "fix",
    "other",
  ]),
  amountDollars: z.number().nullable().describe("the dollar amount the sender wrote, exactly; null if none"),
  what: z.string().nullable().describe("what the money is for, 1-3 words (truck, storage, sublet deposit)"),
  people: z
    .array(z.object({ name: z.string(), weight: z.number() }))
    .describe(
      'for split: everyone sharing the cost, the owner as "me"; weight = percent or share count, 1 if even',
    ),
  person: z.string().nullable().describe("for mark_paid / pay_person / add_contact: the person's first name"),
  phone: z.string().nullable(),
  dueBack: z.string().nullable().describe("for deposit_paid: YYYY-MM-DD it is due back, null if not said"),
  item: z.string().nullable().describe("for pickups: the item sold"),
  monthlyDollars: z
    .number()
    .nullable()
    .describe("for loan: the monthly payment the sender wrote, null if none"),
});

const SYSTEM = `You read texts sent to the Money Elf of a moving crew and say what the sender wants.
The owner of the move is "me". Kinds:
- split: share a cost among people (owner included unless they say otherwise)
- deposit_paid: they paid a holding deposit (sublet, truck, storage, movers)
- deposit_returned: a deposit came back
- mark_paid: someone already paid some or all of what they owed (amountDollars = what they paid, if said)
- loan: someone wants to pay their share over time / a payment plan (person = who, if the owner names them)
- pay_person: the owner wants to send someone money
- pickup_confirmed / pickup_failed: a buyer picked up a sold item, or the pickup fell through
- add_contact: a person's phone number
- ledger: asks to see the dashboard, their money, balances, who owes what, or totals
- scam_check: asks whether something is a scam or forwards a suspicious message
- fix: wants to correct, change or undo something already on the Ledger ("the truck was actually $260", "undo that")
Only report an amount the sender actually wrote. Never invent people or amounts.`;

/** LLM-first parse with the rule parser as the backup; any LLM amount not in the text is rejected. */
export async function parseIntent(
  text: string,
  deps: { llm: MoneyLLM; now: Date; roommates: string[]; context?: string },
): Promise<Intent> {
  const rules = parseRules(text, deps.now, deps.roommates);
  if (
    rules.kind === "approve" ||
    rules.kind === "decline" ||
    rules.kind.startsWith("plan_") ||
    deps.llm.name === "fake"
  )
    return rules;
  try {
    const r = await deps.llm.extract(LlmIntent, {
      system: SYSTEM,
      user: `${deps.context ? `Known roommates: ${deps.context}\n` : ""}Text:\n${text}`,
    });
    const cents = r.amountDollars == null ? null : Math.round(r.amountDollars * 100);
    if (cents != null && !amountAppearsIn(text, cents)) return rules;
    switch (r.kind) {
      case "split":
        if (cents == null || r.people.length === 0) return rules;
        return {
          kind: "split",
          amountCents: cents,
          what: r.what ?? costLabel(text) ?? "shared cost",
          shares: r.people.map((p) => ({
            name: p.name.toLowerCase() === "me" ? "me" : cap(p.name),
            weight: p.weight > 0 ? p.weight : 1,
          })),
        };
      case "deposit_paid":
        if (cents == null) return rules;
        return {
          kind: "deposit_paid",
          amountCents: cents,
          what: r.what ?? "deposit",
          dueBackAt: r.dueBack && /^\d{4}-\d{2}-\d{2}$/.test(r.dueBack) ? r.dueBack : null,
        };
      case "pay_person":
        if (cents == null || !r.person) return rules;
        return { kind: "pay_person", person: cap(r.person), amountCents: cents, what: r.what ?? "payment" };
      case "add_contact": {
        const handle = normalizePhone(r.phone ?? text);
        if (!r.person || !handle) return rules;
        return { kind: "add_contact", name: cap(r.person), handle };
      }
      case "mark_paid":
        return {
          kind: "mark_paid",
          person: r.person ? cap(r.person) : null,
          what: r.what,
          amountCents: cents,
        };
      case "loan": {
        const monthly = r.monthlyDollars == null ? null : Math.round(r.monthlyDollars * 100);
        if (monthly != null && !amountAppearsIn(text, monthly)) return rules;
        return { kind: "loan", person: r.person ? cap(r.person) : null, what: r.what, monthlyCents: monthly };
      }
      case "deposit_returned":
        return { kind: "deposit_returned", what: r.what };
      case "pickup_confirmed":
      case "pickup_failed":
        return { kind: r.kind, item: r.item };
      case "fix":
        return { kind: "fix" };
      case "ledger":
      case "scam_check":
        return { kind: r.kind };
      default:
        return rules;
    }
  } catch {
    return rules;
  }
}

/** A buyer saying they have the item ("got it", "picked it up"): their half of the escrow release (SPEC §4). */
export function buyerConfirmsPickup(text: string): boolean {
  return /\b(got (it|them|the \w+)|picked (it |them |the \w+ )?up|received (it|them|the \w+)|have (it|them|the \w+) now|pickup (is )?(done|complete))\b/i.test(
    text,
  );
}
