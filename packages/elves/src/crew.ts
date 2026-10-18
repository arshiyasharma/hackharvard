import type { ElfName } from "@elves/shared";

/** One signpost per Elf, used wherever an Elf is named at the start of a line. */
export const ELF_EMOJI: Record<ElfName, string> = { crew_lead: "🧭", home: "🏠", stuff: "📦", money: "💸" };
const ELF_LABEL: Record<Ability["elf"], string> = {
  home: "Home Elf",
  stuff: "Stuff Elf",
  money: "Money Elf",
};

/** One ability as a bullet under its Elf's heading: the "Home Elf " lead is the heading's job. */
export function abilityLine(a: Ability): string {
  const body = a.text.replace(/^(?:Home|Stuff|Money) Elf /, "");
  return `• ${body.charAt(0).toUpperCase()}${body.slice(1)}`;
}

/** The one line every reminder uses, so the owner learns the word once. Also exported from status.ts. */
export const STATUS_HINT = "Text STATUS anytime to see where everything stands, or DASHBOARD to see your money.";

/**
 * What the crew can and cannot do: the one list the Crew Lead's text prompt, its first message, the onboarding
 * call and the Retell voice prompt all read, so the owner hears the same abilities everywhere and anything off
 * the list gets a plain "the crew can't do that".
 */

export interface Ability {
  elf: Exclude<ElfName, "crew_lead">;
  /** Short name, used in the prompt list. */
  name: string;
  /** One line as the owner reads it in a text. */
  text: string;
  /** The same ability said out loud, as a verb phrase: "The Home Elf <spoken>, <spoken> and <spoken>." */
  spoken: string;
  /** Texts that do it, as the owner would send them. A test routes each to this Elf, so the list can't drift. */
  examples?: string[];
}

export const CREW_ABILITIES: Ability[] = [
  {
    elf: "home",
    name: "find a place",
    text: "Home Elf finds you a place to move into, a hotel for the gap, or storage (Craigslist, Airbnb, Booking.com, SpareFoot), flags scams and texts you the top 3.",
    spoken:
      "finds you a place, a hotel for the gap or storage, and sends you the top three with scams flagged",
    examples: [
      "find me a room in allston under 1200",
      "find storage for june to august",
      "find a hotel for the gap",
    ],
  },
  {
    elf: "home",
    name: "sublet your place",
    text: "Home Elf sublets your place: asks the rent, dates, area and room photos, writes the post for you to put up, and handles applicants. No viewing gets booked without your yes.",
    spoken: "sublets your place, writing the post and never booking a viewing without your yes",
    examples: ["sublet my room for $1500"],
  },
  {
    elf: "home",
    name: "move checklist and status",
    text: 'Home Elf keeps your move checklist (utilities, internet, renters insurance, address change, keys). Text "status" anytime for where everything stands.',
    spoken: "keeps your move checklist, like utilities, internet and keys",
    examples: ["set up internet at the new place", "what do I need for move-in"],
  },
  {
    elf: "stuff",
    name: "price from a photo",
    text: "Stuff Elf prices an item from a photo and writes the listing line; you post it yourself on Facebook Marketplace or wherever you like.",
    spoken: "prices your things from a photo for you to post",
    examples: ["sell my couch", "I have a lamp to sell for $20"],
  },
  {
    elf: "stuff",
    name: "deal with buyers",
    text: "Stuff Elf negotiates with buyers who text this number, never under your lowest price, and checks with you on low offers.",
    spoken: "deals with buyers, never under your lowest price",
    examples: ["lowest I'd take is $60 for the desk"],
  },
  {
    elf: "stuff",
    name: "Last Call",
    text: 'Stuff Elf runs Last Call: 72 and 48 hours before move-out unsold things drop in price, at 24 hours they go free, and "donate it" takes a listing off and drafts the pickup request.',
    spoken: "drops prices on what's left before move-out, then asks about donating",
    examples: ["keep the couch", "donate the desk"],
  },
  {
    elf: "money",
    name: "split costs",
    text: 'Money Elf splits shared costs with roommates ("split the $240 truck with Sam and Priya"), texts each person their share, tracks who has paid and sets up payment plans. Nothing is sent without your yes.',
    spoken: "splits shared costs with your roommates and tracks who has paid",
    examples: [
      "split the $240 truck with Sam and Priya",
      "who owes me?",
      "can Sam pay the truck at $40 a month",
    ],
  },
  {
    elf: "money",
    name: "deposits and paying back",
    text: "Money Elf logs a deposit you paid (sublet, storage, truck) with its due-back date and marks it returned, and pays a roommate from the Moving Fund, in Nessie, after your yes.",
    spoken: "logs your deposits and pays a roommate back, only after your yes",
    examples: ["I paid a $500 sublet deposit, due back Dec 1", "got my deposit back", "pay Sam $40 for gas"],
  },
  {
    elf: "money",
    name: "escrow for sales",
    text: "Money Elf holds a buyer's or sublet applicant's payment in escrow after your yes, moves it into the Moving Fund when pickup is confirmed, and refunds it if they walk.",
    spoken: "holds a buyer's payment in escrow and releases it at pickup, with your yes",
    examples: ["is anything in escrow?", "refund the buyer", "release the escrow for the couch"],
  },
  {
    elf: "money",
    name: "the ledger",
    text: 'Money Elf shows the whole ledger, read live from Nessie, as a photo and a web dashboard link: "show me the ledger", "how much have I spent?", "how much did I make?".',
    spoken: "shows your whole ledger, live from Nessie",
    examples: ["show me the ledger", "how much have I spent?", "how much did I make?"],
  },
];

