import type { Slot } from "@elves/shared";

export type CounterpartyIntent =
  | { kind: "walk" }
  | { kind: "handoff" }
  | { kind: "reschedule" }
  | { kind: "slot"; slot: Slot }
  | { kind: "accept" }
  | { kind: "offer"; cents: number; final: boolean }
  | { kind: "ask" };

/** Lookahead that rules out times, ordinals and durations after a number ("6pm", "3rd", "2 days"). */
const NOT_TIME = "(?!\\d|\\s?(?:am|pm|a\\.m|p\\.m|:|st|nd|rd|th|ish|min|mins|minutes|hours?|hrs?|days?|weeks?))";

/** Dollar amounts a buyer or seller types: "$60", "60 bucks", "would you take 60", "can you do 55?", "60?". */
export function parseOfferCents(text: string): number | null {
  const t = text.toLowerCase().replace(/,(?=\d{3}\b)/g, "");
  const money = t.match(/\$\s?(\d{1,5}(?:\.\d{1,2})?)/) ?? t.match(/\b(\d{1,5}(?:\.\d{1,2})?)\s?(?:dollars|bucks|usd)\b/);
  if (money?.[1]) return Math.round(Number(money[1]) * 100);
  const phrased = t.match(
    new RegExp(
      `\\b(?:take|do|for|offer|pay|give|accept|go|meet (?:me )?at|how about|what about|would you do|tell them|say|counter(?: at| with)?)\\s+(?:you\\s+)?\\$?(\\d{1,5})${NOT_TIME}\\b`,
    ),
  );
  if (phrased?.[1]) return Number(phrased[1]) * 100;
  // A number that opens the text: "85", "60?", "60 is my final offer".
  const lead = t.trim().match(new RegExp(`^(\\d{1,5})${NOT_TIME}(?:\\s*[?!.]*\\s*$|\\s+(?:is|ok|okay|works|final|firm|obo|cash|and|for|max|tops)\\b)`));
  if (lead?.[1]) return Number(lead[1]) * 100;
  return null;
}

const WALK =
  /\b(never ?mind|nvm|no thanks|not interested|found (?:one|another|something)|i'?ll pass|pass on (?:it|this)|changed my mind|no longer (?:need|interested)|forget it)\b/i;
const HANDOFF =
  /\b(picked (?:it )?up|got (?:it|the \w+) (?:home|thanks|thank you)|got it,? thanks|have it now|received|all set,? thanks|keys? (?:in hand|received)|moved in)\b/i;
const RESCHEDULE =
  /\b(reschedule|can'?t make it|cannot make it|won'?t make it|another (?:time|day)|different (?:time|day)|push (?:it|this) (?:back|to)|something came up|no.?show)\b/i;
const ACCEPT =
  /\b(yes|yep|yeah|yup|deal|i'?ll take it|we have a deal|sounds good|works for me|that works|ok(?:ay)?|sure|let'?s do it|agreed|perfect|great)\b/i;
const FINAL = /\b(final|firm|best i can do|my max|that'?s all i (?:have|can)|take it or leave it|last offer)\b/i;
const ORDINALS: [RegExp, number][] = [
  [/^\s*(?:#|option\s*)?1\s*[.!?]?\s*$|\b(first|1st) (?:one|slot|time)\b/i, 0],
  [/^\s*(?:#|option\s*)?2\s*[.!?]?\s*$|\b(second|2nd) (?:one|slot|time)\b/i, 1],
  [/^\s*(?:#|option\s*)?3\s*[.!?]?\s*$|\b(third|3rd) (?:one|slot|time)\b/i, 2],
];

/** A slot the text picks out of the ones we offered: "2", "the second one", "sat", "6pm", "Sat 10am". */
export function pickOfferedSlot(text: string, offered: Slot[]): Slot | null {
  if (!offered.length) return null;
  for (const [re, i] of ORDINALS) if (re.test(text) && offered[i]) return offered[i]!;
  const t = text.toLowerCase();
  const scored = offered
    .map((s) => {
      const [day, time] = s.label.toLowerCase().split(" ");
      const dayHit = day ? new RegExp(`\\b${day}`).test(t) : false;
      const timeHit = time ? new RegExp(`\\b${time.replace(/(am|pm)$/, "")}\\s?${time.slice(-2)}\\b`).test(t) : false;
      return { s, score: (dayHit ? 1 : 0) + (timeHit ? 2 : 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!.s;
}

/**
 * Read a counterparty text in context. Order matters: walking away beats everything, a slot pick beats a bare
 * number when slots are on the table, and a dollar amount beats a generic "ok".
 */
export function readCounterparty(
  text: string,
  ctx: { offeredSlots: Slot[]; scheduled: boolean; hasStandingPrice: boolean },
): CounterpartyIntent {
  if (WALK.test(text)) return { kind: "walk" };
  if (ctx.scheduled && HANDOFF.test(text)) return { kind: "handoff" };
  if (ctx.scheduled && RESCHEDULE.test(text)) return { kind: "reschedule" };
  const slot = pickOfferedSlot(text, ctx.offeredSlots);
  if (slot) return { kind: "slot", slot };
  const cents = parseOfferCents(text);
  if (cents != null) return { kind: "offer", cents, final: FINAL.test(text) };
  if (ctx.hasStandingPrice && ACCEPT.test(text) && !/\?\s*$/.test(text.trim())) return { kind: "accept" };
  return { kind: "ask" };
}

export type OwnerDecision = { kind: "yes" } | { kind: "no" } | { kind: "price"; cents: number };

const OWNER_YES = /\b(yes|yep|yeah|yup|sure|ok(?:ay)?|fine|take it|accept|go ahead|do it|approved|deal)\b/i;
const OWNER_NO = /\b(no|nope|nah|don'?t|do not|too low|too high|pass|decline|hold out|not that)\b/i;

/** The owner's answer to "they offered $X, take it?": yes, no, or a number to counter with. */
export function readOwnerDecision(text: string): OwnerDecision | null {
  const cents = parseOfferCents(text);
  if (cents != null) return { kind: "price", cents };
  if (OWNER_NO.test(text)) return { kind: "no" };
  if (OWNER_YES.test(text)) return { kind: "yes" };
  return null;
}
