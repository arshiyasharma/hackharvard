import type { LLM } from "@elves/llm";
import { z } from "zod";
import { clipToTokens, dedupeKey, type MessageRow } from "./types.ts";

export const FactExtraction = z.object({
  facts: z.array(
    z.object({
      kind: z.enum(["preference", "constraint", "commitment", "open_loop", "person", "fact"]),
      subject: z.string().describe("owner | move | item:<name> | person:<name>"),
      text: z.string().describe("one specific sentence in the present tense"),
      confidence: z.number().min(0).max(1),
      audience: z
        .enum(["crew", "owner_private"])
        .describe(
          "owner_private for anything a buyer or landlord must never hear: floor prices, urgency, budget, reasons for moving",
        ),
    }),
  ),
});
export type ExtractedFact = z.infer<typeof FactExtraction>["facts"][number];

const EXTRACT_SYSTEM = `You maintain the long-term memory of Elves, a moving crew the owner texts. From the latest exchange, extract only durable facts that will matter in later conversations:
- preference: tone, timing, pickup windows, payment apps, how they like to be kept posted
- constraint: things that cannot happen (no mornings, no stairs, landlord rules, no strangers inside)
- commitment: something the crew promised to do
- open_loop: something still waiting on the owner or on someone else
- person: roommates, buyers, landlords and what they do
- fact: stable facts about the move not already in working memory
Skip anything already in working memory (dates, addresses, items and prices), greetings, acknowledgements and one-off questions. One sentence per fact, specific, present tense, no more than eight facts. Mark audience owner_private for anything a buyer must never hear: floor prices, urgency, budget, reasons for moving. Return an empty list when nothing is durable.`;

/** Facts from an exchange: the fast model when available, otherwise a few deterministic patterns. */
export async function extractFacts(
  llm: LLM,
  input: { role: string; text: string; reply: string; elfLabel: string; working: string | null },
): Promise<ExtractedFact[]> {
  if (llm.name === "fake") return heuristicFacts(input.text);
  try {
    const res = await llm.extract(FactExtraction, {
      system: EXTRACT_SYSTEM,
      user: `Working memory:\n${input.working ?? "(empty)"}\n\nThe ${input.role} wrote:\n"""${input.text}"""\n\n${input.elfLabel} replied:\n"""${input.reply}"""`,
    });
    return dedupe(res.facts.filter((f) => f.text.trim().length > 0).slice(0, 8));
  } catch {
    return heuristicFacts(input.text);
  }
}

const PREF_RE =
  /\b(prefer|rather|only|never|can'?t|cannot|don'?t|won'?t|no earlier|not before|not after|after \d|before \d|weekends?|weekdays?|mornings?|evenings?|afternoons?|nights?)\b/i;
const CONSTRAINT_RE = /\b(can'?t|cannot|never|won'?t|not|no earlier|not before|not after)\b/i;
const PAY_RE = /\b(venmo|zelle|cash ?app|paypal|apple cash)\b/i;
const URGENT_RE =
  /\b(asap|urgent|desperate|need (?:it|this|them) gone|whatever (?:i|we) can get|just want (?:it|them) gone)\b/i;

/** Deterministic extraction for tests and for when no model is configured. */
export function heuristicFacts(text: string): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  const mate =
    text.match(/\broommates?,?\s+(?:named\s+)?([A-Z][a-z]+)/) ??
    text.match(/\b([A-Z][a-z]+)\s+(?:is|'s)\s+my\s+roommate\b/);
  if (mate?.[1]) {
    const name = mate[1];
    const sentence = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((x) => x.trim())
      .find((x) => x.includes(name));
    const detail = sentence && sentence.length <= 160 ? `: "${sentence.replace(/[.!]+$/, "")}"` : "";
    out.push({
      kind: "person",
      subject: `person:${name}`,
      text: `Roommate ${name} is part of the move${detail}`,
      confidence: 0.7,
      audience: "crew",
    });
  }
  const pay = text.match(PAY_RE);
  if (pay?.[1]) {
    const app = pay[1].replace(/\s+/g, " ");
    out.push({
      kind: "preference",
      subject: "owner",
      text: `Owner uses ${cap(app)} for payments`,
      confidence: 0.7,
      audience: "crew",
    });
  }
  if (URGENT_RE.test(text)) {
    out.push({
      kind: "constraint",
      subject: "owner",
      text: "Owner is in a hurry to clear things out",
      confidence: 0.6,
      audience: "owner_private",
    });
  }
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (s.length < 8 || s.length > 200 || !PREF_RE.test(s) || /\?$/.test(s)) continue;
    const isConstraint = CONSTRAINT_RE.test(s);
    out.push({
      kind: isConstraint ? "constraint" : "preference",
      subject: "owner",
      text: `Owner: ${cap(s.replace(/[.!]+$/, ""))}`,
      confidence: 0.55,
      audience: "crew",
    });
  }
  return dedupe(out);
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function dedupe(facts: ExtractedFact[]): ExtractedFact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const k = dedupeKey(f.kind, f.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const Summary = z.object({ summary: z.string() });

/** Fold older messages into the running summary (fast model), or a deterministic digest without one. */
export async function summarize(
  llm: LLM,
  prior: string | null,
  messages: MessageRow[],
  label: (m: MessageRow) => string,
): Promise<string> {
  const lines = messages.map((m) => `${label(m)}: ${m.text.replace(/\s+/g, " ")}`);
  if (llm.name === "fake") {
    const digest = lines.map((l) => l.slice(0, 80)).join(" / ");
    return clipToTokens(`${prior ? `${prior} / ` : ""}${digest}`, 300);
  }
  try {
    const res = await llm.extract(Summary, {
      system:
        "Update the running summary of a text conversation between a moving crew and the person they are helping. Keep every decision, number, name, date and open question; drop pleasantries. Write in the past tense, third person, at most 150 words.",
      user: `Current summary:\n${prior ?? "(none)"}\n\nNew messages, oldest first:\n${lines.join("\n")}`,
    });
    return clipToTokens(res.summary.trim(), 300);
  } catch {
    return clipToTokens(`${prior ? `${prior} / ` : ""}${lines.map((l) => l.slice(0, 80)).join(" / ")}`, 300);
  }
}