/** What the crew does not do, said the same way every time. */
export const CREW_LIMITS = [
  "book trucks, U-Hauls or movers",
  "plan the route or run move day",
  "post listings on Facebook, Craigslist or anywhere else for you",
  "read leases or contact your landlord",
  "pay rent, bills or a landlord",
  "move money to or from a bank",
  "give legal or financial advice",
] as const;

const ELF_SPOKEN: Record<Ability["elf"], string> = {
  home: "Home Elf",
  stuff: "Stuff Elf",
  money: "Money Elf",
};

/** One spoken sentence per Elf: "The Home Elf finds you a place, sublets your place and keeps your checklist." */
export function spokenAbilities(): string {
  return (["home", "stuff", "money"] as const)
    .map((elf) => {
      const xs = CREW_ABILITIES.filter((a) => a.elf === elf).map((a) => a.spoken);
      const joined =
        xs.length > 1 ? `${xs.slice(0, -1).join("; ")}; and ${xs[xs.length - 1]}` : (xs[0] ?? "");
      return `The ${ELF_SPOKEN[elf]} ${joined}.`;
    })
    .join(" ");
}

/** The abilities grouped under an emoji heading per Elf, a blank line between Elves. */
export function abilitiesText(): string {
  return (["home", "stuff", "money"] as const)
    .map((elf) =>
      [
        `${ELF_EMOJI[elf]} ${ELF_LABEL[elf]}`,
        ...CREW_ABILITIES.filter((a) => a.elf === elf).map(abilityLine),
      ].join("\n"),
    )
    .join("\n\n");
}

/** The limits as one sentence. */
export function limitsSentence(): string {
  return `The crew can't ${CREW_LIMITS.slice(0, -1).join(", ")} or ${CREW_LIMITS[CREW_LIMITS.length - 1]}.`;
}

/** The first text the owner ever gets: who we are and exactly what the crew can do. */
export function crewIntro(): string {
  return [
    "Hey, I'm the Crew Lead at Elves, your moving crew. Here's what we can do:",
    abilitiesText(),
    `🚫 ${limitsSentence()}`,
    STATUS_HINT,
  ].join("\n\n");
}

/** The answer to "what can you do?". */
export function abilitiesReply(): string {
  return ["Here's what the crew can do:", abilitiesText(), `🚫 ${limitsSentence()}`, STATUS_HINT].join(
    "\n\n",
  );
}

