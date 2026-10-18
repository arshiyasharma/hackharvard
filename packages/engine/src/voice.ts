/**
 * The phrases that change with who the crew is in a deal. The seller voice is the original copy: the crew has the
 * thing and a stranger texted in about it. The buyer voice is for deals where the crew wants what the counterparty
 * has and usually texted them first (find_sublet): it never claims the place is "available", never sends the
 * owner's address, and says "the person I'm helping" rather than "the owner", who to a lister is them.
 *
 * Every price arrives already formatted ("$1,200/mo", "free", "make an offer"); `cents` is there for the branches
 * that need to know free from unpriced. Nothing here may carry the owner's limit.
 */
export interface Voice {
  /** Who the counterparty is told comes to whom: true when they come to the owner's address for the hand-off. */
  comesToUs: boolean;
  /** First text back to a question with no number in it. */
  greet(title: string, at: string, cents: number | null): string;
  /** A later question with no number in it. */
  info(at: string, cents: number | null): string;
  /** We agreed at `at`; `slots` is the numbered list or null when the calendar is empty. `lead` is a prefix. */
  agreed(at: string, slots: string | null, meetNoun: string, lead: string): string;
  /** What the counterparty hears while the owner decides. */
  checking: string;
  /** Prefix on the agreement once the owner said yes. */
  ownerYesLead: string;
  ownerNo(hold: string): string;
  ownerCounter(at: string): string;
  /** An off-escrow payment ask, not severe. */
  escrowOnly(at: string, meetNoun: string): string;
  /** The deal closed without them. */
  gone(title: string): string;
  booked(slot: string, address: string | null, at: string | null, meetNoun: string): string;
  bookedReminder(slot: string, address: string | null): string;
  /** The counterparty picked `slot`; it waits for the owner's OK. */
  slotPending(slot: string, meetNoun: string): string;
  /** The owner turned the picked time down; `slots` is the numbered list of others, or null. */
  slotDeclined(slots: string | null, meetNoun: string): string;
  /** "No worries." then this, when there are no slots to offer. */
  rescheduleOpen: string;
  slotTakenOpen: string;
  /** The hand-off happened; `cents` is 0 when it was free. Each voice formats the amount itself. */
  handedOff(title: string, cents: number, unit: "each" | "month"): string;
  // Owner-facing. `role` is the counterparty's role word ("buyer", "lister").
  ask(role: string, title: string, theirs: string, limitLabel: string, limit: string, hold: string): string;
  /** Said to the owner when we counter; null when counters are not relayed (many buyers, no promise to relay). */
  countered: ((role: string, title: string, theirs: string, ours: string) => string) | null;
  ownerNoSummary(hold: string, title: string): string;
  bookedOwner(role: string, title: string, slot: string, at: string): string;
  /** The counterparty picked a time; nothing is booked until the owner says yes. */
  askSlot(role: string, title: string, slot: string, at: string, meetNoun: string): string;
  walkedOwner(role: string, title: string): string;
  handedOffOwner(title: string, cents: number, unit: "each" | "month"): string;
}

