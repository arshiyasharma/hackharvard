import { ELF_EMOJI } from "./crew.ts";
import { ELF_LABELS, type ElfName } from "@elves/shared";
import type { Elf, ElfContext, ElfResult } from "./contract.ts";
import { batchText, lastMessageId } from "./contract.ts";
import { keywordScore } from "./router.ts";

/** One job inside a grouped Elf: its own keywords, board task and canned reply until it is built out. */
export interface Skill {
  id: string;
  keywords: string[];
  task: string;
  reply: string;
}

/** The skill whose keywords best match `text`; ties and no-match go to the first skill. */
export function pickSkill(text: string, skills: Skill[]): { skill: Skill; score: number } {
  let best = { skill: skills[0] as Skill, score: 0 };
  for (const skill of skills) {
    const score = keywordScore(text, skill.keywords);
    if (score > best.score) best = { skill, score };
  }
  return best;
}

/** A canned acknowledgement for a skill that has no real implementation yet. */
export function skillReply(ctx: ElfContext, elf: ElfName, skill: Skill): ElfResult {
  return {
    replies: [{ text: `${ELF_EMOJI[elf]} ${skill.reply}`, parentMessageId: lastMessageId(ctx.batch) }],
    boardPatch: {
      status: "working",
      currentTask: skill.task,
      lastUpdate: `Picked up a message from the owner`,
    },
    events: [{ type: "elf.acknowledged", payload: { elf, label: ELF_LABELS[elf], skill: skill.id } }],
  };
}

/** Stuff Elf skills besides selling, which lives in sell.ts. */
export const BUY_SKILL: Skill = {
  id: "buy",
  keywords: [
    "buy",
    "buying",
    "forwarded",
    "link",
    "marketplace",
    "craigslist",
    "fair price",
    "worth it",
    "should i get",
  ],
  task: "Evaluating a listing",
  reply:
    "Stuff Elf here. Forward me the listing link or a screenshot and your max price; I'll check it against comps and draft the offer.",
};

export const GREEN_SKILL: Skill = {
  id: "green",
  keywords: [
    "donate",
    "donation",
    "free",
    "give away",
    "trash",
    "dump",
    "curb",
    "goodwill",
    "311",
    "311 pickup",
    "bulk pickup",
    "recycle",
    "landfill",
    "report",
    "last call",
  ],
  task: "Planning Last Call",
  reply:
    "Stuff Elf here. Anything unsold 48 hours before move-out drops in price, then goes free, and I book a donation or 311 pickup so nothing hits the curb.",
};

interface GroupSpec {
  name: ElfName;
  description: string;
  skills: Skill[];
}

const GROUPS: GroupSpec[] = [
  {
    name: "money",
    description:
      "Money: the move's ledger on Nessie (sales, escrow holds and releases, money set aside for the move), escrow questions, scams",
    skills: [
      {
        id: "money",
        keywords: [
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
        ],
        task: "Setting up the Moving Fund",
        reply:
          "Money Elf here. I keep the move's ledger on Nessie: every sale, escrow hold and release, and the money set aside for the move. Nobody pays outside escrow, and I never send or request money for you.",
      },
    ],
  },
];

/** The Home Elf lives in home.ts; Money is still a canned group. */
function makeGroup(spec: GroupSpec): Elf {
  return {
    name: spec.name,
    description: spec.description,
    keywords: spec.skills.flatMap((s) => s.keywords),
    async handle(ctx: ElfContext): Promise<ElfResult> {
      const { skill } = pickSkill(batchText(ctx.batch), spec.skills);
      return skillReply(ctx, spec.name, skill);
    },
  };
}

export const stubElves: Elf[] = GROUPS.map(makeGroup);
