import { ELF_LABELS, type ElfName } from "@elves/shared";
import type { Elf, ElfContext, ElfResult } from "./contract.ts";
import { lastMessageId } from "./contract.ts";

interface StubSpec {
  name: ElfName;
  description: string;
  keywords: string[];
  task: string;
  reply: string;
}

const SPECS: StubSpec[] = [
  {
    name: "buy",
    description:
      "Buying items: a listing link or screenshot the owner forwards, offers to a seller, delivery of something bought",
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
      "Buy Elf here. Forward me the listing link or a screenshot and your max price; I'll check it against comps and draft the offer.",
  },
  {
    name: "green",
    description:
      "Donations, giving things away free, 311 or bulk pickup, trash, recycling, the Move Report and sustainability",
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
      "Green Elf here. Anything unsold 48 hours before move-out drops in price, then goes free, and I book a donation or 311 pickup so nothing hits the curb.",
  },
  {
    name: "money",
    description:
      "Money: payments, deposits, escrow, Venmo or Zelle requests, splitting costs with roommates, the ledger, scams",
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
      "Money Elf here. Every sale and deposit goes through escrow and lands on the Ledger; nobody pays outside it. Tell me who's splitting what and I'll track it.",
  },
  {
    name: "haul",
    description: "Trucks, movers, U-Haul, storage units, moving permits, the route on move day",
    keywords: [
      "truck",
      "u-haul",
      "uhaul",
      "movers",
      "mover",
      "storage",
      "unit",
      "permit",
      "van",
      "rent a",
      "book storage",
      "haul",
    ],
    task: "Getting quotes",
    reply:
      "Haul Elf here. Give me your dates and roughly how much stuff and I'll get storage and truck quotes, then book on your OK.",
  },
  {
    name: "map",
    description: "Move-day location: where everyone is, ETAs, meeting at the address, the Move Map",
    keywords: [
      "where are you",
      "eta",
      "on my way",
      "location",
      "map",
      "address",
      "meet",
      "running late",
      "arrive",
    ],
    task: "Standing by for move day",
    reply:
      "Map Elf here. On pickup day I'll send everyone a Move Map link so you can see each other approaching.",
  },
  {
    name: "lease",
    description:
      "The lease, subletting the owner's room out, landlord notices, security deposit, lease clauses, agreements",
    keywords: [
      "lease",
      "sublet",
      "sublease",
      "landlord",
      "clause",
      "notice",
      "security deposit",
      "agreement",
      "contract",
      "tenant",
    ],
    task: "Waiting for the lease",
    reply:
      "Lease Elf here. Send the lease PDF and I'll tell you whether you can sublet, quote the clauses, and draft the landlord notice.",
  },
  {
    name: "hunt",
    description:
      "Finding the owner a sublet or room to rent: requirements, budget, neighborhoods, listings they found",
    keywords: [
      "find a sublet",
      "looking for a room",
      "need a place",
      "apartment",
      "budget",
      "neighborhood",
      "room for",
      "rent in",
      "allston",
      "cambridge",
      "somerville",
    ],
    task: "Collecting requirements",
    reply:
      "Hunt Elf here. Tell me budget, dates and neighborhoods, and forward any listings you find; I'll rank them and flag anything that smells like a scam.",
  },
  {
    name: "movein",
    description:
      "Move-in week: the gap between places, luggage storage, hotels, utilities, internet, address change, renters insurance",
    keywords: [
      "move-in",
      "move in",
      "utilities",
      "internet",
      "wifi",
      "address change",
      "insurance",
      "hotel",
      "luggage",
      "airbnb",
      "electric",
      "gas bill",
    ],
    task: "Building the move-in checklist",
    reply:
      "Move-in Elf here. Give me your move-in date and new address and I'll line up utilities, internet, address change and a place for your bags in the gap.",
  },
];

function makeStub(spec: StubSpec): Elf {
  return {
    name: spec.name,
    description: spec.description,
    keywords: spec.keywords,
    async handle(ctx: ElfContext): Promise<ElfResult> {
      return {
        replies: [{ text: spec.reply, parentMessageId: lastMessageId(ctx.batch) }],
        boardPatch: {
          status: "working",
          currentTask: spec.task,
          lastUpdate: `Picked up a message from the owner`,
        },
        events: [{ type: "elf.acknowledged", payload: { elf: spec.name, label: ELF_LABELS[spec.name] } }],
      };
    },
  };
}

export const stubElves: Elf[] = SPECS.map(makeStub);