const fmt = (cents: number) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
export function price(cents: number | null, unit: "each" | "month" = "each"): string {
  if (cents == null) return "make an offer";
  if (cents === 0) return "free";
  return unit === "month" ? `${fmt(cents)}/mo` : fmt(cents);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The crew is selling or renting out; the counterparty texted in and comes to pick up or view. */
export const SELLER: Voice = {
  comesToUs: true,
  greet: (title, at) => `Hi! The ${title} is available${at === "free" ? " for free" : `, ${at}`}. Want it?`,
  info: (at) => `It's ${at === "free" ? "free" : at}. Want it?`,
  agreed: (at, slots, meetNoun, lead) =>
    slots
      ? `${lead}${at === "free" ? "It's yours." : `Deal at ${at}.`} ${cap(meetNoun)} times: ${slots}. Which works?`
      : `${lead}${at === "free" ? "It's yours." : `Deal at ${at}.`} When could you do the ${meetNoun}?`,
  checking: "Let me check with the owner and get back to you.",
  ownerYesLead: "Good news: the owner said yes. ",
  ownerNo: (hold) => `I checked with the owner and can't go that low; ${hold} is the lowest.`,
  ownerCounter: (at) => `I checked with the owner: ${at} is the best they can do.`,
  escrowOnly: (at, meetNoun) =>
    `All payments go through the Elves escrow link I send at the ${meetNoun}; no Venmo, Zelle or cash apps. Still interested at ${at}?`,
  gone: (title) => `Sorry, the ${title} is gone.`,
  booked: (slot, address, at) =>
    `Booked: ${slot}.${address ? ` Address: ${address}.` : " I'll text the address before then."}${at ? ` ${at}, paid through Elves escrow.` : ""}`,
  bookedReminder: (slot, address) => `You're booked for ${slot}.${address ? ` Address: ${address}.` : ""}`,
  slotPending: (slot, meetNoun) =>
    `${slot} for the ${meetNoun}: let me confirm with the owner and get back to you.`,
  slotDeclined: (slots, meetNoun) =>
    slots
      ? `Sorry, that time doesn't work for the owner. Other ${meetNoun} times: ${slots}. Which works?`
      : `Sorry, that time doesn't work for the owner. When else could you come?`,
  rescheduleOpen: "When could you come instead?",
  slotTakenOpen: "When else could you come?",
  handedOff: (title, cents) =>
    cents > 0
      ? `Enjoy the ${title}! Payment (${price(cents)}) runs through Elves escrow.`
      : `Enjoy the ${title}!`,
  ask: (role, title, theirs, limitLabel, limit, hold) =>
    `A ${role} offers ${theirs} for the ${title} (your ${limitLabel} ${limit}; I'm holding at ${hold}). Take ${theirs}? Reply yes, no, or a number.`,
  countered: null,
  ownerNoSummary: (hold, title) => `Got it. I told them ${hold} is the lowest for the ${title}.`,
  bookedOwner: (role, title, slot, at) =>
    `Booked: ${role} picks up the ${title} ${slot} for ${at}. It comes off the truck estimate.`,
  askSlot: (role, title, slot, at, meetNoun) =>
    `The ${role} for the ${title} (${at}) wants a ${meetNoun} ${slot}. Book it? Reply yes or no.`,
  walkedOwner: (role, title) => `A ${role} walked away from the ${title}; it's back on the market.`,
  handedOffOwner: (title, cents) =>
    cents > 0
      ? `Handed off: the ${title} went for ${price(cents)}. Payment runs through escrow; I'll mark it paid when it clears.`
      : `Handed off: the ${title} went free to a good home.`,
};

/** The crew wants the place; it texted the lister first and goes to them for the viewing. */
export const BUYER: Voice = {
  comesToUs: false,
  greet: (title, at, cents) =>
    cents == null
      ? `Thanks! Is the ${title} still available, and what's the rent?`
      : cents === 0
        ? `Thanks! Is the ${title} still available?`
        : `Thanks! Is the ${title} still available? We can do up to ${at}.`,
  info: (at, cents) =>
    cents == null
      ? "What's the rent?"
      : cents === 0
        ? "Is it still available?"
        : `We can do up to ${at}. Does that work?`,
  agreed: (at, slots, _meetNoun, lead) => {
    const open = `${lead || "Great, "}${at === "free" ? "that" : at} works. When could we see it?`;
    return slots ? `${open} We could do ${slots}.` : open;
  },
  checking: "Let me check with the person I'm helping and get back to you.",
  ownerYesLead: "Good news: ",
  ownerNo: (hold) => `I checked and can't go that high; ${hold} is the most we can do.`,
  ownerCounter: (at) => `I checked: ${at} is the most we can do.`,
  escrowOnly: (at) =>
    `Any deposit goes through the Elves escrow link; no Venmo, Zelle or cash apps. Are we still good at ${at}?`,
  gone: (title) => `Sorry, we're no longer looking at the ${title}. Thanks for your time.`,
  booked: (slot, _address, at, meetNoun) =>
    `Booked: ${meetNoun} ${slot}.${at ? ` ${at}; any deposit goes through Elves escrow.` : ""}`,
  bookedReminder: (slot) => `We're set for ${slot}.`,
  slotPending: (slot) =>
    `${slot} could work; let me confirm with the person I'm helping and get back to you.`,
  slotDeclined: (slots) =>
    slots
      ? `Sorry, that time doesn't work on our side. Could we do ${slots}?`
      : `Sorry, that time doesn't work on our side. When else could we come?`,
  rescheduleOpen: "When could we come instead?",
  slotTakenOpen: "When else could we come?",
  handedOff: () => "Thanks so much! Any deposit goes through Elves escrow.",
  ask: (role, title, theirs, limitLabel, limit, hold) =>
    `The ${role} wants ${theirs} for the ${title} (your ${limitLabel} ${limit}; I'm holding at ${hold}). Pay ${theirs}? Reply yes, no, or a number.`,
  countered: (role, title, theirs, ours) =>
    `The ${role} wants ${theirs} for the ${title}; I offered ${ours}.`,
  ownerNoSummary: (hold, title) => `Got it. I told them ${hold} is the most for the ${title}.`,
  bookedOwner: (_role, title, slot, at) => `Booked: viewing of the ${title} ${slot} at ${at}.`,
  askSlot: (role, title, slot, at, meetNoun) =>
    `The ${role} for the ${title} (${at}) offers a ${meetNoun} ${slot}. Book it? Reply yes or no.`,
  walkedOwner: (role, title) => `The ${role} walked away from the ${title}.`,
  handedOffOwner: (title, cents, unit) =>
    cents > 0
      ? `Done: you have the ${title} at ${price(cents, unit)}. Any deposit runs through escrow; I'll mark it paid when it clears.`
      : `Done: you have the ${title}, free.`,
};
