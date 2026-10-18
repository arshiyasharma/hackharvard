import { z } from "zod";

/**
 * The move brief: everything the Crew Lead learns on the onboarding call, before any Elf plans anything.
 * The owner confirms it once; then the specialists are dispatched from it. Nullable means "not known yet";
 * the Crew Lead never invents a value and never asks for one the owner already gave.
 */
const iso = z.string().nullable().describe("ISO date YYYY-MM-DD, or null when unknown");

export const BriefItemCategory = z
  .enum(["couch", "mattress", "desk_table", "chair", "bookshelf_dresser", "small", "other"])
  .describe("closest category");
export const BriefItemIntent = z.enum(["sell", "donate", "keep", "buy", "undecided"]);
export const BriefItem = z.object({
  name: z.string().describe("short item name in the owner's words, e.g. 'grey IKEA couch'"),
  category: BriefItemCategory,
  intent: BriefItemIntent,
  notes: z
    .string()
    .nullable()
    .describe(
      "anything that changes how it is handled: condition, what they paid, a price they hope for, sentimental",
    ),
});
export type BriefItem = z.infer<typeof BriefItem>;

export const Brief = z.object({
  move: z.object({
    moveOutDate: iso,
    moveOutFlexibility: z
      .string()
      .nullable()
      .describe(
        "how hard the move-out date is: 'lease ends that day', 'could leave a few days early', or null",
      ),
    moveInDate: iso,
    fromAddress: z.string().nullable().describe("current address or at least neighborhood and city"),
    toAddress: z.string().nullable().describe("destination address, neighborhood, city, or 'not found yet'"),
    distance: z.enum(["same_building", "same_city", "long_distance", "unknown"]),
    reason: z
      .string()
      .nullable()
      .describe("why they are moving, if they said: new job, graduating, lease ending"),
  }),
  people: z.object({
    household: z
      .string()
      .nullable()
      .describe("who is moving: 'just me', 'me and my partner', 'three roommates'"),
    roommates: z.array(z.string()).describe("names of roommates or housemates mentioned"),
    helpers: z.string().nullable().describe("who can lift, drive, or cover a pickup, and when"),
    availability: z
      .string()
      .nullable()
      .describe("when the owner can be around for pickups and viewings: 'weekday evenings, never mornings'"),
  }),
  stuff: z.object({
    items: z.array(BriefItem),
    volume: z
      .string()
      .nullable()
      .describe("rough amount of stuff: 'a studio's worth', 'two bedrooms plus a garage'"),
    bigOrAwkward: z
      .array(z.string())
      .describe("pianos, sectionals, anything that needs two people or a special truck"),
    attitude: z
      .string()
      .nullable()
      .describe("how they feel about selling vs donating vs dumping: 'would rather donate than haggle'"),
  }),
  home: z.object({
    leaseSituation: z
      .enum(["ending", "breaking_early", "month_to_month", "subletting_out", "no_lease", "unknown"])
      .describe("what is happening with the current lease"),
    leaseNotes: z
      .string()
      .nullable()
      .describe(
        "landlord, notice given or not, deposit worries, whether subletting is allowed, in their words",
      ),
    needsPlace: z
      .boolean()
      .nullable()
      .describe("true when the crew should find them housing at the destination"),
    housing: z
      .object({
        kind: z.enum(["room", "sublet", "apartment", "hotel", "unknown"]),
        areas: z.array(z.string()),
        budgetMonthlyUsd: z.number().nullable(),
        from: iso,
        until: iso,
        mustHaves: z.array(z.string()),
      })
      .nullable()
      .describe("what they are looking for, when needsPlace is true"),
    gap: z
      .string()
      .nullable()
      .describe(
        "nights between move-out and move-in and what happens then: 'a week at a friend's', 'need storage'",
      ),
    moveInNeeds: z.array(z.string()).describe("internet, utilities, address change, renters insurance, keys"),
  }),
  money: z.object({
    budgetUsd: z.number().nullable().describe("what they can spend on the whole move, in dollars"),
    paymentPrefs: z.array(z.string()).describe("how they want to be paid or pay: venmo, zelle, cash"),
    splits: z.string().nullable().describe("who shares which costs or proceeds: 'split the truck with Sam'"),
    priority: z
      .enum(["cheapest", "fastest", "least_effort", "balanced", "unknown"])
      .describe("what they optimize for when money and effort trade off"),
  }),
  moveDay: z.object({
    transport: z.enum(["truck_rental", "movers", "own_car", "friends", "undecided", "unknown"]),
    storage: z.string().nullable().describe("storage needed, for what and how long, or null"),
    access: z
      .string()
      .nullable()
      .describe("stairs, elevator, loading dock, parking, building rules at either end"),
    timing: z.string().nullable().describe("time-of-day constraints on move day, truck return deadlines"),
  }),
  worries: z.array(z.string()).describe("what the owner is anxious about, in their words"),
  priorities: z.array(z.string()).describe("what matters most to them, most important first"),
  asksVerbatim: z.array(z.string()).describe("explicit requests the owner made, quoted"),
  openQuestions: z
    .array(z.string())
    .describe("what the crew still does not know and would need to ask, most important first"),
});
export type Brief = z.infer<typeof Brief>;

