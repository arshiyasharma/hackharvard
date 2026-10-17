import type { Item, LastCallStage, Move, Store } from "@elves/shared";
import type { DealHooks } from "./deal-hooks.ts";
import { needsPickupDraft, pickupFor } from "./donate.ts";
import { fmtUsd } from "./intake.ts";
import { type Changed, openItems, recordOutcome } from "./stuff-actions.ts";

/**
 * Last Call: the automatic clean-out of whatever hasn't sold as move-out gets close, so it is given away or
 * donated instead of left on the curb. Anchored at 6 PM Boston time on the move-out date (T-0).
 *
 * | Stage   | When   | What                                                                                  |
 * | ------- | ------ | ------------------------------------------------------------------------------------- |
 * | dropped | T-48h  | ask = max(floor, 60% of list); owner told what's left and that it goes free tomorrow   |
 * | free    | T-24h  | relisted free unless kept; mattresses and anything over 60 lb get a drafted pickup     |
 * | closed  | T-0    | anything still without an outcome (and not kept) is marked dumped, so the report is honest |
 *
 * The floor holds while money is involved. Going free is the one step the owner doesn't explicitly approve; they
 * get a day's notice (or, when the move-out date is already that close, are told at once) and can reply "keep".
 * Stages only move forward, so running this twice is harmless; a late start catches up in one owner message.
 */
export const LAST_CALL_HOUR_ET = 18;
const STAGES: LastCallStage[] = ["dropped", "free", "closed"];
const HOURS_BEFORE: Record<LastCallStage, number> = { dropped: 48, free: 24, closed: 0 };

/** `YYYY-MM-DD` at `hour`:00 America/New_York, as an instant. */
export function bostonTime(date: string, hour: number): Date {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  let guess = Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, hour + 4); // EDT; corrected below for EST
  const shown = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date(guess)),
  );
  if (shown !== hour) guess += (hour - shown) * 3600_000;
  return new Date(guess);
}

/** The furthest stage due at `now`, or null when Last Call hasn't started. */
export function dueStage(moveOutAt: string, now: Date): LastCallStage | null {
  const t0 = bostonTime(moveOutAt, LAST_CALL_HOUR_ET).getTime();
  let due: LastCallStage | null = null;
  for (const s of STAGES) if (now.getTime() >= t0 - HOURS_BEFORE[s] * 3600_000) due = s;
  return due;
}

const rank = (s: LastCallStage | null) => (s == null ? -1 : STAGES.indexOf(s));

/** 60% of list, rounded to $5 (to $1 under $20), never under the floor. */
export function droppedAsk(listCents: number, floorCents: number | null): number {
  const usd = (listCents * 0.6) / 100;
  const rounded = usd >= 20 ? Math.round(usd / 5) * 5 : Math.max(1, Math.round(usd));
  return Math.max(rounded * 100, floorCents ?? 0);
}

export interface LastCallRun {
  /** The furthest stage reached this run, or null when nothing changed. */
  stage: LastCallStage | null;
  ownerText: string | null;
  events: Changed["events"];
}

