import {
  ELF_LABELS,
  type ElfStatusRow,
  type HousingSearch,
  type Item,
  type Listing,
  type Move,
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
${housing ? `\n## Housing search\n${housingLines(housing).join("\n")}\n` : ""}
## Crew
${crew.length ? crew.join("\n") : "- everyone standing by"}`;
}
