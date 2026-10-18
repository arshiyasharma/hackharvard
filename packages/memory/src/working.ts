import {
  type Brief,
  briefLines,
  type Deal,
  type DealParty,
  ELF_LABELS,
  type ElfStatusRow,
  type HousingSearch,
  type Item,
  type Listing,
  type Move,
  type MoveinTask,
  type Participant,
} from "@elves/shared";

const usd = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`);

export interface HousingView {
  search: HousingSearch | null;
  listings: Listing[];
}

/** The Home Elf's search and its top picks, so every Elf can answer "did you find me a place yet?". */
export function housingLines(h: HousingView): string[] {
  if (!h.search) return ["- (no search yet)"];
  const s = h.search;
  const want = [
    s.kinds.join(" or ") || "housing",
    s.neighborhoods.length ? s.neighborhoods.join(", ") : s.city,
    s.budgetMaxCents != null ? `max ${usd(s.budgetMaxCents)}/mo` : null,
    s.moveIn || s.moveOut ? `${s.moveIn ?? "?"} → ${s.moveOut ?? "?"}` : null,
    s.furnished ? "furnished" : null,
  ].filter(Boolean);
  const lines = [`- Looking for: ${want.join(" · ")}`];
  if (s.mustHaves.length) lines.push(`- Must-haves: ${s.mustHaves.join(", ")}`);
  if (s.notes.length) lines.push(`- Notes: ${s.notes.join("; ")}`);
  const ranked = h.listings
    .filter((l) => l.rank != null && l.status !== "rejected")
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const flagged = h.listings.filter((l) => l.scamFlags.length).length;
  if (s.lastSearchedAt) {
    lines.push(
      `- Last search: ${s.lastSearchedAt.slice(0, 10)} · ${h.listings.length} found · ${flagged} flagged as likely scams · ${s.shownCount} shown`,
    );
  }
  if (ranked.length) {
    const picks = ranked
      .slice(0, 5)
      .map(
        (l) =>
          `${l.rank}. ${l.title} · ${l.priceCents != null ? `${usd(l.priceCents)}/${l.priceUnit === "night" ? "night" : "mo"}` : "price unknown"}${l.location ? ` · ${l.location}` : ""}${l.status !== "found" ? ` (${l.status})` : ""}`,
      );
    lines.push(`- Picks: ${picks.join(" ")}`);
  }
  return lines;
}

/** The move-in week checklist, so every Elf can answer "did we set up internet?". */
export function moveinLines(tasks: MoveinTask[], move: Pick<Move, "moveInAt" | "toAddress">): string[] {
  if (!tasks.length) return ["- (no checklist yet)"];
  const open = tasks.filter((t) => t.status === "open");
  const lines = [
    `- Move-in ${move.moveInAt ?? "?"} at ${move.toAddress ?? "?"} · ${open.length} of ${tasks.length} tasks open`,
  ];
  for (const t of tasks) {
    const state = t.status === "open" ? `due ${t.dueAt}${t.remindedAt ? " (reminded)" : ""}` : t.status;
    lines.push(`- ${t.label}: ${state}${t.notes ? ` · ${t.notes}` : ""}`);
  }
  return lines;
}

export function itemLine(i: Item): string {
  const stage = i.listingApproved
    ? "listed"
    : i.floorPriceCents != null
      ? "awaiting approval"
      : i.photoAttachmentIds.length
        ? "needs floor"
        : "needs photo";
  const range =
    i.priceLowCents != null && i.priceHighCents != null
      ? ` · range ${usd(i.priceLowCents)}-${usd(i.priceHighCents)}`
      : "";
  const tail = i.outcome !== "listed" ? ` · ${i.outcome}` : "";
  return `- ${i.name} · floor ${usd(i.floorPriceCents)} · list ${usd(i.listPriceCents)}${range} · ${stage}${tail}`;
}

export interface DealView {
  deal: Deal;
  parties: DealParty[];
}

const MODE_LABEL: Record<Deal["mode"], string> = {
  sell_item: "selling",
  buy_item: "buying",
  sublet_out: "subletting out",
  find_sublet: "renting",
};

/** One line per deal for the owner's side: state, ask, line, who is talking, what is booked. */
export function dealLine({ deal: d, parties }: DealView): string {
  const unit = d.unit === "month" ? "/mo" : "";
  const live = parties.filter((p) =>
    ["talking", "agreed", "awaiting_owner", "waitlisted"].includes(p.status),
  );
  const asking = parties.filter((p) => p.status === "awaiting_owner");
  const bits = [
    `${d.title} (${MODE_LABEL[d.mode]}, ref ${d.code})`,
    d.state,
    `ask ${usd(d.askCents)}${unit}`,
    `line ${usd(d.limitCents)}${unit}`,
  ];
  if (live.length) bits.push(`${live.length} talking`);
  if (asking.length)
    bits.push(
      `waiting on the owner about ${asking.map((p) => (p.slot ? `a ${p.slot.label} booking` : usd(p.lastOfferCents))).join(", ")}`,
    );
  if (d.slot) bits.push(`booked ${d.slot.label}`);
  if (d.agreedCents != null) bits.push(`agreed ${usd(d.agreedCents)}${unit}`);
  if (d.outcome) bits.push(d.outcome);
  return `- ${bits.join(" · ")}`;
}

/**
 * What a buyer, seller or applicant thread may see: the listings and their asking prices. No floors, no owner
 * details, no addresses, no other people, no crew chatter.
 */
export function renderPublicMemory(items: Item[], deals: DealView[]): string {
  const listed = deals
    .filter(({ deal }) => ["listed", "negotiating", "scheduled", "relisted"].includes(deal.state))
    .map(({ deal }) => {
      const item = items.find((i) => i.id === deal.subjectId);
      const desc = item?.condition ? ` · ${item.condition.replace("_", " ")} condition` : "";
      const ask = deal.askCents === 0 ? "free" : `${usd(deal.askCents)}${deal.unit === "month" ? "/mo" : ""}`;
      return `- ${item?.title ?? deal.title} · asking ${ask}${desc}${item?.description ? ` · ${item.description}` : ""}`;
    });
  return `# Listings (public; this is everything you may share)\n${listed.length ? listed.join("\n") : "- (nothing listed right now)"}`;
}