/** Advance Last Call for one move to whatever stage is due. Idempotent. */
export async function runLastCall(
  store: Store,
  deals: DealHooks,
  move: Move,
  now: Date,
): Promise<LastCallRun> {
  const none: LastCallRun = { stage: null, ownerText: null, events: [] };
  if (!move.moveOutAt) return none;
  const due = dueStage(move.moveOutAt, now);
  if (!due) return none;

  const events: Changed["events"] = [];
  const dropped: { item: Item; from: number | null; to: number | null }[] = [];
  const freed: Item[] = [];
  const pickups: Item[] = [];
  const dumped: Item[] = [];
  const base = (i: Item) => ({ id: i.id, moveId: i.moveId, name: i.name, category: i.category });

  for (const start of openItems(await store.listItems(move.id))) {
    if (start.intent === "keep") continue;
    let item = start;
    if (rank(item.lastCallStage) < rank("dropped") && rank(due) >= rank("dropped")) {
      let to: number | null = null;
      if (item.intent === "sell" && item.listingApproved && item.listPriceCents) {
        to = droppedAsk(item.listPriceCents, item.floorPriceCents);
        if (to >= item.listPriceCents) to = null;
      }
      const from = item.listPriceCents;
      item = await store.upsertItem({
        ...base(item),
        lastCallStage: "dropped",
        ...(to != null ? { listPriceCents: to } : {}),
      });
      if (to != null) {
        await deals.priceChanged(item, "last_call_drop");
        events.push({
          type: "item.price_changed",
          payload: { itemId: item.id, name: item.name, from, listPriceCents: to, reason: "last_call_drop" },
        });
      }
      events.push({
        type: "last_call.stage",
        payload: { itemId: item.id, name: item.name, stage: "dropped" },
      });
      dropped.push({ item, from, to });
    }
    if (rank(item.lastCallStage) < rank("free") && rank(due) >= rank("free")) {
      if (item.intent === "donate") {
        item = await store.upsertItem({ ...base(item), lastCallStage: "free" });
        pickups.push(item);
      } else {
        const wasListed = item.listingApproved;
        item = await store.upsertItem({
          ...base(item),
          lastCallStage: "free",
          intent: "give",
          listPriceCents: 0,
          listingApproved: true,
        });
        if (wasListed) await deals.priceChanged(item, "free");
        else await deals.listingApproved(item);
        events.push({
          type: "item.price_changed",
          payload: { itemId: item.id, name: item.name, listPriceCents: 0, reason: "free" },
        });
        freed.push(item);
        if (needsPickupDraft(item.category, item.weightLb)) pickups.push(item);
      }
      events.push({ type: "last_call.stage", payload: { itemId: item.id, name: item.name, stage: "free" } });
    }
    if (rank(item.lastCallStage) < rank("closed") && due === "closed") {
      item = await store.upsertItem({ ...base(item), lastCallStage: "closed" });
      const res = await recordOutcome(store, item, "dumped", now, { reason: "last_call" });
      await deals.itemWithdrawn(res.item, "dumped");
      events.push(...res.events, {
        type: "last_call.stage",
        payload: { itemId: item.id, name: item.name, stage: "closed" },
      });
      dumped.push(res.item);
    }
  }

  if (!dropped.length && !freed.length && !pickups.length && !dumped.length) return none;
  // A late start can free and close an item in the same run: only tell the owner where it ended up.
  const closed = (i: Item) => dumped.some((d) => d.id === i.id);
  const text = ownerMessage(due, {
    dropped,
    freed: freed.filter((i) => !closed(i)),
    pickups: pickups.filter((i) => !closed(i)),
    dumped,
  });
  return { stage: due, ownerText: text, events };
}

const names = (items: Item[]) => {
  const n = items.map((i) => i.name);
  return n.length <= 2 ? n.join(" and ") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};

function ownerMessage(
  due: LastCallStage,
  c: {
    dropped: { item: Item; from: number | null; to: number | null }[];
    freed: Item[];
    pickups: Item[];
    dumped: Item[];
  },
): string {
  const lines: string[] = [];
  if (due === "dropped") {
    const priced = c.dropped.filter((d) => d.to != null && d.from != null);
    lines.push(
      `Last Call: 2 days to move-out and the ${names(c.dropped.map((d) => d.item))} ${c.dropped.length === 1 ? "hasn't" : "haven't"} sold.`,
    );
    if (priced.length)
      lines.push(
        `I dropped ${priced.map((d) => `the ${d.item.name} to ${fmtUsd(d.to ?? 0)}`).join(", ")} (never under your floor).`,
      );
    lines.push(
      `Tomorrow evening I'll list whatever's left for free. Reply "keep" and the item for anything you're taking.`,
    );
    return lines.join("\n");
  }
  if (c.freed.length)
    lines.push(
      `Last Call: the ${names(c.freed)} ${c.freed.length === 1 ? "is" : "are"} now free to whoever picks up first, so ${c.freed.length === 1 ? "it stays" : "they stay"} off the curb.`,
    );
  const drafts = c.pickups.map((i) => {
    const p = pickupFor(i.category, i.condition);
    return `${i.name}: ${p.org}, ${p.how}`;
  });
  if (drafts.length)
    lines.push(
      `If nobody claims ${c.pickups.length === 1 ? "it" : "them"}: ${drafts.join("; ")}. I haven't booked anything.`,
    );
  if (c.dumped.length)
    lines.push(
      `Move-out's here: the ${names(c.dumped)} didn't find a home, so ${c.dumped.length === 1 ? "it's" : "they're"} marked as dumped. Tell me if ${c.dumped.length === 1 ? "it" : "they"} actually got picked up and I'll fix the report.`,
    );
  else if (c.freed.length) lines.push(`Reply "keep" and the item for anything you're taking.`);
  return lines.join("\n");
}