export function emptyBrief(): Brief {
  return {
    move: {
      moveOutDate: null,
      moveOutFlexibility: null,
      moveInDate: null,
      fromAddress: null,
      toAddress: null,
      distance: "unknown",
      reason: null,
    },
    people: { household: null, roommates: [], helpers: null, availability: null },
    stuff: { items: [], volume: null, bigOrAwkward: [], attitude: null },
    home: {
      leaseSituation: "unknown",
      leaseNotes: null,
      needsPlace: null,
      housing: null,
      gap: null,
      moveInNeeds: [],
    },
    money: { budgetUsd: null, paymentPrefs: [], splits: null, priority: "unknown" },
    moveDay: { transport: "unknown", storage: null, access: null, timing: null },
    worries: [],
    priorities: [],
    asksVerbatim: [],
    openQuestions: [],
  };
}

/** The onboarding call's state, kept in the store's cursor table under `onboardingKey(moveId)`. */
export type OnboardingStatus = "gathering" | "confirming" | "confirmed";
export interface OnboardingState {
  status: OnboardingStatus;
  brief: Brief;
  /** Turns in which the Crew Lead asked for more, so the call cannot run forever. */
  askTurns: number;
  /** Which prompt variant ran this call (for evals). */
  prompt: string;
  startedAt: string;
  confirmedAt: string | null;
}

export function onboardingKey(moveId: string): string {
  return `onboarding:${moveId}`;
}

export function parseOnboardingState(raw: string | undefined | null): OnboardingState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OnboardingState;
    if (!parsed || typeof parsed !== "object" || !parsed.status) return null;
    return { ...parsed, brief: Brief.parse(parsed.brief) };
  } catch {
    return null;
  }
}

/** True while the Crew Lead is still gathering or waiting for the owner's yes. */
export function onboardingActive(state: OnboardingState | null): boolean {
  return state != null && state.status !== "confirmed";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (xs: string[]) => (xs.length ? xs.join(", ") : null);

/**
 * The brief as working-memory lines, so every Elf reads the same thing the owner confirmed.
 * Unknowns are skipped rather than printed, except the open questions.
 */
export function briefLines(b: Brief): string[] {
  const out: string[] = [];
  const line = (label: string, v: string | number | null | undefined) => {
    if (v != null && v !== "") out.push(`- ${label}: ${v}`);
  };
  line(
    "Move-out",
    b.move.moveOutDate &&
      `${b.move.moveOutDate}${b.move.moveOutFlexibility ? ` (${b.move.moveOutFlexibility})` : ""}`,
  );
  line("Move-in", b.move.moveInDate);
  line("From", b.move.fromAddress);
  line("To", b.move.toAddress);
  line("Distance", b.move.distance !== "unknown" ? b.move.distance.replace("_", " ") : null);
  line("Why", b.move.reason);
  line("Household", b.people.household);
  line("Roommates", list(b.people.roommates));
  line("Helpers", b.people.helpers);
  line("Availability", b.people.availability);
  if (b.stuff.items.length)
    out.push(
      `- Items: ${b.stuff.items.map((i) => `${i.name} (${i.intent}${i.notes ? `; ${i.notes}` : ""})`).join(", ")}`,
    );
  line("Volume", b.stuff.volume);
  line("Big or awkward", list(b.stuff.bigOrAwkward));
  line("Attitude to stuff", b.stuff.attitude);
  line(
    "Lease",
    b.home.leaseSituation !== "unknown"
      ? `${b.home.leaseSituation.replace(/_/g, " ")}${b.home.leaseNotes ? `; ${b.home.leaseNotes}` : ""}`
      : b.home.leaseNotes,
  );
  if (b.home.needsPlace && b.home.housing) {
    const h = b.home.housing;
    out.push(
      `- Needs a place: ${h.kind}${h.areas.length ? ` in ${h.areas.join(" / ")}` : ""}${h.budgetMonthlyUsd != null ? ` under $${h.budgetMonthlyUsd}/mo` : ""}${h.from || h.until ? ` ${h.from ?? "?"} → ${h.until ?? "?"}` : ""}${h.mustHaves.length ? `; must have ${h.mustHaves.join(", ")}` : ""}`,
    );
  } else if (b.home.needsPlace === false) out.push("- Needs a place: no, destination is set");
  line("Gap", b.home.gap);
  line("Move-in needs", list(b.home.moveInNeeds));
  line("Budget", b.money.budgetUsd != null ? `$${b.money.budgetUsd}` : null);
  line("Payment", list(b.money.paymentPrefs));
  line("Splits", b.money.splits);
  line("Optimizes for", b.money.priority !== "unknown" ? b.money.priority.replace("_", " ") : null);
  line("Transport", b.moveDay.transport !== "unknown" ? b.moveDay.transport.replace("_", " ") : null);
  line("Storage", b.moveDay.storage);
  line("Access", b.moveDay.access);
  line("Timing", b.moveDay.timing);
  line("Worries", list(b.worries));
  line("Priorities", list(b.priorities));
  line("Asked for", b.asksVerbatim.length ? b.asksVerbatim.map((a) => `"${a}"`).join("; ") : null);
  line("Still unknown", list(b.openQuestions.map(cap)));
  return out.length ? out : ["- (nothing captured yet)"];
}
