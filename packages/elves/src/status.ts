import { pendingOwnerAsks, policyFor, price } from "@elves/engine";
import type { Move, Store } from "@elves/shared";
import { formatDate } from "./facts.ts";

/**
 * "status": one paragraph with where the whole move stands, read straight off the store so nothing is invented:
 * dates, what Home has (the sublet, the search), what Stuff has (listed, sold, booked pickups),
 * what is on the ledger, and anything waiting on the owner's yes.
 */

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export async function statusReport(store: Store, move: Move): Promise<string> {
  const parts: string[] = [];

  // Dates and places.
  const when: string[] = [];
  if (move.moveOutAt)
    when.push(`out ${formatDate(move.moveOutAt)}${move.fromAddress ? ` of ${move.fromAddress}` : ""}`);
  if (move.moveInAt)
    when.push(`in ${formatDate(move.moveInAt)}${move.toAddress ? ` at ${move.toAddress}` : ""}`);
  parts.push(when.length ? `You're moving ${when.join(" and ")}.` : "No move dates yet.");

  // Home: a sublet the owner is running, then the housing search.
  const deals = await store.listDeals(move.id);
  const sublet = deals.find((d) => d.mode === "sublet_out");
  if (sublet) {
    let line = "Sublet: open";
    if (sublet.slot) line = `Sublet: a viewing is booked ${sublet.slot.label}`;
    else {
      const parties = await store.listDealParties(sublet.id);
      const talking = parties.filter((p) =>
        ["talking", "agreed", "awaiting_owner"].includes(p.status),
      ).length;
      if (talking) line += `, ${talking} applicant${talking > 1 ? "s" : ""} talking`;
    }
    parts.push(`${line}.`);
  }

  const listings = await store.listListings(move.id);
  const ranked = listings.filter((l) => l.rank != null && l.status !== "rejected").length;
  const contacted = listings.filter((l) => l.status === "contacted").length;
  if (ranked || contacted)
    parts.push(
      `Housing: ${ranked} pick${ranked === 1 ? "" : "s"} ranked${contacted ? `, ${contacted} lister${contacted > 1 ? "s" : ""} contacted` : ""}.`,
    );

  // Stuff.
  const items = await store.listItems(move.id);
  if (items.length) {
    const sold = items.filter((i) => i.outcome === "sold").map((i) => i.name);
    const gone = items.filter((i) => ["given", "donated", "dumped"].includes(i.outcome)).map((i) => i.name);
    const live = items.filter((i) => i.outcome === "listed" && i.listingApproved).map((i) => i.name);
    const waiting = items.filter((i) => i.outcome === "listed" && !i.listingApproved).map((i) => i.name);
    const bits: string[] = [];
    if (live.length) bits.push(`listed ${list(live)}`);
    if (sold.length) bits.push(`sold ${list(sold)}`);
    if (gone.length) bits.push(`gone ${list(gone)}`);
    if (waiting.length) bits.push(`waiting on a photo or price for ${list(waiting)}`);
    const pickups = deals.flatMap((d) =>
      d.mode === "sell_item" && d.state === "scheduled" && d.slot ? [`${d.title} ${d.slot.label}`] : [],
    );
    if (pickups.length) bits.push(`pickups booked: ${list(pickups)}`);
    if (bits.length) parts.push(`Stuff: ${bits.join("; ")}.`);
  }

  // Money: what the engine has put on the ledger.
  let held = 0;
  let released = 0;
  for (const e of await store.listEvents(move.id)) {
    const cents = Number((e.payload as { cents?: unknown }).cents ?? 0) || 0;
    if (e.type === "ledger.hold") held += cents;
    else if (e.type === "ledger.refund") held -= cents;
    else if (e.type === "ledger.release") {
      held -= cents;
      released += cents;
    }
  }
  if (held > 0 || released > 0)
    parts.push(
      `Ledger: ${usd(Math.max(0, held))} held in escrow${released > 0 ? `, ${usd(released)} released to you` : ""}.`,
    );

  // Anything waiting on the owner.
  const asks = (await pendingOwnerAsks(store, move.id)).map(({ deal, party }) =>
    party.slot
      ? `a ${policyFor(deal.mode).meetNoun} ${party.slot.label} for the ${deal.title}`
      : `a ${price(party.lastOfferCents, deal.unit)} offer on the ${deal.title}`,
  );
  if (asks.length) parts.push(`Waiting on your yes: ${list(asks)}.`);

  return parts.join(" ");
}
