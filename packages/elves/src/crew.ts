import type { ElfName } from "@elves/shared";

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
}

export const CREW_ABILITIES: Ability[] = [
  {
    elf: "home",
    name: "find a place",
    text: "Home Elf finds you a place to move into, a hotel for the gap, or storage (Craigslist, Airbnb, Booking.com, SpareFoot), flags scams and texts you the top 3.",
    spoken:
      "finds you a place, a hotel for the gap or storage, and sends you the top three with scams flagged",
  },
  {
    elf: "home",
    name: "sublet your place",
    text: "Home Elf sublets your place: asks the rent, dates, area and room photos, writes the post for you to put up, and handles applicants. No viewing gets booked without your yes.",
    spoken: "sublets your place, writing the post and never booking a viewing without your yes",
  },
  {
    elf: "home",
    name: "move checklist and status",
    text: 'Home Elf keeps your move checklist (utilities, internet, renters insurance, address change, keys). Text "status" anytime for where everything stands.',
    spoken: "keeps your move checklist, like utilities, internet and keys",
  },
  {
    elf: "stuff",
    name: "price from a photo",
    text: "Stuff Elf prices an item from a photo and writes the listing line; you post it yourself on Facebook Marketplace or wherever you like.",
    spoken: "prices your things from a photo for you to post",
  },
  {
    elf: "stuff",
    name: "deal with buyers",
    text: "Stuff Elf negotiates with buyers who text this number, never under your lowest price, and checks with you on low offers.",
    spoken: "deals with buyers, never under your lowest price",
  },
  {
    elf: "stuff",
    name: "Last Call",
    text: "Stuff Elf runs Last Call: 48 hours before move-out unsold things drop in price, at 24 hours they go free, then it asks you about donating.",
    spoken: "drops prices on what's left before move-out, then asks about donating",
  },
  {
    elf: "money",
    name: "ledger",
    text: "Money Elf keeps the move's ledger on Nessie: every sale, escrow hold and release, and the money set aside for the move.",
    spoken: "keeps the move's ledger of sales, escrow and money set aside",
  },
];

/** What the crew does not do, said the same way every time. */
export const CREW_LIMITS = [
  "book trucks, U-Hauls or movers",
  "plan the route or run move day",
  "post listings on Facebook, Craigslist or anywhere else for you",
  "read leases or contact your landlord",
  "pay, send or request money for you",
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

/** The ability lines as one plain-text block, one line each. */
export function abilitiesText(): string {
  return CREW_ABILITIES.map((a) => a.text).join("\n");
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
    limitsSentence(),
  ].join("\n");
}

/** The answer to "what can you do?". */
export function abilitiesReply(): string {
  return ["Here's what the crew can do:", abilitiesText(), limitsSentence()].join("\n");
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
    re: /\b(u-?haul|truck|moving van|movers?|moving company|hire (?:some )?(?:help|people)|load(?:ing)? help)\b/i,
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
    re: /\b(pay|venmo|zelle|wire|transfer)\b[^.?!]{0,30}\b(for me|my rent|the deposit|my deposit|the landlord)\b|\b(pay|cover) (?:my|the) (?:rent|bill|deposit)\b|\bsend (?:the )?(?:money|payment|deposit)\b/i,
    cant: "The crew doesn't pay, send or request money for you.",
    instead: "Money Elf keeps the ledger of every sale and escrow hold on Nessie.",
  },
  {
    re: /\b(legal advice|sue|lawyer|small claims|tax(?:es)? advice|invest(?:ing|ment)? advice|is it legal)\b/i,
    cant: "The crew can't give legal or financial advice.",
    instead: "It can find you a place, sublet yours, sell your stuff and keep the ledger.",
  },
];

/** A request the crew can't do, with the reply that says so and names the closest thing it can do. */
export function outOfScope(text: string): { cant: string; instead: string; reply: string } | null {
  for (const r of OUT_OF_SCOPE) if (r.re.test(text)) return { ...r, reply: `${r.cant} ${r.instead}` };
  return null;
}