/**
 * Working memory is a view, not a store: rendered from the structured state on every turn so it can never drift
 * from what the Crew Board and the items table say.
 */
export function renderWorkingMemory(
  move: Move,
  items: Item[],
  board: ElfStatusRow[],
  participants: Participant[] = [],
  housing: HousingView | null = null,
  deals: DealView[] = [],
  movein: MoveinTask[] = [],
  brief: { brief: Brief; confirmed: boolean } | null = null,
): string {
  const people = participants.filter((p) => p.role !== "owner").map((p) => `${p.role} ${p.handle}`);
  const crew = board
    .filter((b) => b.status === "working" || b.status === "waiting" || b.status === "blocked")
    .map(
      (b) =>
        `- ${ELF_LABELS[b.elf] ?? b.elf} (${b.status}): ${b.currentTask}${b.lastUpdate ? ` — ${b.lastUpdate}` : ""}`,
    );
  return `# Move
- Owner: ${move.ownerHandle}${move.name ? ` (${move.name})` : ""}
- Move-out date: ${move.moveOutAt ?? "unknown"}
- Move-in date: ${move.moveInAt ?? "unknown"}
- From: ${move.fromAddress ?? "unknown"}
- To: ${move.toAddress ?? "unknown"}
- Other people in the loop: ${people.length ? people.join(", ") : "none yet"}

## Items (name · floor · list · status)
${items.length ? items.map(itemLine).join("\n") : "- (none yet)"}
${deals.length ? `\n## Deals (state · ask · owner's line, never told to a counterparty)\n${deals.map(dealLine).join("\n")}\n` : ""}${housing ? `\n## Housing search\n${housingLines(housing).join("\n")}\n` : ""}${movein.length ? `\n## Move-in week\n${moveinLines(movein, move).join("\n")}\n` : ""}${brief ? `\n## Brief (${brief.confirmed ? "confirmed by the owner" : "draft; the owner has not confirmed it yet"})\n${briefLines(brief.brief).join("\n")}\n` : ""}
## Crew
${crew.length ? crew.join("\n") : "- everyone standing by"}`;
}
