/**
 * What the Money Elf says about itself when it is asked, doesn't understand, can't help, or needs one more detail.
 * One place, so its menu, its refusals and its questions agree with each other and with the Crew Lead's list of
 * what the Money Elf does (CREW_ABILITIES in packages/elves/src/crew.ts; a test keeps the two in step).
 */
import { fmtUsd } from "./amounts.ts";
import type { LedgerView } from "./ledger-view.ts";

export interface MoneyCapability {
  name: string;
  /** A text that does it, as the owner would send it. */
  example: string;
}

export const MONEY_CAPABILITIES: MoneyCapability[] = [
  { name: "Split a cost", example: "split the $240 truck with Sam and Priya" },
  { name: "Set up a payment plan", example: "let Sam pay the truck at $40 a month" },
  { name: "Log a deposit", example: "I paid a $500 sublet deposit, due back Dec 1" },
  { name: "Pay a roommate", example: "pay Sam $40 for gas" },
  { name: "Plan the rest of the move (three plans, with odds)", example: "plan my move under $400" },
  { name: "See your money", example: "show me the ledger" },
];
const example = (name: string) => MONEY_CAPABILITIES.find((c) => c.name === name)?.example ?? "";

const INTRO = "I keep every dollar of the move on one Ledger in Nessie, and nothing moves without your yes.";
const ALSO =
  "Sale money goes into escrow on its own when a buyer agrees a price, and I ask you before it moves.";

/** The menu: what the Money Elf does, with a text that does each thing, then the question. */
export function menuLines(): string[] {
  return [
    INTRO,
    [...MONEY_CAPABILITIES.map((c) => `• ${c.name}: "${c.example}"`), `• ${ALSO}`].join("\n"),
    "What would you like to do?",
  ];
}

/** A message the Money Elf couldn't place: say so, and offer the likeliest things. */
export function otherLines(): string[] {
  return [
    "I'm not sure what you'd like me to do with that.",
    `I can split a cost ("${example("Split a cost")}"), pay a roommate ("${example("Pay a roommate")}"), log a deposit ("${example("Log a deposit")}"), plan the rest of the move ("${example("Plan the rest of the move")}"), or show your money ("${example("See your money")}").`,
    "Which of those did you mean?",
  ];
}

/** What it can't do, named, with what it can do instead. */
export function cantWhat(text: string): string {
  if (/\b(rent|landlord|mortgage|bills?|insurance|tuition)\b/i.test(text))
    return "pay rent, bills or a landlord";
  if (/\b(invest|stocks?|crypto|bitcoin)\b/i.test(text)) return "invest money";
  if (/\b(taxes|tax return|irs)\b/i.test(text)) return "do taxes";
  return "move money to or from a bank account";
}

export function cantLines(what: string): string[] {
  return [
    `I can't ${what}. I only handle this move's costs, deposits and sale money, and only through Nessie.`,
    "I can split a cost, pay a roommate from the Moving Fund, log a deposit, or hold sale money in escrow, each after your yes.",
  ];
}

export type ClarifyTopic = "split" | "pay_amount" | "pay_who" | "deposit_amount";

/** One missing detail, asked for with an example of the whole thing. */
export function clarifyLines(c: {
  topic: ClarifyTopic;
  what?: string | null;
  person?: string | null;
  amountCents?: number | null;
  names?: string[];
}): string[] {
  switch (c.topic) {
    case "split":
      return [
        `Happy to split ${c.what ? `the ${c.what}` : "that"}.`,
        `Example: "${MONEY_CAPABILITIES[0]?.example}".`,
        c.names?.length
          ? `I'll split it with ${c.names.join(" and ")}. How much was it?`
          : "How much was it, and who's in on it?",
      ];
    case "pay_amount":
      return [
        `I can pay ${c.person ?? "a roommate"} from the Moving Fund, through Nessie, after your yes.`,
        `How much should I pay ${c.person ?? "them"}?`,
      ];
    case "pay_who":
      return [
        `I can pay ${c.amountCents ? fmtUsd(c.amountCents) : "a roommate"} from the Moving Fund, through Nessie, after your yes.`,
        c.amountCents
          ? `Who should I pay the ${fmtUsd(c.amountCents)} to?`
          : "Who should I pay, and how much?",
      ];
    case "deposit_amount":
      return [
        "I'll log that deposit on the Ledger.",
        `Example: "${MONEY_CAPABILITIES[2]?.example}".`,
        "How much was it, and when is it due back?",
      ];
  }
}

export type LedgerFocus = "owed" | "escrow" | "spent" | "made" | "balance";

/** The one-line answer to a specific question about the money, read from the live view. */
export function focusLine(view: LedgerView, focus: LedgerFocus): string {
  switch (focus) {
    case "owed": {
      const owing = view.owes.filter((o) => o.owedCents > 0);
      if (!owing.length) return "Nobody owes you anything right now.";
      return `${owing.map((o) => `${o.name} owes ${fmtUsd(o.owedCents)}`).join(", ")}.`;
    }
    case "escrow":
      return view.escrow.length
        ? `In escrow: ${view.escrow.map((e) => `${fmtUsd(e.cents)} for the ${e.item} (${e.buyer})`).join(", ")}.`
        : "Nothing is in escrow right now.";
    case "spent":
      return `You've spent ${fmtUsd(view.spentCents)} on the move so far.`;
    case "made":
      return view.salesCents > 0 || view.escrowCents > 0
        ? `Sales: ${fmtUsd(view.salesCents)} paid out${view.escrowCents ? `, ${fmtUsd(view.escrowCents)} still in escrow` : ""}.`
        : "No sale money has come in yet.";
    case "balance":
      return `The Moving Fund has ${fmtUsd(view.fundCents)}.`;
  }
}
