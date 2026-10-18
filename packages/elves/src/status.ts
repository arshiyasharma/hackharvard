import { pendingOwnerAsks, policyFor, price } from "@elves/engine";
import type { Move, MoveinTask, Store } from "@elves/shared";
import { formatDate } from "./facts.ts";
import { checklistFor, taskLine } from "./home-movein.ts";
import { moveReport } from "./impact.ts";
import { bookedPickups } from "./relations.ts";

/**
 * "STATUS": where the whole move stands, read straight off the store so nothing is invented. One short section
 * per Elf, a blank line between sections, one emoji per heading, and only the sections that have something to
 * say: dates, Home (the checklist, the sublet, the housing picks), Stuff (listed, sold, pickups, the Move
 * Report), Money (the ledger), and anything waiting on the owner's yes.
 */

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

import { STATUS_HINT } from "./crew.ts";

function section(title: string, lines: string[]): string {
  return [title, ...lines].join("\n");
}

export async function statusReport(store: Store, move: Move): Promise<string> {
  const sections: string[] = [];

  // 🗓 Dates
  const when: string[] = [];
  if (move.moveOutAt)
    when.push(`Out ${formatDate(move.moveOutAt)}${move.fromAddress ? ` from ${move.fromAddress}` : ""}`);
  if (move.moveInAt)
    when.push(`In ${formatDate(move.moveInAt)}${move.toAddress ? ` at ${move.toAddress}` : ""}`);
  sections.push(section("🗓 Dates", when.length ? [when.join("\n")] : ["No move dates yet."]));

  // 🏠 Home: the checklist first, it's what STATUS is most often for; then the sublet and the hunt.
  const home: string[] = [];
  const stored = await store.listMoveinTasks(move.id);
  const tasks: MoveinTask[] = stored.length
    ? stored
    : checklistFor(move).map((r) => ({
        ...r,
        status: "open" as const,
        notes: null,
        remindedAt: null,
        updatedAt: "",
      }));
  if (tasks.length) {
    const open = tasks.filter((t) => t.status === "open").map((t) => taskLine(t, move));
    const done = tasks.filter((t) => t.status === "done").map((t) => t.label);
    if (open.length) {
      home.push(`Checklist: ${open.length} to go`);
      for (const line of open) home.push(`  • ${line}`);
      if (done.length) home.push(`  ✅ Done: ${list(done)}`);
    } else home.push("Checklist: all done ✅");
  } else home.push("Checklist: starts once I have your move-in date.");

  const deals = await store.listDeals(move.id);
  const post = await store.getSubletPost(move.id);
  if (post && post.status !== "collecting") {
    const sublet = deals.find((d) => d.mode === "sublet_out");
    let line = `Sublet: post ${post.status === "approved" ? "approved" : "drafted"}`;
    if (sublet?.slot) line += `, viewing booked ${sublet.slot.label}`;
    else if (sublet) {
      const parties = await store.listDealParties(sublet.id);
      const talking = parties.filter((p) =>
        ["talking", "agreed", "awaiting_owner"].includes(p.status),
      ).length;
      if (talking) line += `, ${talking} applicant${talking > 1 ? "s" : ""} talking`;
    }
    home.push(line);
  } else if (post) home.push("Sublet: still collecting the details for your post.");

  const listings = await store.listListings(move.id);
  const ranked = listings.filter((l) => l.rank != null && l.status !== "rejected").length;
  const contacted = listings.filter((l) => l.status === "contacted").length;
  if (ranked || contacted)
    home.push(
      `Housing: ${ranked} pick${ranked === 1 ? "" : "s"} ranked${contacted ? `, ${contacted} lister${contacted > 1 ? "s" : ""} contacted` : ""}`,
    );
  sections.push(section("🏠 Home", home));

  // 📦 Stuff
  const items = await store.listItems(move.id);
  if (items.length) {
    const stuff: string[] = [];
    const sold = items.filter((i) => i.outcome === "sold").map((i) => i.name);
    const gone = items.filter((i) => ["given", "donated", "dumped"].includes(i.outcome)).map((i) => i.name);
    const live = items.filter((i) => i.outcome === "listed" && i.listingApproved).map((i) => i.name);
    const waiting = items.filter((i) => i.outcome === "listed" && !i.listingApproved).map((i) => i.name);
    if (live.length) stuff.push(`Listed: ${list(live)}`);
    if (sold.length) stuff.push(`Sold: ${list(sold)}`);
    if (gone.length) stuff.push(`Gone: ${list(gone)}`);
    if (waiting.length) stuff.push(`Waiting on a photo or price: ${list(waiting)}`);
    const pickups = await bookedPickups(store, move);
    if (pickups.length) stuff.push(`Pickups booked: ${list(pickups)}`);
    // Stuff → Home: the Move Report's headline, once anything has left the apartment.
    const report = moveReport(items, deals);
    if (report.lbDiverted > 0)
      stuff.push(
        `🌱 Move Report: about ${report.lbDiverted} lb kept off the curb, ${report.kgCo2eAvoided} kg CO2e avoided`,
      );
    if (stuff.length) sections.push(section("📦 Stuff", stuff));
  }

  // 💸 Money: the Money Elf's own Ledger line when it has one (read back from Nessie, so it only counts money that
  // actually moved after the owner's yes); otherwise what the Deal Engine has agreed so far.
  const moneyRow = (await store.getBoard(move.id)).find((r) => r.elf === "money");
  const ledgerLine = /^Ledger: (.+)$/.exec(moneyRow?.lastUpdate ?? "")?.[1];
  if (ledgerLine) sections.push(section("💸 Money", [ledgerLine]));
  else {
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
      sections.push(
        section("💸 Money", [
          `${usd(Math.max(0, held))} agreed, not in escrow yet${released > 0 ? `, ${usd(released)} handed off` : ""}`,
        ]),
      );
  }

  // ⏳ Anything waiting on the owner.
  const asks = (await pendingOwnerAsks(store, move.id)).map(({ deal, party }) =>
    party.slot
      ? `a ${policyFor(deal.mode).meetNoun} ${party.slot.label} for the ${deal.title}`
      : `a ${price(party.lastOfferCents, deal.unit)} offer on the ${deal.title}`,
  );
  if (asks.length)
    sections.push(
      section(
        "⏳ Waiting on your yes",
        asks.map((a) => `${cap(a)}: reply yes or no`),
      ),
    );

  return ["📋 STATUS", ...sections].join("\n\n");
}

/**
 * The Crew Lead's reminder as move-out gets close: null until the last week, then one line with the days left.
 * Sent with whatever the Crew Lead was going to say, never on its own.
 */
export function statusNudge(moveOutAt: string | null, now: Date): string | null {
  if (!moveOutAt) return null;
  const [y, m, d] = moveOutAt.split("-").map(Number);
  const moveOut = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((moveOut - today) / 86_400_000);
  if (days < 0 || days > 7) return null;
  const when =
    days === 0 ? "Move-out is today" : days === 1 ? "Move-out is tomorrow" : `${days} days to move-out`;
  return `${when}. ${STATUS_HINT}`;
}