/** The ability list and the limits, as a prompt block every Crew Lead prompt shares. */
export function crewScopePrompt(): string {
  const byElf = (elf: Ability["elf"]) =>
    CREW_ABILITIES.filter((a) => a.elf === elf)
      .map((a) => `- ${a.text}`)
      .join("\n");
  return `What the crew can do (three Elves, nothing else):
Home Elf:
${byElf("home")}
Stuff Elf:
${byElf("stuff")}
Money Elf:
${byElf("money")}

What the crew cannot do: ${CREW_LIMITS.join("; ")}; and anything that is not about this move.`;
}

const CAPABILITY_ASK =
  /^\s*(?:help|menu|commands|options|\?)\s*[?!.]*\s*$|\bwhat (?:can|do) (?:you(?: guys| all)?|y'?all|the crew|elves|u) (?:do|help with|handle)\b|\bwhat are (?:you|u) able to do\b|\bwhat (?:are )?your (?:abilities|capabilities|features)\b|\bhow (?:can|do) you help\b/i;

/** "what can you do?", "help": the owner wants the ability list. */
export function isCapabilitiesQuestion(text: string): boolean {
  return CAPABILITY_ASK.test(text);
}

const STATUS_ASK =
  /^\s*(?:status|update|status update|where are we|where do we stand|what'?s the status|how'?s it going|how are we doing)\b[\s?!.]*$/i;

/** "status", "where are we?": the owner wants the one-paragraph status. */
export function isStatusAsk(text: string): boolean {
  return STATUS_ASK.test(text);
}

interface OutOfScopeRule {
  re: RegExp;
  /** What the crew can't do, as the reply's first sentence. */
  cant: string;
  /** The closest thing it can do. */
  instead: string;
}

const OUT_OF_SCOPE: OutOfScopeRule[] = [
  {
    // Asking the crew to book or hire one; a truck in a cost ("split the $240 truck") is Money's, not a refusal.
    re: /\b(book|rent|reserve|hire|order|schedule|need|want|get me|find me|arrange|call)\b[^.?!]{0,30}\b(u-?haul|truck|moving van|movers?|moving company|load(?:ing)? help)\b|\bhire (?:some )?(?:help|people)\b|\b(u-?haul|truck|movers?)\b[^.?!]{0,20}\b(quote|availability|available|booking)\b/i,
    cant: "The crew can't book trucks, U-Hauls or movers.",
    instead: 'Home Elf can find storage for the gap, and text "status" for your move checklist.',
  },
  {
    re: /\b(route|directions|eta|move map|where are you|on my way|running late|moving permit|parking permit)\b/i,
    cant: "The crew doesn't plan routes or run move day.",
    instead: 'Text "status" for your move checklist and dates.',
  },
  {
    re: /\b(read|review|check|look at|explain)\b[^.?!]{0,30}\b(lease|contract)\b|\b(landlord|property manager)\b[^.?!]{0,40}\b(email|text|call|contact|tell|ask|notice)\b|\b(email|text|call|contact|tell|ask)\b[^.?!]{0,20}\b(my|the) landlord\b|\b(break|end) (?:my|the) lease\b|\bnotice to (?:my|the) landlord\b/i,
    cant: "The crew doesn't read leases or contact landlords.",
    instead: 'If your lease lets you sublet, say "sublet my room" and Home Elf will write the post.',
  },
  {
    re: /\b(post|list|put)\b[^.?!]{0,30}\b(on|to)\b[^.?!]{0,10}\b(facebook|fb|marketplace|craigslist|offerup|ebay)\b(?! post)|\bpost (?:it|them|this) for me\b/i,
    cant: "The crew doesn't post listings for you.",
    instead: "Stuff Elf writes the listing line with a price; you paste it, and buyers text this number.",
  },
  {
    re: /\b(pay|venmo|zelle|wire|transfer|send)\b[^.?!]{0,30}\b(my rent|the rent|my landlord|the landlord|my bills?|the bills?|my mortgage|my tuition)\b|\b(pay|cover) (?:my|the) (?:rent|bills?|mortgage|tuition)\b|\b(withdraw|cash out|bank (?:account|transfer)|transfer (?:the |my )?(?:money|funds|balance)|wire (?:the |my )?money)\b/i,
    cant: "The crew can't pay rent, bills or a landlord, or move money to or from a bank.",
    instead:
      "Money Elf can split costs with roommates, pay a roommate from the Moving Fund, log deposits and hold sale money in escrow, each after your yes.",
  },
  {
    re: /\b(legal advice|sue|lawyer|small claims|tax(?:es)? advice|invest(?:ing|ment)? advice|is it legal|invest|stocks?|crypto|bitcoin|my taxes|tax return)\b/i,
    cant: "The crew can't give legal or financial advice.",
    instead: "It can find you a place, sublet yours, sell your stuff and keep the ledger.",
  },
];

/** A request the crew can't do, with the reply that says so and names the closest thing it can do. */
export function outOfScope(text: string): { cant: string; instead: string; reply: string } | null {
  for (const r of OUT_OF_SCOPE) if (r.re.test(text)) return { ...r, reply: `🚫 ${r.cant}\n\n${r.instead}` };
  return null;
}

/** One line per Elf for "which did you mean?": what each is for, in words the owner would use. */
export const ELF_JOBS: Record<Ability["elf"], string> = {
  home: "finding or subletting a place, storage, your move checklist",
  stuff: "selling, buying or donating an item",
  money: "splitting costs, deposits, who owes what, sale money in escrow",
};

const NUMBER_WORDS = ["", "one", "two", "three"];

/** The question the Crew Lead asks when a text could be two or three Elves' job. */
export function clarifyQuestion(options: Ability["elf"][]): string {
  const rows = options.map((e, i) => `${i + 1}. ${ELF_LABEL[e]}: ${ELF_JOBS[e]}`);
  const pick = options.length === 2 ? "1 or 2" : `1, 2 or ${options.length}`;
  return [
    `I can take that ${NUMBER_WORDS[options.length] ?? options.length} ways:`,
    rows.join("\n"),
    `❓ Which did you mean? Reply ${pick}, or say it another way.`,
  ].join("\n\n");
}

/** Which Elf an answer picks ("2", "the second", "money"), among the ones offered; null if it picks none or several. */
export function pickClarifyOption(text: string, options: Ability["elf"][]): Ability["elf"] | null {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 40) return null;
  const digit = t.match(/^(?:option |number |#)?([1-3])[.!)]?$/);
  if (digit) return options[Number(digit[1]) - 1] ?? null;
  const ordinal = t.match(/\b(first|second|third|last)\b/);
  if (ordinal) {
    const at = { first: 0, second: 1, third: 2, last: options.length - 1 }[ordinal[1] as "first"];
    return options[at] ?? null;
  }
  const hits = options.filter((e) =>
    e === "money"
      ? /\b(money|payments?|ledger|owe|split)\b/.test(t)
      : e === "stuff"
        ? /\b(stuff|sell(ing)?|buy(ing)?|donat\w*|item)\b/.test(t)
        : /\b(home|housing|place|apartment|room|sublet|storage)\b/.test(t),
  );
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** The cursor that holds the question the Crew Lead is waiting on an answer to. */
export function clarifyKey(moveId: string): string {
  return `clarify:${moveId}`;
}

export interface PendingClarify {
  text: string;
  options: Ability["elf"][];
  at: number;
}

export function parseClarify(raw: string | undefined | null): PendingClarify | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as PendingClarify;
    return Array.isArray(c.options) && typeof c.text === "string" && typeof c.at === "number" ? c : null;
  } catch {
    return null;
  }
}

/** A question left unanswered this long is dropped; the next text is taken at face value. */
export const CLARIFY_TTL_MS = 30 * 60_000;
